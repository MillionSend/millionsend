import { applyStatusCas, decryptEmailBody, type Keyring } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import { createTransport } from "nodemailer";

/**
 * Sends one queued email through SES. The SES client is injected (tests use
 * a fake); the job payload carries only the emailId — every fact about the
 * send is re-read from the database, never trusted from the payload.
 */

export interface SesSender {
  sendRaw(params: { raw: Buffer; configurationSetName?: string }): Promise<{ messageId: string }>;
}

export interface SendDeps {
  keyring: Keyring;
  ses: SesSender;
}

export type SendOutcome = "sent" | "skipped" | "failed";

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
  if (!email || email.latestStatus !== "queued") return "skipped";
  if (email.scheduledAt && email.scheduledAt.getTime() > Date.now()) return "skipped";

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
    cc: email.cc ?? undefined,
    bcc: email.bcc ?? undefined,
    replyTo: email.replyTo ?? undefined,
    subject: email.subject,
    html: body.html ?? undefined,
    text: body.text ?? undefined,
    headers: { "X-MillionSend-Email-ID": email.id },
  });

  const configurationSet = email.domainId
    ? (
        await db
          .select({ cs: schema.domains.sesConfigurationSet })
          .from(schema.domains)
          .where(eq(schema.domains.id, email.domainId))
      )[0]?.cs
    : undefined;

  const { messageId } = await deps.ses.sendRaw({
    raw: mime,
    ...(configurationSet ? { configurationSetName: configurationSet } : {}),
  });

  // Record the join key BEFORE the status flip: an SES event can arrive
  // within milliseconds and must find the row by sesMessageId.
  await db
    .update(schema.emails)
    .set({ sesMessageId: messageId, sentAt: new Date() })
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
