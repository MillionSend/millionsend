import {
  applyStatusCas,
  buildUnsubscribeHeaders,
  buildUnsubscribeUrl,
  decryptEmailBody,
  enqueueWebhookDeliveries,
  findSuppressed,
  hashRecipient,
  isSubscribedToTopic,
  type Keyring,
  makeUnsubscribeToken,
  rewriteForTracking,
  utcDay,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { createTransport } from "nodemailer";

/**
 * Sends one queued email through SES. The SES client is injected (tests use
 * a fake); the job payload carries only the emailId — every fact about the
 * send is re-read from the database, never trusted from the payload.
 */

export interface SesSender {
  sendRaw(params: {
    raw: Buffer;
    /** Server-owned fallback join key copied into an SES message tag. */
    emailId: string;
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
  /** Enqueue a webhook.deliver job; email.sent webhooks are skipped when absent. */
  enqueueWebhookDelivery?: ((deliveryId: string) => Promise<void>) | undefined;
  /**
   * RFC 8058 one-click unsubscribe config for broadcast emails. Broadcast
   * rows (contactId set) REFUSE to send without it — a marketing email must
   * never go out missing List-Unsubscribe headers.
   */
  unsubscribe?: { secretKey: Buffer; baseUrl: string } | undefined;
  /**
   * App-layer engagement tracking. secretKey signs the click/open tokens
   * (HKDF-derived from the master key); defaultBaseUrl is the tracking host
   * for domains without a custom tracking subdomain (env.APP_BASE_URL). The
   * whole dep is optional so tests that don't exercise tracking need not wire
   * it — the worker always provides it, since the master key is always present.
   */
  tracking?: { secretKey: Buffer; defaultBaseUrl?: string | undefined } | undefined;
}

export type SendOutcome = "sent" | "skipped" | "deferred" | "suppressed" | "failed";

interface SendEligibility {
  eligible: boolean;
  topicId: string | null;
  reason?: string;
}

async function checkSendEligibility(
  db: Db,
  email: typeof schema.emails.$inferSelect,
): Promise<SendEligibility> {
  if (!email.contactId) return { eligible: true, topicId: null };

  const [contact] = await db
    .select({ email: schema.contacts.email, unsubscribed: schema.contacts.unsubscribed })
    .from(schema.contacts)
    .where(and(eq(schema.contacts.id, email.contactId), eq(schema.contacts.teamId, email.teamId)))
    .limit(1);
  if (!contact) return { eligible: false, topicId: null, reason: "contact_missing" };
  if (contact.unsubscribed) {
    return { eligible: false, topicId: null, reason: "contact_unsubscribed" };
  }
  if (email.to.length !== 1 || hashRecipient(email.to[0] ?? "") !== hashRecipient(contact.email)) {
    return { eligible: false, topicId: null, reason: "contact_recipient_mismatch" };
  }
  if ((await findSuppressed(db, email.teamId, email.to)).size > 0) {
    return { eligible: false, topicId: null, reason: "recipient_suppressed" };
  }

  if (!email.broadcastId) return { eligible: true, topicId: null };
  const [broadcast] = await db
    .select({ topicId: schema.broadcasts.topicId })
    .from(schema.broadcasts)
    .where(
      and(eq(schema.broadcasts.id, email.broadcastId), eq(schema.broadcasts.teamId, email.teamId)),
    )
    .limit(1);
  if (!broadcast) return { eligible: false, topicId: null, reason: "broadcast_missing" };
  if (!broadcast.topicId) return { eligible: true, topicId: null };

  const [topic] = await db
    .select({ defaultSubscribed: schema.topics.defaultSubscribed })
    .from(schema.topics)
    .where(and(eq(schema.topics.id, broadcast.topicId), eq(schema.topics.teamId, email.teamId)))
    .limit(1);
  if (!topic) return { eligible: false, topicId: broadcast.topicId, reason: "topic_missing" };
  const [override] = await db
    .select({ subscribed: schema.contactTopicSubscriptions.subscribed })
    .from(schema.contactTopicSubscriptions)
    .where(
      and(
        eq(schema.contactTopicSubscriptions.contactId, email.contactId),
        eq(schema.contactTopicSubscriptions.topicId, broadcast.topicId),
      ),
    )
    .limit(1);
  if (!isSubscribedToTopic(override?.subscribed, topic.defaultSubscribed)) {
    return { eligible: false, topicId: broadcast.topicId, reason: "topic_unsubscribed" };
  }
  return { eligible: true, topicId: broadcast.topicId };
}

async function suppressQueuedEmail(db: Db, emailId: string, reason: string): Promise<boolean> {
  const [updated] = await db
    .update(schema.emails)
    .set({ latestStatus: "suppressed" })
    .where(
      and(
        eq(schema.emails.id, emailId),
        eq(schema.emails.latestStatus, "queued"),
        isNull(schema.emails.sentAt),
      ),
    )
    .returning({ id: schema.emails.id });
  if (!updated) return false;
  await db.insert(schema.emailEvents).values({
    emailId,
    type: "suppressed",
    occurredAt: new Date(),
    data: { source: "worker", reason },
  });
  return true;
}

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

  let eligibility = await checkSendEligibility(db, email);
  if (!eligibility.eligible) {
    return (await suppressQueuedEmail(db, email.id, eligibility.reason ?? "ineligible"))
      ? "suppressed"
      : "skipped";
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

  // SES identities are verified per region: the send must target the
  // domain's region, not a single deployment-wide one. The name also seeds
  // the broadcast List-Id below, so it is loaded here before header assembly.
  const domain = email.domainId
    ? (
        await db
          .select({
            name: schema.domains.name,
            status: schema.domains.status,
            sesConfigurationSet: schema.domains.sesConfigurationSet,
            region: schema.domains.region,
            clickTracking: schema.domains.clickTracking,
            openTracking: schema.domains.openTracking,
            trackingSubdomain: schema.domains.trackingSubdomain,
          })
          .from(schema.domains)
          .where(
            and(eq(schema.domains.id, email.domainId), eq(schema.domains.teamId, email.teamId)),
          )
      )[0]
    : undefined;
  if (domain?.status !== "verified") {
    throw new Error(`email ${email.id}: sending domain is not currently verified`);
  }
  const configurationSet = domain.sesConfigurationSet ?? deps.defaultConfigurationSet;

  // App-layer engagement tracking: when the domain has click or open tracking
  // on, WE rewrite links through our redirect endpoint and inject our pixel
  // before the MIME is built — SES never touches the body. Both off ships the
  // raw links and no pixel (clean-links requirement).
  const click = domain?.clickTracking ?? false;
  const open = domain?.openTracking ?? false;
  let html = body.html;
  // deps.tracking is always present in the running worker (the master key is
  // always available to derive the signing key); it is optional only so tests
  // that don't exercise tracking need not wire it, and its absence simply
  // leaves the body untouched.
  if (html && (click || open) && deps.tracking) {
    const trackingBaseUrl = domain?.trackingSubdomain
      ? `https://${domain.trackingSubdomain}.${domain.name}`
      : deps.tracking.defaultBaseUrl;
    // A custom subdomain is self-sufficient; without one the redirect host is
    // APP_BASE_URL. Missing it would ship links pointing nowhere, so fail loud.
    if (!trackingBaseUrl) {
      throw new Error(
        `tracking is enabled for email ${email.id} but APP_BASE_URL is unset and the domain has no tracking subdomain`,
      );
    }
    // A broadcast's in-body unsubscribe link is already expanded to its real
    // URL before encryption, so click tracking must skip it — wrapping the
    // visible Unsubscribe link through /t/c would log a bogus click.
    const skipHrefPrefix =
      email.contactId && deps.unsubscribe
        ? buildUnsubscribeUrl(deps.unsubscribe.baseUrl, "")
        : undefined;
    html = rewriteForTracking(html, {
      emailId: email.id,
      trackingBaseUrl,
      click,
      open,
      secretKey: deps.tracking.secretKey,
      ...(skipHrefPrefix ? { skipHrefPrefix } : {}),
    });
  }

  const headers: Record<string, string> = { "X-MillionSend-Email-ID": email.id };
  if (email.contactId) {
    if (!deps.unsubscribe) {
      // Throwing (before the claim) keeps the email queued and the job
      // retrying loudly rather than sending without unsubscribe headers.
      throw new Error(`email ${email.id} is a broadcast send but unsubscribe is not configured`);
    }
    Object.assign(
      headers,
      buildUnsubscribeHeaders(
        deps.unsubscribe.baseUrl,
        makeUnsubscribeToken({
          contactId: email.contactId,
          topicId: eligibility.topicId,
          secretKey: deps.unsubscribe.secretKey,
        }),
      ),
    );
  }
  // Bulk-mail class signals (RFC 2919 List-Id, RFC 3834 Auto-Submitted, and
  // Precedence) so mailbox providers file broadcasts as list mail. Only for
  // broadcast rows — transactional sends must not carry them.
  if (email.broadcastId && email.contactId) {
    if (domain?.name) headers["List-Id"] = `<${email.broadcastId}.${domain.name}>`;
    headers.Precedence = "bulk";
    headers["Auto-Submitted"] = "auto-generated";
  }

  const mime = await buildRawMime({
    from: email.from,
    to: email.to,
    ...(email.cc ? { cc: email.cc } : {}),
    ...(email.bcc ? { bcc: email.bcc } : {}),
    ...(email.replyTo ? { replyTo: email.replyTo } : {}),
    subject: email.subject,
    ...(html ? { html } : {}),
    ...(body.text ? { text: body.text } : {}),
    headers,
  });

  // Re-check immediately before the atomic claim: quota delays and throttling
  // can leave a row queued long enough for a recipient to opt out after the
  // broadcast fan-out first selected them.
  eligibility = await checkSendEligibility(db, email);
  if (!eligibility.eligible) {
    return (await suppressQueuedEmail(db, email.id, eligibility.reason ?? "ineligible"))
      ? "suppressed"
      : "skipped";
  }

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
      emailId: email.id,
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
  const counter = schema.usageCounters;
  await db
    .insert(counter)
    .values({ teamId: email.teamId, day: utcDay(Date.now()), sent: 1 })
    .onConflictDoUpdate({
      target: [counter.teamId, counter.day],
      set: { sent: sql`${counter.sent} + 1` },
    });
  // The sentAt claim above makes this path single-shot per email, so the
  // email.sent fan-out cannot double-fire on a job retry.
  if (deps.enqueueWebhookDelivery) {
    await enqueueWebhookDeliveries(db, {
      teamId: email.teamId,
      email: { emailId: email.id, from: email.from, to: email.to, subject: email.subject },
      type: "email.sent",
      occurredAt: new Date(),
      enqueue: deps.enqueueWebhookDelivery,
    });
  }
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

export interface TokenBucket {
  take(): Promise<void>;
  /** Applies from the next refill; accumulated tokens are clamped to the new rate. */
  setRate(ratePerSecond: number): void;
}

/**
 * Token bucket pinned to the account's SES send rate — the real
 * messages-per-second control (worker concurrency is NOT a rate limit;
 * that was useSend's bug). In-memory, so the single-process assumption
 * holds: N worker replicas would send at N × the configured rate.
 */
export function createTokenBucket(ratePerSecond: number): TokenBucket {
  let rate = ratePerSecond;
  let tokens = rate;
  let lastRefill = Date.now();
  return {
    setRate(next: number): void {
      rate = next;
    },
    async take(): Promise<void> {
      for (;;) {
        const now = Date.now();
        tokens = Math.min(rate, tokens + ((now - lastRefill) / 1000) * rate);
        lastRefill = now;
        if (tokens >= 1) {
          tokens -= 1;
          return;
        }
        await new Promise((r) => setTimeout(r, Math.ceil(((1 - tokens) / rate) * 1000)));
      }
    },
  };
}
