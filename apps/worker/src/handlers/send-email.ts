import { sharedInboxDomain } from "@millionsend/config";
import {
  applyStatusCas,
  buildUnsubscribeHeaders,
  buildUnsubscribeUrl,
  bumpHourlyUsage,
  CREDENTIAL_MAIL_KINDS,
  countDistinctRecipients,
  decryptEmailBody,
  deliverabilityHold,
  type EmailAttachment,
  type EmailBody,
  endQueuedEmails,
  enqueueWebhookDeliveries,
  evaluateEmailInsights,
  extractAddrSpec,
  fetchTeamQuota,
  fetchTeamStanding,
  findSuppressed,
  findTopicOptOuts,
  hashRecipient,
  isOnboardingSender,
  isSharedInboxSender,
  isSubscribedToTopic,
  judgeAfterSend,
  type Keyring,
  linkTeam,
  MONITOR_ANOMALY_CHECKS,
  type MonitorDeps,
  type MonitorSettings,
  makeUnsubscribeToken,
  noteAcceptedSend,
  noteConsoleCodeUndelivered,
  opaqueFacts,
  openAttachments,
  parseSingleSender,
  purgedEmailBodyColumns,
  recordMonitorSample,
  releaseQuota,
  rewriteForTracking,
  SCORE_VERSION,
  type SendMedia,
  SHARED_PAUSED_RETRY_MS,
  SYSTEM_MAIL_TAG,
  sampleAcceptedEmail,
  screenBeforeSend,
  screeningTeam,
  sentContentType,
  sentWithoutComplaintFeedback,
  substituteUnsubscribeUrl,
  transitionQueueState,
  utcDay,
  type WebhookEnqueue,
  webhookBatch,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { type EmailSendPriority, emailSendPriority } from "@millionsend/queue";
import { and, eq, isNull, sql } from "drizzle-orm";
import { createTransport } from "nodemailer";
import { MediaPoolError } from "../media/pool.js";
import { saveMediaReview } from "../media/read.js";
import { type MediaDeps, scanAttachments, scanReview } from "../media/scan.js";
import { isSesQuotaRefusal, isSesThrottle, type SendQuotaControls } from "./ses-quota.js";
import { clearSharedTenant, isTenantNotAssociated } from "./tenants.js";

/**
 * Sends one queued email through SES. The SES client is injected (tests use
 * a fake); the job payload carries only the emailId — every fact about the
 * send is re-read from the database, never trusted from the payload.
 */

export interface SesSender {
  /**
   * Rejects with an AbortError when its deadline passes before SES answers:
   * SES may still have taken the message.
   */
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
    /** The team's SES tenant; only set once the send's identity and set are associated with it. */
    tenantName?: string;
  }): Promise<{ messageId: string }>;
}

export interface SendDeps {
  keyring: Keyring;
  ses: SesSender;
  /** Deployment-wide SES configuration set, used when the domain has none. */
  defaultConfigurationSet?: string | undefined;
  /** ONBOARDING_EMAIL_FROM: the fixed onboarding email carries no team domain (see core isOnboardingSender). */
  onboardingEmailFrom?: string | undefined;
  /** SHARED_INBOX_DOMAIN, whose inbox replies carry no team domain either; the environment's when absent. */
  sharedInboxDomain?: string | null | undefined;
  /** The instance settings reader: every shared-domain send reads the shared switches. Defaults when absent. */
  settings?: (() => Promise<MonitorSettings>) | undefined;
  /**
   * The team's SES tenant for a shared-domain send, associated on first use;
   * undefined sends without one. Wired only while SES tenants are on.
   */
  sharedTenant?:
    | ((teamId: string, configurationSet: string | undefined) => Promise<string | undefined>)
    | undefined;
  /**
   * Awaited right before the send claim, after every check that can still
   * skip or fail the email — a token spent on a row that never reaches SES
   * is send capacity stolen from every other tenant. Takes the domain's
   * region: the send rate is per SES region.
   */
  throttle?: ((region?: string) => Promise<void>) | undefined;
  /** Re-enqueue a not-yet-due scheduled email at its due time. */
  reschedule?:
    | ((emailId: string, at: Date, priority: EmailSendPriority) => Promise<void>)
    | undefined;
  /** SES's 24-hour quota and the broadcast share; absent in tests that never reach it. */
  sesQuota?: SendQuotaControls | undefined;
  /** Arms the webhook drain for the rows written; absent, the reconcile sweep sends them. */
  enqueueWebhookDelivery?: WebhookEnqueue | undefined;
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
  /**
   * The content monitor: the screening before SES and the draw on an
   * accepted send. Absent when the judge is off (and in tests that never
   * reach it): no rows, no jobs, no state, no wait.
   */
  monitor?: MonitorDeps | undefined;
  /** The platform's own link domains (unsubscribe, tracking): never a customer's destination. */
  platformDomains?: ReadonlySet<string> | undefined;
  /** The parsing threads and cache the file scan uses; the process's own when absent. */
  media?: MediaDeps | undefined;
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

export type SendOutcome =
  | "sent"
  | "skipped"
  | "deferred"
  | "suppressed"
  | "failed"
  | "parked"
  | "canceled";

interface SendEligibility {
  eligible: boolean;
  topicId: string | null;
  reason?: string;
  /**
   * Recipients suppressed or opted out of the topic since accept; the send
   * drops them (accept-time strip semantics).
   */
  strip?: Set<string>;
}

async function checkSendEligibility(
  db: Db,
  email: typeof schema.emails.$inferSelect,
): Promise<SendEligibility> {
  if (!email.contactId) {
    // Suppressions and topic opt-outs recorded after accept (a scheduled or
    // quota-parked row can wait days) are honored the way accept does:
    // strip the hit, refuse only when no primary recipient is left.
    const recipients = [...email.to, ...(email.cc ?? []), ...(email.bcc ?? [])];
    const suppressed = await findSuppressed(db, email.teamId, recipients, {
      transactional: email.topicId === null,
    });
    const optedOut = email.topicId
      ? await findTopicOptOuts(db, email.teamId, email.topicId, recipients)
      : new Set<string>();
    const strip = new Set([...suppressed, ...optedOut]);
    if (strip.size === 0) return { eligible: true, topicId: null };
    if (email.to.every((r) => strip.has(r))) {
      const reason = email.to.every((r) => suppressed.has(r))
        ? "recipient_suppressed"
        : "topic_unsubscribed";
      return { eligible: false, topicId: null, reason };
    }
    return { eligible: true, topicId: null, strip };
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
    .select({ topicId: schema.broadcasts.topicId, status: schema.broadcasts.status })
    .from(schema.broadcasts)
    .where(
      and(eq(schema.broadcasts.id, email.broadcastId), eq(schema.broadcasts.teamId, email.teamId)),
    )
    .limit(1);
  if (!broadcast) return { eligible: false, topicId: null, reason: "broadcast_missing" };
  // A row a walk page or a drain release committed after the stop: the
  // audience was told nothing more goes out.
  if (broadcast.status === "canceled") {
    return { eligible: false, topicId: null, reason: "broadcast_canceled" };
  }
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

/**
 * Ends a still-queued email as failed or suppressed with its event and
 * webhook, in one transaction, and hands the delivery rows to the queue
 * once that commits. False when the row already left "queued" (sent,
 * canceled, ended), SES already took it, or a send claim it does not hold
 * is on it: nothing to end then.
 */
async function endQueuedEmail(
  db: Db,
  emailId: string,
  status: "failed" | "suppressed",
  reason: string,
  enqueue: WebhookEnqueue | undefined,
  claimHeld = false,
): Promise<boolean> {
  const e = schema.emails;
  const hooks = webhookBatch(enqueue);
  const ended = await db.transaction((tx) =>
    endQueuedEmails(tx as unknown as Db, {
      status,
      // A claimed row may already be with SES, its message id not yet
      // written: only the lane holding the claim, which SES refused, ends
      // it. Anyone else leaves it to SES's events or the stalled-claim sweep.
      where: and(
        eq(e.id, emailId),
        eq(e.latestStatus, "queued"),
        claimHeld ? undefined : isNull(e.sentAt),
      ),
      data: { source: "worker", reason },
      now: new Date(),
      enqueue: hooks.collect,
    }),
  );
  await hooks.flush();
  return ended > 0;
}

/**
 * Drops suppressed or opted-out recipients from the row (and the in-memory
 * copy the MIME is built from).
 */
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
 * Terminal failure for a still-queued email: moves the row to "failed",
 * records why and fires email.failed. Only the send lane holding the claim
 * passes `claimHeld`, and the claim is released with the row. Returns false
 * when the row already left "queued" (sent, canceled, suppressed), SES took
 * it, or it is claimed and `claimHeld` is not set — nothing to fail then.
 */
export async function failQueuedEmail(
  db: Db,
  emailId: string,
  reason: string,
  enqueue?: WebhookEnqueue,
  claimHeld = false,
): Promise<boolean> {
  return endQueuedEmail(db, emailId, "failed", reason, enqueue, claimHeld);
}

/**
 * Park a queued email as queued_quota because SES, not the plan, is out of
 * sends. Hands its reservation back (the drain reserves again on release,
 * one per row, as it does for plan-parked mail) so the two kinds share one
 * drain path. A row that already left "queued" is left alone.
 */
async function parkQueued(
  db: Db,
  email: { id: string; teamId: string },
  why: string,
  reason: (typeof schema.emailParkReasonEnum.enumValues)[number] | null = null,
): Promise<void> {
  await db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const moved = await transitionQueueState(txDb, email.id, {
      from: "queued",
      to: "queued_quota",
    });
    if (!moved) return;
    const [row] = await txDb
      .update(schema.emails)
      .set({ parkReason: reason, parkedAt: new Date() })
      .where(eq(schema.emails.id, email.id))
      .returning({ to: schema.emails.to, cc: schema.emails.cc, bcc: schema.emails.bcc });
    // Against the same counter accept charged, one unit per recipient as the
    // drain charges again on release: on a monthly plan that is the billing
    // period. The cap itself is irrelevant here, so the row is read as Cloud
    // reads it.
    const quota = await fetchTeamQuota(txDb, email.teamId, true);
    if (quota && row) {
      await releaseQuota(txDb, {
        teamId: email.teamId,
        count: countDistinctRecipients(row.to, row.cc, row.bcc),
        quota,
      });
    }
  });
  console.warn(`email.send: ${why}, parked ${email.id}`);
}

/**
 * A queued row of a broadcast that was stopped: canceled like the rows the
 * stop swept, with its reservation handed back. A row that already left
 * "queued" is left alone.
 */
async function cancelQueuedEmail(db: Db, email: { id: string; teamId: string }): Promise<boolean> {
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const [row] = await txDb
      .update(schema.emails)
      .set({ latestStatus: "canceled" })
      .where(
        and(
          eq(schema.emails.id, email.id),
          eq(schema.emails.latestStatus, "queued"),
          isNull(schema.emails.sentAt),
        ),
      )
      .returning({ id: schema.emails.id });
    if (!row) return false;
    const quota = await fetchTeamQuota(txDb, email.teamId, true);
    if (quota) await releaseQuota(txDb, { teamId: email.teamId, count: 1, quota });
    return true;
  });
}

/** Header names are case-insensitive; the caller's map keeps whatever casing it sent. */
const hasListUnsubscribe = (headers: Record<string, string> | null | undefined): boolean =>
  Object.keys(headers ?? {}).some((k) => k.toLowerCase() === "list-unsubscribe");

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

async function broadcastCanceled(db: Db, broadcastId: string): Promise<boolean> {
  const [row] = await db
    .select({ status: schema.broadcasts.status })
    .from(schema.broadcasts)
    .where(eq(schema.broadcasts.id, broadcastId))
    .limit(1);
  return row?.status === "canceled";
}

/** An ineligible row: canceled with its broadcast, suppressed for any other reason. */
async function refuse(
  db: Db,
  deps: SendDeps,
  email: { id: string; teamId: string },
  reason: string | undefined,
): Promise<SendOutcome> {
  if (reason === "broadcast_canceled") {
    return (await cancelQueuedEmail(db, email)) ? "canceled" : "skipped";
  }
  const ended = await endQueuedEmail(
    db,
    email.id,
    "suppressed",
    reason ?? "ineligible",
    deps.enqueueWebhookDelivery,
  );
  return ended ? "suppressed" : "skipped";
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
  // Only queued, unclaimed emails are sendable: quota-parked, already-sent,
  // and failed rows are skipped no matter how the job arrived, and so is a
  // claimed one, which SES took or may have taken.
  if (email?.latestStatus !== "queued" || email.sentAt) return "skipped";
  let outcome: SendOutcome;
  try {
    outcome = await sendQueued(db, deps, email);
  } catch (err) {
    // A retry may still send it, too late for a one-time code. A claim that
    // stands is one SES took or may have taken (the bookkeeping after it
    // failed, or the send ran past its deadline): that code may be on its
    // way. The send's own error is the one the job reports.
    if (email.tags?.[SYSTEM_MAIL_TAG] === "console_code") {
      try {
        const [row] = await db
          .select({ sentAt: schema.emails.sentAt })
          .from(schema.emails)
          .where(eq(schema.emails.id, email.id));
        if (!row?.sentAt) await noteConsoleCodeUndelivered(db, email);
      } catch (noteErr) {
        console.error(`email.send: console code fallback not marked for ${email.id}`, noteErr);
      }
    }
    throw err;
  }
  if (outcome === "failed" || outcome === "suppressed" || outcome === "parked") {
    await noteConsoleCodeUndelivered(db, email);
  }
  return outcome;
}

async function sendQueued(
  db: Db,
  deps: SendDeps,
  email: typeof schema.emails.$inferSelect,
): Promise<SendOutcome> {
  if (email.scheduledAt && email.scheduledAt.getTime() > Date.now()) {
    // Returning without re-enqueueing would ack the job and strand the
    // email forever; hand it back to the queue for its due time.
    await deps.reschedule?.(email.id, email.scheduledAt, emailSendPriority(email));
    return "deferred";
  }
  // An operator's suspension, or a broadcast pause, holds mail the queue
  // already carries: parked like an over-quota send, and the drain skips the
  // team until the operator lifts the hold. Read per send, so it bites on the
  // next row, not the next fan-out.
  const standing = await fetchTeamStanding(db, email.teamId);
  if (standing?.suspended || (email.broadcastId && standing?.broadcastsPausedByOperatorAt)) {
    await parkQueued(
      db,
      email,
      standing.suspended ? "team suspended" : "broadcasts paused",
      standing.suspended?.reason === "review" ? "review" : null,
    );
    return "parked";
  }
  // Account mail (core sendSystemMail); acceptEmail keeps this mark on no
  // other path, so a customer row cannot carry it.
  const systemMail = email.tags?.[SYSTEM_MAIL_TAG] !== undefined;
  // Transactional mail accepted before the team crossed the deliverability
  // pause line parks the same way, all but account mail, which must go out
  // whatever the rates; a broadcast row parks below, once a stop has been
  // honored.
  if (!email.broadcastId && !systemMail && (await deliverabilityHold(db, email.teamId))) {
    await parkQueued(db, email, "sending paused");
    return "parked";
  }

  // SES identities, the 24-hour quota and the send rate are all per region:
  // the send must target the domain's region, not a single deployment-wide
  // one, and so must the gate and bucket below. The name also seeds the
  // broadcast List-Id, so it is loaded here before header assembly, and
  // before the body decrypt: an unsendable row must not cost a KMS call on
  // every attempt.
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
            sesTenantAssociatedAt: schema.domains.sesTenantAssociatedAt,
            sesTenantConfigSet: schema.domains.sesTenantConfigSet,
            sesTenantName: schema.teams.sesTenantName,
          })
          .from(schema.domains)
          .innerJoin(schema.teams, eq(schema.teams.id, schema.domains.teamId))
          .where(
            and(eq(schema.domains.id, email.domainId), eq(schema.domains.teamId, email.teamId)),
          )
      )[0]
    : undefined;
  // SES at its 24-hour ceiling in this region: park before building anything,
  // the way an over-plan email parks at accept. The drain releases it as the
  // window frees. A bulk row parks earlier, at the broadcast share (or while
  // the region's broadcasts are held), so transactional mail keeps the rest.
  const bulk = email.broadcastId !== null;
  const region = domain?.region;
  if (bulk) {
    // Before any park: a row of a stopped broadcast must end canceled, never
    // parked where no sweep looks again.
    if (email.broadcastId && (await broadcastCanceled(db, email.broadcastId))) {
      return refuse(db, deps, email, "broadcast_canceled");
    }
    // Past the pause line a broadcast row waits for the drain, which releases
    // it once the rates recover. Rows the fan-out queued while the team was
    // healthy carry no drip and would otherwise go out at full speed.
    if (await deliverabilityHold(db, email.teamId)) {
      await parkQueued(db, email, "sending paused");
      return "parked";
    }
    if (deps.sesQuota?.bulkExhausted?.(region) || deps.sesQuota?.paused?.(region)) {
      await parkQueued(
        db,
        email,
        deps.sesQuota.paused?.(region) ? "region broadcasts held" : "SES bulk share reached",
      );
      return "parked";
    }
  } else if (deps.sesQuota?.exhausted(region)) {
    await parkQueued(db, email, "SES 24h quota reached");
    deps.sesQuota.noteTransactionalParked?.(region);
    return "parked";
  }

  // Terminal: "skipped" when the row was no longer this attempt's to fail.
  const fail = async (reason: string, claimHeld = false): Promise<SendOutcome> =>
    (await failQueuedEmail(db, email.id, reason, deps.enqueueWebhookDelivery, claimHeld))
      ? "failed"
      : "skipped";

  let eligibility = await checkSendEligibility(db, email);
  if (!eligibility.eligible) return refuse(db, deps, email, eligibility.reason);
  if (eligibility.strip) await stripRecipients(db, email, eligibility.strip);

  // The shared onboarding sender and the shared inbox domain are identities
  // of this instance's own SES account: no team domain, the default region
  // and configuration set. Only the onboarding email is the platform's own
  // content; shared-domain mail is a customer's, screened like any and sent
  // under the team's tenant once associated.
  const onboarding = !email.domainId && isOnboardingSender(email.from, deps.onboardingEmailFrom);
  const sharedSend =
    !email.domainId &&
    !onboarding &&
    isSharedInboxSender(
      email.from,
      deps.sharedInboxDomain === undefined ? sharedInboxDomain() : deps.sharedInboxDomain,
    );
  if (!onboarding && !sharedSend && domain?.status !== "verified") {
    // Terminal, not retried: a domain demoted or deleted after accept does
    // not come back on its own, and the row would otherwise ride the retry
    // and reconcile loops until its body is purged.
    return fail("domain_not_verified");
  }
  // Read per send so the operator's switch also holds mail queued before it
  // was turned off: that mail waits in the queue until sending resumes.
  const sharedSettings = sharedSend ? await deps.settings?.() : undefined;
  if (sharedSettings?.sharedInboxSend === false) {
    await deps.reschedule?.(
      email.id,
      new Date(Date.now() + SHARED_PAUSED_RETRY_MS),
      emailSendPriority(email),
    );
    return "deferred";
  }
  const configurationSet = domain?.sesConfigurationSet ?? deps.defaultConfigurationSet;

  const { bodyCiphertext, bodyIv, bodyWrappedDek, bodyKeyVersion } = email;
  if (!bodyCiphertext || !bodyIv || !bodyWrappedDek || bodyKeyVersion === null) {
    return fail("body_missing");
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
    return fail("body_unreadable");
  }

  // Screening before SES: mail with a reason to be judged first waits for
  // the verdict queued, and the send lane moves on; the judge queues the send
  // again once it answers. The team's hold or pause the verdict brings was
  // read above, on this pass. Account mail and the fixed onboarding email are
  // never customer content, so they never wait.
  let screened: { id: string; unjudged: boolean } | null = null;
  let probation = false;
  let media: SendMedia | null = null;
  if (deps.monitor && !systemMail && !onboarding) {
    // Read once for the linkage check and the gate.
    const settings = await deps.monitor.settings().catch(() => null);
    const team = settings ? await screeningTeam(db, settings, email.teamId, new Date()) : undefined;
    // A team in its first window that shares people, domains or this message
    // with a team suspended for phishing is held before it sends anything.
    if (team?.firstWindow && !email.broadcastId) {
      const linked = await linkTeam(db, {
        teamId: email.teamId,
        trigger: "send",
        message: { from: email.from, subject: email.subject, html: body.html, text: body.text },
        tier: team.tier,
      });
      if (linked?.held) {
        await parkQueued(db, email, "team linked to a team suspended for phishing", "review");
        return "parked";
      }
    }
    const files = attachments ?? [];
    const scan = files.length > 0 ? await scanAttachments(files, deps.media) : null;
    // Threads too busy to read a file say nothing about it: the job tries
    // again through the queue's backoff instead of parking or sending blind.
    if (scan?.busy) throw new MediaPoolError("busy");
    media = {
      attachments: files.length,
      opaque: opaqueFacts({ html: body.html, text: body.text, attachments: files.length }).opaque,
      links: scan?.links.map((link) => link.url) ?? [],
      unsafe: scan !== null && (scan.risky || scan.unreadable || scan.refused),
    };
    const gate = await screenBeforeSend(db, deps.monitor, {
      email,
      body: { html: body.html, text: body.text },
      media,
      ignore: deps.platformDomains,
      team,
      now: new Date(),
    });
    if (gate.action === "wait") {
      if (gate.until) await deps.reschedule?.(email.id, gate.until, emailSendPriority(email));
      return "deferred";
    }
    if (gate.action === "park") {
      await parkQueued(db, email, `screening parked it (${gate.reason})`, gate.reason);
      if (gate.reason === "media" && scan) {
        try {
          await saveMediaReview(db, deps.keyring, email, scanReview(scan), { keep: true });
        } catch (err) {
          console.error(`email.send: media review for ${email.id} not saved`, err);
        }
      }
      return "parked";
    }
    screened = gate.sample;
    probation = gate.probation === true;
  }

  // App-layer engagement tracking: when the domain has click or open tracking
  // on, WE rewrite links through our redirect endpoint and inject our pixel
  // before the MIME is built — SES never touches the body. Both off ships the
  // raw links and no pixel (clean-links requirement).
  // Account mail (core sendSystemMail) carries live credentials — reset and
  // verification links — so its anchors are never rewritten through the
  // redirect and no pixel rides along, whatever the domain's toggles say.
  // A people inbox is a mailbox: its mail goes out untracked too, as from any
  // mail client.
  const inboxKind = await inboxKindOf(db, email.inboxId);
  const click =
    body.tracking?.click !== false &&
    (domain?.clickTracking ?? false) &&
    !systemMail &&
    inboxKind !== "human";
  const open =
    body.tracking?.open !== false &&
    (domain?.openTracking ?? false) &&
    !systemMail &&
    inboxKind !== "human";
  let html = body.html;
  let text = body.text;

  // Transactional topic send (topicId without contactId): the unsubscribe
  // token signs a contactId, so it exists only when the message goes to one
  // address and that address resolves to a contact by (team,
  // lower(addr-spec)). Every to/cc/bcc copy is the same MIME, so a link
  // minted for one recipient would let the others opt that person out.
  // Substitution runs before the tracking rewrite so the expanded link can be
  // skipped by it.
  let topicUnsubscribeToken: string | null = null;
  const soleRecipient = email.to.length === 1 && !email.cc?.length && !email.bcc?.length;
  if (email.topicId && !email.contactId && deps.unsubscribe && soleRecipient) {
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
        emailId: email.id,
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
  let trackingPending = false;
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
    trackingPending =
      shippedUntracked && !!domain?.trackingSubdomain && !!domain.trackingSubdomainSetAt;
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
        teamId: email.teamId,
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
          emailId: email.id,
          secretKey: deps.unsubscribe.secretKey,
        }),
      ),
    );
  } else if (topicUnsubscribeToken && deps.unsubscribe && !hasListUnsubscribe(email.headers)) {
    // Topic sends carry the same RFC 8058 one-click headers as broadcasts so
    // the recipient can opt out of the topic without a global unsubscribe. A
    // sender who supplied its own pair (validated at accept) keeps it: its
    // footer link and the header then point at the same place.
    Object.assign(
      headers,
      buildUnsubscribeHeaders(deps.unsubscribe.baseUrl, topicUnsubscribeToken),
    );
  }
  // Bulk-mail class signals (RFC 2919 List-Id, RFC 3834 Auto-Submitted, and
  // Precedence) so mailbox providers file broadcasts as list mail. Only for
  // broadcast rows — transactional sends must not carry them. The List-Id
  // names the list, not the send: one per topic, one for the rest, so every
  // broadcast to the same people builds the same list's reputation.
  if (email.broadcastId && email.contactId) {
    if (domain?.name) {
      headers["List-Id"] = `<${eligibility.topicId ?? "broadcasts"}.${domain.name}>`.toLowerCase();
    }
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

  // SES rejects a tenant send whose identity or configuration set is not
  // associated, so TenantName rides only when the recorded association
  // matches the set this send names. Shared mail associates here: after
  // screening, so mail that waits or parks costs no SES calls, and before the
  // claim, so a crash mid-association never leaves a claimed, unsent row.
  const tenantName = domain
    ? domain.sesTenantAssociatedAt &&
      domain.sesTenantName &&
      (domain.sesTenantConfigSet ?? null) === (configurationSet ?? null)
      ? domain.sesTenantName
      : undefined
    : sharedSettings?.sharedInboxTenants
      ? await deps.sharedTenant?.(email.teamId, configurationSet)
      : undefined;

  // The rate-limit wait comes before the final re-check so that check stays
  // immediately ahead of the claim.
  await deps.throttle?.(domain?.region);

  // Re-check immediately before the atomic claim: quota delays and throttling
  // can leave a row queued long enough for a recipient to opt out after the
  // broadcast fan-out first selected them. A recipient suppressed or opted
  // out in the meantime invalidates the MIME already built, so the row is
  // stripped and handed straight back to the queue.
  eligibility = await checkSendEligibility(db, email);
  if (!eligibility.eligible) return refuse(db, deps, email, eligibility.reason);
  if (eligibility.strip) {
    await stripRecipients(db, email, eligibility.strip);
    await deps.reschedule?.(email.id, new Date(), emailSendPriority(email));
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

  // Credential-bearing account mail loses its body the moment SES holds it,
  // or may hold it: a reset link is live for thirty minutes, and the row's
  // body is otherwise readable by every member of the owning team, any
  // full-access key and any connected app until the retention purge.
  // Recipient, subject, status, events and counters stay. Other system kinds
  // carry only dashboard links and keep their body for the normal retention
  // window.
  const purgeCredential = async () => {
    if (!systemMail || !CREDENTIAL_MAIL_KINDS.has(email.tags?.[SYSTEM_MAIL_TAG] ?? "")) return;
    await db
      .update(schema.emails)
      .set(purgedEmailBodyColumns(new Date()))
      .where(eq(schema.emails.id, email.id));
  };
  const send = (tenant: string | undefined) =>
    deps.ses.sendRaw({
      raw: mime,
      emailId: email.id,
      to: email.to,
      cc: email.cc,
      bcc: email.bcc,
      ...(configurationSet ? { configurationSetName: configurationSet } : {}),
      ...(domain?.region ? { region: domain.region } : {}),
      ...(tenant ? { tenantName: tenant } : {}),
    });
  let messageId: string;
  try {
    ({ messageId } = await send(tenantName).catch(async (err: unknown) => {
      // An association removed outside the app: forgotten, so the team's
      // next shared send associates again, and this one goes out once more
      // without the tenant.
      if (!sharedSend || !tenantName || !isTenantNotAssociated(err)) throw err;
      await clearSharedTenant(db, email.teamId);
      return send(undefined);
    }));
  } catch (err) {
    // sendRaw threw ⇒ the SDK exhausted its own retries without an accept,
    // unless the send deadline cut it off: SES may hold that one, so its
    // claim stands and the job retry skips the row, leaving it to SES's
    // events or the stalled-claim sweep. A permanent refusal ends the email
    // here; anything else releases the claim so the job retry can send.
    // (After a SUCCESSFUL sendRaw the claim is never released — a
    // bookkeeping failure then leaves the row claimed rather than risking a
    // duplicate delivery.)
    const name = (err as { name?: string }).name ?? "";
    if (TERMINAL_SES_ERRORS.has(name)) {
      return fail(`ses_${name}`, true);
    }
    if (name === "AbortError") {
      await purgeCredential();
      throw err;
    }
    await db
      .update(schema.emails)
      .set({ sentAt: null })
      .where(and(eq(schema.emails.id, email.id), eq(schema.emails.latestStatus, "queued")));
    // The 24-hour quota is not a retry's problem: SES names it, or the same
    // throttling exception arrives and a fresh account read says the window
    // is full. Either way the email parks; a plain rate refusal keeps retrying.
    if (
      isSesQuotaRefusal(err) ||
      (isSesThrottle(err) && deps.sesQuota !== undefined && (await deps.sesQuota.refresh(region)))
    ) {
      await parkQueued(db, email, bulk ? "SES bulk share reached" : "SES 24h quota reached");
      if (!bulk) deps.sesQuota?.noteTransactionalParked?.(region);
      return "parked";
    }
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
  const sentAt = new Date();
  const recipients = [...email.to, ...(email.cc ?? []), ...(email.bcc ?? [])];
  const noFeedback = sentWithoutComplaintFeedback(recipients) ? 1 : 0;
  await db
    .insert(counter)
    .values({ teamId: email.teamId, day: utcDay(sentAt), sent: 1, sentNoFeedback: noFeedback })
    .onConflictDoUpdate({
      target: [counter.teamId, counter.day],
      set: {
        sent: sql`${counter.sent} + 1`,
        sentNoFeedback: sql`${counter.sentNoFeedback} + ${noFeedback}`,
      },
    });
  await bumpHourlyUsage(db, { teamId: email.teamId, at: sentAt, counts: { sent: 1 } });
  if (bulk) deps.sesQuota?.noteBulkSent?.(region);
  // Insights below evaluate the in-memory body.
  await purgeCredential();
  // Insights are best-effort bookkeeping on an already-accepted send: a bug
  // here must never fail (and so retry) the delivery.
  let insights: ReturnType<typeof evaluateEmailInsights> | undefined;
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
      insights = evaluateEmailInsights({
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
          trackingPending,
        },
        domainSnapshot: domain
          ? { dmarcPolicy: domain.dmarcPolicy, dmarcCheckedAt: domain.dmarcCheckedAt }
          : null,
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
  // The content monitor's draw, the same best-effort rule: the send is done,
  // a failure here is logged and changes nothing. The instance's own account
  // mail and the fixed onboarding email are never customer content, so they
  // are never drawn.
  if (deps.monitor && !systemMail && !onboarding) {
    try {
      if (screened) {
        // Judged before it went out: counted, never drawn again, which would
        // count its verdict twice toward the repeat hold.
        await noteAcceptedSend(db, email.teamId, new Date());
        if (screened.unjudged) {
          await judgeAfterSend(db, deps.monitor, { id: screened.id, teamId: email.teamId });
        }
      } else if (email.firstContact && inboxKind === "agent") {
        // An agent writing to someone new is always judged, and its verdict
        // folds into the team's hold policy like any outbound sample.
        const now = new Date();
        await noteAcceptedSend(db, email.teamId, now);
        await recordMonitorSample(db, deps.monitor, await deps.monitor.settings(), {
          teamId: email.teamId,
          emailId: email.id,
          broadcastId: null,
          kind: "agent_first_contact",
          now,
        });
      } else {
        // An opaque email and one with files each add an anomaly: both
        // together draw it at every tier.
        await sampleAcceptedEmail(db, deps.monitor, {
          teamId: email.teamId,
          emailId: email.id,
          broadcast: email.broadcastId !== null,
          probation,
          anomalies:
            (insights?.checks.filter(
              (c) =>
                c.status === "fail" && (MONITOR_ANOMALY_CHECKS as readonly string[]).includes(c.id),
            ).length ?? 0) +
            (media?.opaque ? 1 : 0) +
            (media && media.attachments > 0 ? 1 : 0),
        });
      }
    } catch (err) {
      console.error(`email.send: monitor draw failed for ${email.id}`, err);
    }
  }
  // The sentAt claim above makes this path single-shot per email, so the
  // email.sent fan-out cannot double-fire on a job retry.
  await enqueueWebhookDeliveries(db, {
    teamId: email.teamId,
    email: { emailId: email.id, from: email.from, to: email.to, subject: email.subject },
    type: "email.sent",
    occurredAt: new Date(),
    enqueue: deps.enqueueWebhookDelivery ?? (async () => {}),
  });
  return "sent";
}

async function inboxKindOf(db: Db, inboxId: string | null): Promise<"agent" | "human" | null> {
  if (!inboxId) return null;
  const [inbox] = await db
    .select({ kind: schema.inboxes.kind })
    .from(schema.inboxes)
    .where(eq(schema.inboxes.id, inboxId));
  return inbox?.kind ?? null;
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
          attachments: input.attachments.map((a) => {
            const contentType = sentContentType(a.contentType);
            return {
              filename: a.filename,
              content: a.content,
              encoding: "base64" as const,
              ...(contentType ? { contentType } : {}),
              // nodemailer would send a message/* part (a forwarded .eml) inline;
              // only a part the html references by content id is.
              ...(a.contentId
                ? { cid: a.contentId }
                : { contentDisposition: "attachment" as const }),
            };
          }),
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
        tokens = Math.min(Math.max(rate, 1), tokens + ((now - lastRefill) / 1000) * rate);
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
