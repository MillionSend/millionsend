import { applyStatusCas, decryptEmailBody, type Keyring } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, isNull } from "drizzle-orm";
import { createTransport } from "nodemailer";

/**
 * Sends one queued email through SES. The SES client is injected (tests use
 * a fake); the job payload carries only the emailId — every fact about the
 * send is re-read from the database, never trusted from the payload.
 */

export interface SesSender {
  sendRaw(params: {
    raw: Buffer;
    configurationSetName?: string;
    /** SES region the sending identity is verified in; sender default when absent. */
    region?: string;
  }): Promise<{ messageId: string }>;
}

export interface SendDeps {
  keyring: Keyring;
  ses: SesSender;
  /** Deployment-wide SES configuration set, used when the domain has none. */
  defaultConfigurationSet?: string | undefined;
  /** Re-enqueue a not-yet-due scheduled email at its due time. */
  reschedule?: ((emailId: string, at: Date) => Promise<void>) | undefined;
}

export type SendOutcome = "sent" | "skipped" | "deferred" | "failed";

export async function sendEmail(
  db: Db,
  deps: SendDeps,
  payload: { emailId: string },
): Promise<SendOutcome> {
  const [email] = await db
    .select()
    .from(schema.emails)
    .where(eq(schema.emails.id, payload.emailId));
  // Only queued emails are sendable: quota-parked, already-sent, and failed
  // rows are skipped no matter how the job arrived.
  if (email?.latestStatus !== "queued") return "skipped";
  if (email.scheduledAt && email.scheduledAt.getTime() > Date.now()) {
    // Returning without re-enqueueing would ack the job and strand the
    // email forever; hand it back to the queue for its due time.
    await deps.reschedule?.(email.id, email.scheduledAt);
    return "deferred";
  }

  const { bodyCiphertext, bodyIv, bodyWrappedDek, bodyKeyVersion } = email;
  if (!bodyCiphertext || !bodyIv || !bodyWrappedDek || bodyKeyVersion === null) {
    await applyStatusCas(db, email.id, "failed");
    return "failed";
  }
  const body = await decryptEmailBody(
    {
      ciphertext: bodyCiphertext,
      iv: bodyIv,
      wrappedDek: bodyWrappedDek,
      keyVersion: bodyKeyVersion,
    },
    deps.keyring,
  );

  const mime = await buildRawMime({
    from: email.from,
    to: email.to,
    ...(email.cc ? { cc: email.cc } : {}),
    ...(email.bcc ? { bcc: email.bcc } : {}),
    ...(email.replyTo ? { replyTo: email.replyTo } : {}),
    subject: email.subject,
    ...(body.html ? { html: body.html } : {}),
    ...(body.text ? { text: body.text } : {}),
    headers: { "X-MillionSend-Email-ID": email.id },
  });

  // SES identities are verified per region: the send must target the
  // domain's region, not a single deployment-wide one.
  const domain = email.domainId
    ? (
        await db
          .select({
            sesConfigurationSet: schema.domains.sesConfigurationSet,
            region: schema.domains.region,
          })
          .from(schema.domains)
          .where(eq(schema.domains.id, email.domainId))
      )[0]
    : undefined;
  const configurationSet = domain?.sesConfigurationSet ?? deps.defaultConfigurationSet;

  // Atomic claim (sentAt doubles as the claim marker): closes the
  // double-send windows — a concurrent worker on the same job, and a retry
  // after SES accepted but the post-send bookkeeping failed. Claimed rows
  // are simply skipped on the next attempt.
  const claimed = await db
    .update(schema.emails)
    .set({ sentAt: new Date() })
    .where(
      and(
        eq(schema.emails.id, email.id),
        eq(schema.emails.latestStatus, "queued"),
        isNull(schema.emails.sentAt),
      ),
    )
    .returning({ id: schema.emails.id });
  if (claimed.length === 0) return "skipped";

  let messageId: string;
  try {
    ({ messageId } = await deps.ses.sendRaw({
      raw: mime,
      ...(configurationSet ? { configurationSetName: configurationSet } : {}),
      ...(domain?.region ? { region: domain.region } : {}),
    }));
  } catch (err) {
    // sendRaw threw ⇒ the SDK exhausted its own retries without an accept:
    // release the claim so the job retry can send. (After a SUCCESSFUL
    // sendRaw the claim is never released — a bookkeeping failure then
    // leaves the row claimed rather than risking a duplicate delivery.)
    await db
      .update(schema.emails)
      .set({ sentAt: null })
      .where(and(eq(schema.emails.id, email.id), eq(schema.emails.latestStatus, "queued")));
    throw err;
  }

  // Record the join key BEFORE the status flip: an SES event can arrive
  // within milliseconds and must find the row by sesMessageId.
  await db
    .update(schema.emails)
    .set({ sesMessageId: messageId })
    .where(eq(schema.emails.id, email.id));
  await applyStatusCas(db, email.id, "sent");
  await db.insert(schema.emailEvents).values({
    emailId: email.id,
    type: "sent",
    occurredAt: new Date(),
    data: { source: "worker" },
  });
  return "sent";
}

interface MimeInput {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string[];
  subject: string;
  html?: string;
  text?: string;
  headers: Record<string, string>;
}

async function buildRawMime(input: MimeInput): Promise<Buffer> {
  const transport = createTransport({ streamTransport: true, buffer: true });
  const info = await transport.sendMail({
    from: input.from,
    to: input.to,
    ...(input.cc ? { cc: input.cc } : {}),
    ...(input.bcc ? { bcc: input.bcc } : {}),
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    subject: input.subject,
    ...(input.html ? { html: input.html } : {}),
    ...(input.text ? { text: input.text } : {}),
    headers: input.headers,
  });
  return info.message as Buffer;
}

/**
 * Token bucket pinned to the account's SES send rate — the real
 * messages-per-second control (worker concurrency is NOT a rate limit;
 * that was useSend's bug).
 */
export function createTokenBucket(ratePerSecond: number): () => Promise<void> {
  let tokens = ratePerSecond;
  let lastRefill = Date.now();
  return async function take(): Promise<void> {
    for (;;) {
      const now = Date.now();
      tokens = Math.min(ratePerSecond, tokens + ((now - lastRefill) / 1000) * ratePerSecond);
      lastRefill = now;
      if (tokens >= 1) {
        tokens -= 1;
        return;
      }
      await new Promise((r) => setTimeout(r, Math.ceil(((1 - tokens) / ratePerSecond) * 1000)));
    }
  };
}
