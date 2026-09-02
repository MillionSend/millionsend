import {
  applyStatusCas,
  buildUnsubscribeHeaders,
  buildUnsubscribeUrl,
  decryptEmailBody,
  type EmailAttachment,
  type EmailBody,
  enqueueWebhookDeliveries,
  evaluateEmailInsights,
  extractAddrSpec,
  findSuppressed,
  hashRecipient,
  isSubscribedToTopic,
  type Keyring,
  makeUnsubscribeToken,
  openAttachments,
  parseSingleSender,
  rewriteForTracking,
  SCORE_VERSION,
  substituteUnsubscribeUrl,
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
    /**
     * Envelope recipients from the stored, validated fields — the sender
     * derives the SES Destination from these, never from the MIME headers.
     */
    to: string[];
    cc?: string[] | null;
    bcc?: string[] | null;
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
  /**
   * Awaited right before the send claim, after every check that can still
   * skip or fail the email — a token spent on a row that never reaches SES
   * is send capacity stolen from every other tenant.
   */
  throttle?: (() => Promise<void>) | undefined;
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
  tracking?:
    | {
        secretKey: Buffer;
        defaultBaseUrl?: string | undefined;
        /**
         * Whether a domain's branded tracking subdomain may serve as the
         * tracking origin. Omitted means yes (self-host). False routes every
         * tracked link through defaultBaseUrl instead, so a subdomain stored
         * while the feature was available cannot keep shipping links to a
         * host this deployment has no certificate for.
         */
        allowSubdomains?: boolean | undefined;
        /**
         * A tracking host shared by every tenant is what ad blockers and
         * spam filters learn to block (SES's own awstrack.me sits on the
         * popular blocklists), and its reputation bleeds across tenants.
         * True: a domain without its own subdomain ships clean links instead
         * of falling back to defaultBaseUrl.
         */
        requireBrandedHost?: boolean | undefined;
      }
    | undefined;
}

export type SendOutcome = "sent" | "skipped" | "deferred" | "suppressed" | "failed";

interface SendEligibility {
  eligible: boolean;
  topicId: string | null;
  reason?: string;
  /** Recipients suppressed since accept; the send drops them (accept-time strip semantics). */
  strip?: Set<string>;
}

async function checkSendEligibility(
  db: Db,
  email: typeof schema.emails.$inferSelect,
): Promise<SendEligibility> {
  if (!email.contactId) {
    // Bounces and complaints recorded after accept (a scheduled or
    // quota-parked row can wait days) are honored the way accept does:
    // strip the hit, refuse only when no primary recipient is left.
    const recipients = [...email.to, ...(email.cc ?? []), ...(email.bcc ?? [])];
    const suppressed = await findSuppressed(db, email.teamId, recipients);
    if (suppressed.size === 0) return { eligible: true, topicId: null };
    if (email.to.every((r) => suppressed.has(r))) {
      return { eligible: false, topicId: null, reason: "recipient_suppressed" };
    }
    return { eligible: true, topicId: null, strip: suppressed };
  }

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

/** Drops suppressed recipients from the row (and the in-memory copy the MIME is built from). */
async function stripRecipients(
  db: Db,
  email: typeof schema.emails.$inferSelect,
  suppressed: Set<string>,
): Promise<void> {
  const keep = (list: string[]): string[] => list.filter((r) => !suppressed.has(r));
  email.to = keep(email.to);
  email.cc = email.cc && keep(email.cc);
  email.bcc = email.bcc && keep(email.bcc);
  await db
    .update(schema.emails)
    .set({ to: email.to, cc: email.cc, bcc: email.bcc })
    .where(and(eq(schema.emails.id, email.id), eq(schema.emails.latestStatus, "queued")));
}

/**
 * Terminal failure for a still-queued email: releases any send claim, moves
 * the row to "failed" and records why. Returns false when the row already
 * left "queued" (sent, canceled, suppressed) — nothing to fail then.
 */
export async function failQueuedEmail(db: Db, emailId: string, reason: string): Promise<boolean> {
  const [updated] = await db
    .update(schema.emails)
    .set({ latestStatus: "failed", sentAt: null })
    .where(and(eq(schema.emails.id, emailId), eq(schema.emails.latestStatus, "queued")))
    .returning({ id: schema.emails.id });
  if (!updated) return false;
  await db.insert(schema.emailEvents).values({
    emailId,
    type: "failed",
    occurredAt: new Date(),
    data: { source: "worker", reason },
  });
  return true;
}

/**
 * SES errors that no retry can fix: the message itself (MessageRejected,
 * BadRequest) or the sending identity/account is refused. Throttling,
 * SendingPaused and 5xx stay retryable.
 */
const TERMINAL_SES_ERRORS = new Set([
  "MessageRejected",
  "MailFromDomainNotVerifiedException",
  "AccountSuspendedException",
  "BadRequestException",
]);

/**
 * Whether an error came from infrastructure that may recover (a KMS/network
 * hiccup) rather than from the data itself. Envelope decrypt raises plain
 * Errors for a corrupt blob or unknown key version — those never heal and
 * retrying only burns KMS calls.
 */
function isTransientError(err: unknown): boolean {
  const e = err as {
    name?: string;
    syscall?: string;
    $fault?: string;
    $retryable?: unknown;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    e.$fault === "server" ||
    e.$retryable !== undefined ||
    (e.$metadata?.httpStatusCode ?? 0) >= 500 ||
    typeof e.syscall === "string" ||
    e.name === "TimeoutError" ||
    e.name === "AbortError"
  );
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
  if (eligibility.strip) await stripRecipients(db, email, eligibility.strip);

  // SES identities are verified per region: the send must target the
  // domain's region, not a single deployment-wide one. The name also seeds
  // the broadcast List-Id below, so it is loaded here before header assembly.
  // Checked before the body decrypt: an unsendable row must not cost a KMS
  // call on every attempt.
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
            trackingSubdomainSetAt: schema.domains.trackingSubdomainSetAt,
            dmarcPolicy: schema.domains.dmarcPolicy,
            dmarcCheckedAt: schema.domains.dmarcCheckedAt,
          })
          .from(schema.domains)
          .where(
            and(eq(schema.domains.id, email.domainId), eq(schema.domains.teamId, email.teamId)),
          )
      )[0]
    : undefined;
  if (domain?.status !== "verified") {
    // Terminal, not retried: a domain demoted or deleted after accept does
    // not come back on its own, and the row would otherwise ride the retry
    // and reconcile loops until its body is purged.
    await failQueuedEmail(db, email.id, "domain_not_verified");
    return "failed";
  }
  const configurationSet = domain.sesConfigurationSet ?? deps.defaultConfigurationSet;

  const { bodyCiphertext, bodyIv, bodyWrappedDek, bodyKeyVersion } = email;
  if (!bodyCiphertext || !bodyIv || !bodyWrappedDek || bodyKeyVersion === null) {
    await failQueuedEmail(db, email.id, "body_missing");
    return "failed";
  }
  let body: EmailBody;
  let attachments: EmailAttachment[] | null;
  const owner = { teamId: email.teamId, rowId: email.id };
  try {
    body = await decryptEmailBody(
      {
        ciphertext: bodyCiphertext,
        iv: bodyIv,
        wrappedDek: bodyWrappedDek,
        keyVersion: bodyKeyVersion,
      },
      deps.keyring,
      owner,
    );
    // Sealed alongside the body columns, on the same terminal/transient split.
    attachments = email.attachments
      ? await openAttachments(email.attachments, deps.keyring, owner)
      : null;
  } catch (err) {
    if (isTransientError(err)) throw err;
    await failQueuedEmail(db, email.id, "body_unreadable");
    return "failed";
  }

  // App-layer engagement tracking: when the domain has click or open tracking
  // on, WE rewrite links through our redirect endpoint and inject our pixel
  // before the MIME is built — SES never touches the body. Both off ships the
  // raw links and no pixel (clean-links requirement).
  const click = domain?.clickTracking ?? false;
  const open = domain?.openTracking ?? false;
  let html = body.html;
  let text = body.text;

  // Transactional topic send (topicId without contactId): the unsubscribe
  // token signs a contactId, so it exists only when the primary recipient
  // resolves to a contact by (team, lower(addr-spec)). Substitution runs
  // before the tracking rewrite so the expanded link can be skipped by it.
  let topicUnsubscribeToken: string | null = null;
  if (email.topicId && !email.contactId && deps.unsubscribe) {
    const addr = extractAddrSpec(email.to[0] ?? "").toLowerCase();
    const [contact] = await db
      .select({ id: schema.contacts.id })
      .from(schema.contacts)
      .where(
        and(
          eq(schema.contacts.teamId, email.teamId),
          sql`lower(${schema.contacts.email}) = ${addr}`,
        ),
      )
      .limit(1);
    if (contact) {
      topicUnsubscribeToken = makeUnsubscribeToken({
        contactId: contact.id,
        topicId: email.topicId,
        secretKey: deps.unsubscribe.secretKey,
      });
    }
  }
  if (email.topicId) {
    // No token (non-contact recipient, or unsubscribe unconfigured) → the
    // placeholders are stripped; a literal token must never reach an inbox.
    const url =
      topicUnsubscribeToken && deps.unsubscribe
        ? buildUnsubscribeUrl(deps.unsubscribe.baseUrl, topicUnsubscribeToken)
        : "";
    if (html) html = substituteUnsubscribeUrl(html, url);
    if (text) text = substituteUnsubscribeUrl(text, url);
  }
  // Captured before the tracking rewrite: insights link analysis needs the
  // hrefs the recipient actually resolves, not our wrapper URLs.
  const preTrackingHtml = html;
  let brandedHostUsed = false;
  let sharedFallbackUsed = false;
  let shippedUntracked = false;
  // deps.tracking is always present in the running worker (the master key is
  // always available to derive the signing key); it is optional only so tests
  // that don't exercise tracking need not wire it, and its absence simply
  // leaves the body untouched.
  if (html && (click || open) && deps.tracking) {
    // A subdomain whose CNAME has not resolved yet (its 72h clock still armed)
    // would rewrite every link to a dead host, so until a DNS check or the
    // reverify sweep clears the clock the domain counts as having none.
    const brandedHost =
      domain?.trackingSubdomain &&
      !domain.trackingSubdomainSetAt &&
      deps.tracking.allowSubdomains !== false
        ? `https://${domain.trackingSubdomain}.${domain.name}`
        : null;
    const trackingBaseUrl =
      brandedHost ?? (deps.tracking.requireBrandedHost ? null : deps.tracking.defaultBaseUrl);
    brandedHostUsed = brandedHost !== null;
    sharedFallbackUsed = brandedHost === null && trackingBaseUrl != null;
    shippedUntracked = !trackingBaseUrl;
    // A custom subdomain is self-sufficient; without one the redirect host is
    // APP_BASE_URL. Missing it would ship links pointing nowhere, so fail loud
    // — except under requireBrandedHost, where untracked is the intended
    // outcome, not an error.
    if (!trackingBaseUrl && !deps.tracking.requireBrandedHost) {
      throw new Error(
        `tracking is enabled for email ${email.id} but APP_BASE_URL is unset and the domain has no tracking subdomain`,
      );
    }
    if (trackingBaseUrl) {
      // A broadcast's (or topic send's) in-body unsubscribe link is already
      // expanded to its real URL by now, so click tracking must skip it —
      // wrapping the visible Unsubscribe link through /t/c would log a bogus
      // click.
      const skipHrefPrefix =
        (email.contactId || email.topicId) && deps.unsubscribe
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
  }

  // Caller-supplied headers first: every transport-owned header assigned
  // below wins on collision (reserved names are also rejected at accept —
  // defense in depth).
  const headers: Record<string, string> = {
    ...email.headers,
    "X-MillionSend-Email-ID": email.id,
  };
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
  } else if (topicUnsubscribeToken && deps.unsubscribe) {
    // Topic sends carry the same RFC 8058 one-click headers as broadcasts so
    // the recipient can opt out of the topic without a global unsubscribe.
    Object.assign(
      headers,
      buildUnsubscribeHeaders(deps.unsubscribe.baseUrl, topicUnsubscribeToken),
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
    ...(text ? { text } : {}),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
    headers,
  });

  // The rate-limit wait comes before the final re-check so that check stays
  // immediately ahead of the claim.
  await deps.throttle?.();

  // Re-check immediately before the atomic claim: quota delays and throttling
  // can leave a row queued long enough for a recipient to opt out after the
  // broadcast fan-out first selected them. A recipient suppressed in the
  // meantime invalidates the MIME already built, so the row is stripped and
  // handed straight back to the queue.
  eligibility = await checkSendEligibility(db, email);
  if (!eligibility.eligible) {
    return (await suppressQueuedEmail(db, email.id, eligibility.reason ?? "ineligible"))
      ? "suppressed"
      : "skipped";
  }
  if (eligibility.strip) {
    await stripRecipients(db, email, eligibility.strip);
    await deps.reschedule?.(email.id, new Date());
    return "deferred";
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
      to: email.to,
      cc: email.cc,
      bcc: email.bcc,
      ...(configurationSet ? { configurationSetName: configurationSet } : {}),
      ...(domain?.region ? { region: domain.region } : {}),
    }));
  } catch (err) {
    // sendRaw threw ⇒ the SDK exhausted its own retries without an accept.
    // A permanent refusal ends the email here; anything else releases the
    // claim so the job retry can send. (After a SUCCESSFUL sendRaw the claim
    // is never released — a bookkeeping failure then leaves the row claimed
    // rather than risking a duplicate delivery.)
    const name = (err as { name?: string }).name ?? "";
    if (TERMINAL_SES_ERRORS.has(name)) {
      await failQueuedEmail(db, email.id, `ses_${name}`);
      return "failed";
    }
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
  // Insights are best-effort bookkeeping on an already-accepted send: a bug
  // here must never fail (and so retry) the delivery.
  try {
    // Broadcast fan-out shares ONE broadcastId-keyed row, so after the first
    // completed send one indexed point-read here replaces a full engine run
    // (several whole-body regex passes) plus a no-op insert per recipient.
    // Concurrent first sends still race harmlessly into onConflictDoNothing.
    const [existing] = email.broadcastId
      ? await db
          .select({ id: schema.emailInsights.id })
          .from(schema.emailInsights)
          .where(eq(schema.emailInsights.broadcastId, email.broadcastId))
          .limit(1)
      : [];
    if (!existing) {
      const insights = evaluateEmailInsights({
        html,
        preTrackingHtml,
        text,
        from: email.from,
        senderDomain: parseSingleSender(email.from)?.domain ?? "",
        subject: email.subject,
        finalHeaders: headers,
        hasAttachments: attachments !== null && attachments.length > 0,
        replyTo: email.replyTo,
        isBroadcast: email.contactId !== null || email.broadcastId !== null,
        hasTopic: email.topicId !== null,
        tracking: {
          clickEnabled: click,
          openEnabled: open,
          brandedHostUsed,
          sharedFallbackUsed,
          shippedUntracked,
        },
        domainSnapshot: { dmarcPolicy: domain.dmarcPolicy, dmarcCheckedAt: domain.dmarcCheckedAt },
        now: new Date(),
      });
      const bodySize = insights.checks.find((c) => c.id === "body_size")?.detail?.htmlSizeBytes;
      // Broadcast fan-out shares ONE row (content identical modulo the
      // unsubscribe token): the first completed send writes it, the rest —
      // and the reconcile re-send path on the emailId key — conflict-skip.
      await db
        .insert(schema.emailInsights)
        .values({
          teamId: email.teamId,
          ...(email.broadcastId ? { broadcastId: email.broadcastId } : { emailId: email.id }),
          marketing: insights.marketing,
          checks: insights.checks as schema.EmailInsightCheck[],
          scoreTenths: insights.scoreTenths,
          scoreVersion: SCORE_VERSION,
          htmlSizeBytes: typeof bodySize === "number" ? bodySize : null,
          mimeSizeBytes: mime.length,
        })
        .onConflictDoNothing({
          target: email.broadcastId
            ? schema.emailInsights.broadcastId
            : schema.emailInsights.emailId,
        });
    }
  } catch (err) {
    console.error(`email.send: insights failed for ${email.id}`, err);
  }
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
  attachments?: EmailAttachment[];
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
    ...(input.attachments
      ? {
          attachments: input.attachments.map((a) => ({
            filename: a.filename,
            content: a.content,
            encoding: "base64" as const,
            ...(a.contentType ? { contentType: a.contentType } : {}),
          })),
        }
      : {}),
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
