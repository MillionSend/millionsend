import { randomUUID } from "node:crypto";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, count, eq, type SQL, sql } from "drizzle-orm";
import type { ApiKeyAuth } from "./api-key-auth.js";
import { type EmailAttachment, encryptEmailBody, sealAttachments } from "./crypto/envelope.js";
import type { Keyring } from "./crypto/keyring.js";
import { admitWarmup } from "./domain-warmup.js";
import { purgedEmailBodyColumns } from "./email-retention.js";
import { errorClassAndCode } from "./error-summary.js";
import { type InboxActor, inboxActorFromAuth } from "./inboxes/activity.js";
import type { InboxKeys } from "./inboxes/keys.js";
import {
  beginInboxAccept,
  finishInboxAccept,
  gateGenericSend,
  type InboxAcceptState,
  refundInboxAccept,
} from "./inboxes/send.js";
import { type SharedRefusalReason, secondsToNextUtcDay } from "./inboxes/send-policy.js";
import type { MonitorSettings } from "./monitor-settings.js";
import { monthlyCapacity, type QuotaTeamRow, type TeamQuota, teamQuota } from "./plans.js";
import { quotaChargeAt, releaseQuota, reserveQuota } from "./quota.js";
import { type UndeliverableReason, undeliverableRecipients } from "./recipient-domains.js";
import { parseSingleSender } from "./sender-address.js";
import { extractAddrSpec, findSuppressed, normalizeAddress } from "./suppressions.js";
import { type SendRefusal, sendRefusal } from "./team-standing.js";
import { findTopicOptOuts } from "./topics.js";
import { utcDay } from "./utc-day.js";
import {
  enqueueWebhookDeliveries,
  suppressedEmailExtras,
  type WebhookEnqueue,
  webhookBatch,
} from "./webhooks.js";

/**
 * Domain part of an RFC 5322 sender, lowercased. SECURITY: strict
 * single-mailbox parsing — multi-mailbox or ambiguous input returns null, so
 * a From that authorizes against one domain can never be emitted as another
 * (see parseSingleSender).
 */
export function senderDomain(from: string): string | null {
  return parseSingleSender(from)?.domain ?? null;
}

export type SenderDomainVerdict =
  | { ok: true; domainId: string; region: string; fromDomain: string; address: string }
  | { ok: false; reason: "invalid_sender"; fromDomain: null }
  | { ok: false; reason: "unverified_domain"; fromDomain: string };

/**
 * Sender domain must be one of the team's verified domains — otherwise any
 * key could queue mail claiming any sender. Every accept surface (HTTP API,
 * SMTP relay) runs this same rule; transport-level identities (e.g. SMTP
 * MAIL FROM) are never trusted instead. The From must parse as exactly one
 * unambiguous mailbox (parseSingleSender); the returned `address` is the
 * canonical addr-spec that verification applies to.
 */
export async function verifySenderDomain(
  db: Db,
  teamId: string,
  from: string,
): Promise<SenderDomainVerdict> {
  const sender = parseSingleSender(from);
  if (!sender) return { ok: false, reason: "invalid_sender", fromDomain: null };
  const [domain] = await db
    .select({ id: schema.domains.id, status: schema.domains.status, region: schema.domains.region })
    .from(schema.domains)
    .where(and(eq(schema.domains.teamId, teamId), eq(schema.domains.name, sender.domain)));
  if (domain?.status !== "verified") {
    return { ok: false, reason: "unverified_domain", fromDomain: sender.domain };
  }
  return {
    ok: true,
    domainId: domain.id,
    region: domain.region,
    fromDomain: sender.domain,
    address: sender.address,
  };
}

export interface AcceptEmailDeps {
  db: Db;
  keyring: Keyring;
  /** Cloud enforces plan quotas; self-host sends without caps. */
  isCloud: boolean;
  enqueueEmailSend: (emailId: string, opts?: { startAfter?: Date }) => Promise<void>;
  /** Thread-token keys: a send from an inbox address resolves its thread through them. */
  inboxKeys?: InboxKeys | undefined;
  /** SHARED_INBOX_DOMAIN: its addresses send only from their own inbox, under the shared domain's rules. */
  sharedInboxDomain?: string | null | undefined;
  /**
   * The process's trust & safety settings reader (monitorSettingsReader).
   * Optional: without it, a send that needs the settings reads them.
   */
  monitorSettings?: (() => Promise<MonitorSettings>) | undefined;
  /**
   * Arms the webhook drain for the rows an accept writes (email.scheduled,
   * an inbox send's events). Optional: without it the rows still land and
   * the webhooks.reconcile sweep sends them.
   */
  enqueueWebhookDeliveries?: WebhookEnqueue | undefined;
}

/** SECURITY: must come from verified authentication, never from the payload. */
export interface AcceptEmailAuth {
  teamId: string;
  /**
   * The team's billing columns; the cap is derived here (teamQuota), never
   * trusted from the payload. "uncapped" is for the instance's own account
   * mail, which counts but must never park nor be refused by sendRefusal.
   */
  billing: QuotaTeamRow | "uncapped";
  /** Null when the caller authenticated with something other than an API key (OAuth/MCP). */
  apiKeyId: string | null;
  /** An inbox-scoped key's inbox: it sends from that inbox's address only. */
  inboxId?: string | null | undefined;
}

export interface AcceptEmailPayload {
  from: string;
  to: string[];
  cc?: string[] | undefined;
  bcc?: string[] | undefined;
  replyTo?: string[] | undefined;
  subject: string;
  html?: string | undefined;
  text?: string | undefined;
  tracking?: { open?: false | undefined; click?: false | undefined } | undefined;
  tags?: Record<string, string> | null | undefined;
  /** Custom SMTP headers; transport-owned names are rejected at the wire. */
  headers?: Record<string, string> | undefined;
  attachments?: EmailAttachment[] | undefined;
  scheduledAt?: Date | undefined;
  /** From verifySenderDomain — callers verify the sender before accepting;
   * null only for the dashboard's onboarding email from ONBOARDING_EMAIL_FROM
   * and for mail from a shared-domain inbox. */
  domainId: string | null;
  /** Topic-scoped send; callers validate team ownership before accepting. */
  topicId?: string | undefined;
  /**
   * Set by inbox-aware callers after their own send decision; the accept
   * transaction then records the inbox, thread and cap usage with the row.
   */
  inbox?: InboxAccept | undefined;
}

export interface InboxAccept {
  inboxId: string;
  /** Null: a new thread is created (folder sent). */
  threadId: string | null;
  firstContact: boolean;
  newRecipients: string[];
  /** False for approved sends: counted, never refused by the cap. */
  countTowardCap: boolean;
}

/**
 * Tag names MillionSend writes on its own mail. Every customer send path
 * refuses them (isReservedTagName), so no customer tag passes for one.
 */
export const RESERVED_TAG_PREFIX = "millionsend_";

/** In any letter case: a reserved name stays reserved however it is spelled. */
export function isReservedTagName(name: string): boolean {
  return name.toLowerCase().startsWith(RESERVED_TAG_PREFIX);
}

/**
 * Marks the instance's account mail (sendSystemMail); the value names the
 * kind. The worker trusts it: such mail ships its links untracked, is never
 * drawn by the content monitor, is never held by the deliverability pause
 * and, for the kinds in CREDENTIAL_MAIL_KINDS, loses its body once SES
 * accepts it. So acceptEmail keeps it only on the account-mail path (billing
 * "uncapped").
 */
export const SYSTEM_MAIL_TAG = `${RESERVED_TAG_PREFIX}system`;

/** Decoded attachment bytes allowed per email, summed across attachments. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/**
 * Longest subject a send, broadcast or template takes: the RFC 5322 section
 * 2.1.1 line limit. What subjectProblem checks (inbox replies, forwards,
 * drafts and composer sends) keeps Resend's documented 2000 instead.
 */
export const MAX_SUBJECT_LENGTH = 998;

/**
 * The largest message SES v2 sends, encoded as it goes out: "40 MB", which
 * SES counts in MiB. Resend caps an email the same way, base64 included.
 */
export const SES_MAX_MESSAGE_BYTES = 40 * 1024 * 1024;

/** Decoded size of base64 attachments: 3 bytes per 4 chars; padding makes this a ≤2-byte overestimate. */
export function estimateAttachmentBytes(
  attachments: readonly { content?: string | undefined }[],
): number {
  return attachments.reduce((sum, a) => sum + Math.floor(((a.content?.length ?? 0) * 3) / 4), 0);
}

/** Headers and boundaries a MIME part adds around its body, a long non-ASCII filename included. */
const MIME_PART_OVERHEAD_BYTES = 4096;

/** `bytes` base64-encoded in 76-character lines, as nodemailer writes a part. */
const base64Lines = (bytes: number): number => Math.ceil(bytes / 57) * 78;

/**
 * `text` quoted-printable in lines, as nodemailer writes a text part, from
 * above: "=" and each non-ASCII UTF-8 byte take three bytes, a line break
 * two, and every 73 a soft break.
 */
function quotedPrintableLines(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x0a) bytes += 2;
    else if (c === 0x09 || c === 0x0d || (c >= 0x20 && c <= 0x7e && c !== 0x3d)) bytes += 1;
    else if (c < 0x80) bytes += 3;
    // Two UTF-8 bytes, or half of a surrogate pair's four.
    else if (c < 0x800 || (c >= 0xd800 && c <= 0xdfff)) bytes += 6;
    else bytes += 9;
  }
  return Math.ceil(bytes / 73) * 78;
}

/**
 * The MIME message the worker builds for a send, measured from above: text
 * in whichever of nodemailer's two encodings runs longer, attachments in
 * base64, header text four times over for encoded words, and room around
 * every part.
 */
// ponytail: link tracking lengthens every URL in the html after this is
// measured; a link-heavy send at the very limit can still fail at SES.
export function estimateMimeBytes(email: {
  subject?: string | undefined;
  html?: string | undefined;
  text?: string | undefined;
  headers?: Record<string, string> | undefined;
  attachments?: readonly { content?: string | undefined }[] | undefined;
}): number {
  const textPart = (value: string | undefined) =>
    value
      ? Math.max(quotedPrintableLines(value), base64Lines(Buffer.byteLength(value, "utf8")))
      : 0;
  const attachments = email.attachments ?? [];
  const headerText = Object.entries(email.headers ?? {}).reduce(
    (sum, [name, value]) => sum + Buffer.byteLength(name + value, "utf8"),
    Buffer.byteLength(email.subject ?? "", "utf8"),
  );
  return (
    MIME_PART_OVERHEAD_BYTES * (attachments.length + 4) +
    4 * headerText +
    textPart(email.html) +
    textPart(email.text) +
    attachments.reduce((sum, a) => sum + base64Lines(estimateAttachmentBytes([a])), 0)
  );
}

/**
 * The size cap a send breaks, or null: the attachments' own cap first, then
 * the encoded message SES would get, since SES refuses a larger one whatever
 * is retried.
 */
export function exceededSendSize(email: Parameters<typeof estimateMimeBytes>[0]): number | null {
  if (estimateAttachmentBytes(email.attachments ?? []) > MAX_ATTACHMENT_BYTES) {
    return MAX_ATTACHMENT_BYTES;
  }
  return estimateMimeBytes(email) > SES_MAX_MESSAGE_BYTES ? SES_MAX_MESSAGE_BYTES : null;
}

/**
 * Over-quota mail parks as queued_quota until the nightly drain; the backlog
 * is bounded to this many days' worth of the plan's limit so a key past its
 * cap cannot grow the table without bound.
 */
export const QUOTA_BACKLOG_DAYS = 3;

/**
 * Parked mail a team may hold behind a domain's warm-up: QUOTA_BACKLOG_DAYS
 * of what its plan would send in a day (a monthly volume spread over 30),
 * or of the warm-up cap where that is more. The plan's own volume, not the
 * cap, so a new domain's burst is held rather than refused.
 */
function warmupBacklogLimit(quota: TeamQuota, cap: number): number {
  const planDay = quota.kind === "none" ? 0 : monthlyCapacity(quota) / 30;
  return Math.ceil(QUOTA_BACKLOG_DAYS * Math.max(cap, planDay));
}

/**
 * Mail a team may park while held for review: QUOTA_BACKLOG_DAYS of what its
 * plan sends in a day, so a held sender cannot grow the table without bound.
 * An uncapped deployment bounds nothing, as its plans do.
 */
export function reviewBacklogLimit(quota: TeamQuota): number {
  return Math.ceil((QUOTA_BACKLOG_DAYS * monthlyCapacity(quota)) / 30);
}

export async function countParked(db: Db, teamId: string): Promise<number> {
  const [parked] = await db
    .select({ n: count() })
    .from(schema.emails)
    .where(and(eq(schema.emails.teamId, teamId), eq(schema.emails.latestStatus, "queued_quota")));
  return parked?.n ?? 0;
}

/**
 * The new-domain warm-up on one send its plan already admitted, inside the
 * accept transaction: "send" when the sending domain's cap and the team's
 * shared warm-up limit for the delivery day both have room (now reserved);
 * "park" when either has none, the plan's units handed back so the row
 * parks as queued_quota with reason "warmup" and the drain charges them all
 * again on release; "backlog_full", with the domain's cap and the team's
 * parked count for the refusal, when the team already holds all the parked
 * mail it may. Every accept surface enforces the warm-up through this one
 * call.
 */
export async function enforceDomainWarmup(
  tx: Db,
  send: {
    teamId: string;
    domainId: string | null;
    count: number;
    quota: TeamQuota;
    day: string;
    at: Date;
  },
): Promise<{ kind: "send" | "park" } | { kind: "backlog_full"; cap: number; waiting: number }> {
  const warmup = await admitWarmup(tx, send);
  if (warmup.admitted) return { kind: "send" };
  await releaseQuota(tx, send);
  const waiting = await countParked(tx, send.teamId);
  return waiting >= warmupBacklogLimit(send.quota, warmup.cap.cap)
    ? { kind: "backlog_full", cap: warmup.cap.cap, waiting }
    : { kind: "park" };
}

/**
 * The refusal once a sender under the new domain limit has a full backlog,
 * worded alike on every surface: the domain's daily cap, the mail already
 * waiting, and when to retry.
 */
export function newDomainLimitFullMessage(full: {
  domain: string;
  cap: number;
  waiting: number;
}): string {
  return `${full.domain} sends up to ${full.cap.toLocaleString("en-US")} emails a day for now, and ${full.waiting.toLocaleString("en-US")} are already waiting. Retry after 00:00 UTC.`;
}

/**
 * Distinct mailboxes an email reaches: what the daily quota charges, since
 * every recipient is one SES message and one unit of shared reputation.
 */
export function countDistinctRecipients(
  to: readonly string[],
  cc?: readonly string[] | null,
  bcc?: readonly string[] | null,
): number {
  return new Set(
    [...to, ...(cc ?? []), ...(bcc ?? [])].map((r) => normalizeAddress(extractAddrSpec(r))),
  ).size;
}

/**
 * An email row's recipients in SQL, on the query's `emails`: every address
 * in to, cc and bcc. A mailbox listed twice counts twice, so it can read a
 * little above what countDistinctRecipients charges.
 */
export function emailRecipientsSql(): SQL<number> {
  const e = schema.emails;
  return sql<number>`(jsonb_array_length(${e.to}) + coalesce(jsonb_array_length(${e.cc}), 0) + coalesce(jsonb_array_length(${e.bcc}), 0))`;
}

export type AcceptEmailResult =
  | {
      ok: true;
      id: string;
      parked: boolean;
      /**
       * Distinct mailboxes charged to the quota, the UTC day they count
       * against, and the instant they count at: the delivery time, now for
       * an immediate or backdated send.
       */
      recipientCount: number;
      day: string;
      at: Date;
      /** The cap the reservation ran against, for callers that reserve in bulk. */
      quota: TeamQuota;
      /**
       * Accepted while the team is held for review (parkUnderReview): parked
       * with reason "review", or, in a deferred batch, for the caller to park.
       */
      underReview: boolean;
      /**
       * Why the row parked: "warmup" for the new domain limit, "review" for
       * a review hold; null when it did not park or the plan's cap parked it.
       */
      parkReason: "warmup" | "review" | null;
    }
  | { ok: false; reason: "all_suppressed" }
  | { ok: false; reason: "attachments_too_large"; maxBytes: number }
  | { ok: false; reason: "quota_backlog_full" }
  /**
   * The sending domain's warm-up cap is spent and the team's parked backlog
   * is full: the domain, its daily cap and the team's parked mail.
   */
  | { ok: false; reason: "warmup_backlog_full"; domain: string; cap: number; waiting: number }
  /**
   * A monthly plan at its cap: the included volume with overage off, or the
   * hard cap past it with overage on. Refused outright, nothing parks for a month.
   */
  | { ok: false; reason: "monthly_quota_exceeded"; periodEnd: Date; overage: boolean }
  /** The team may not send at all right now (sendRefusal); nothing was accepted. */
  | ({ ok: false } & SendRefusal)
  /** An inbox's send rules hold it; `reasons` are rule codes, never content. */
  | { ok: false; reason: "inbox_send_policy"; reasons: string[] }
  | { ok: false; reason: "inbox_send_cap_reached"; retryAfterSec: number }
  /** A shared-domain rule refused it; SHARED_REFUSALS holds each one's answer. */
  | { ok: false; reason: Exclude<SharedRefusalReason, "shared_team_cap"> }
  | { ok: false; reason: "shared_team_cap"; retryAfterSec: number }
  /** A generic send from a shared-domain inbox broke one of its From rules; `message` names it. */
  | { ok: false; reason: "shared_from"; message: string }
  /** An inbox-scoped key sending from another address. */
  | { ok: false; reason: "inbox_scope" }
  /** A recipient whose domain can never receive mail (undeliverableRecipients); the first one. */
  | { ok: false; reason: "undeliverable_recipient"; address: string; why: UndeliverableReason };

/**
 * A send refused because the suppression list empties `to` still leaves a
 * metadata-only row (status "suppressed", with its event and email.suppressed)
 * so the attempt shows in the dashboard and `GET /emails`, as it does at
 * Resend. No body is kept (bodyPurgedAt marks it as already purged), nothing
 * is charged to the quota, and nothing is sent; the caller still answers 422
 * all_recipients_suppressed. Best-effort: the row is only for visibility, so
 * any failure is logged (class and SQLSTATE only, since the message quotes
 * the recipients) and the refusal stands.
 */
async function recordSuppressedAttempt(
  deps: AcceptEmailDeps,
  auth: AcceptEmailAuth,
  payload: AcceptEmailPayload,
  tags: Record<string, string> | null,
  now: Date,
): Promise<void> {
  try {
    const hooks = webhookBatch(deps.enqueueWebhookDeliveries);
    await deps.db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const [row] = await txDb
        .insert(schema.emails)
        .values({
          teamId: auth.teamId,
          domainId: payload.domainId,
          apiKeyId: auth.apiKeyId,
          from: payload.from,
          to: payload.to,
          cc: payload.cc && payload.cc.length > 0 ? payload.cc : null,
          bcc: payload.bcc && payload.bcc.length > 0 ? payload.bcc : null,
          replyTo: payload.replyTo ?? null,
          subject: payload.subject,
          tags,
          topicId: payload.topicId ?? null,
          latestStatus: "suppressed",
          ...purgedEmailBodyColumns(now),
        })
        .returning({ id: schema.emails.id });
      if (!row) throw new Error("suppressed email insert returned no row");
      await txDb.insert(schema.emailEvents).values({
        emailId: row.id,
        type: "suppressed",
        occurredAt: now,
        data: { source: "api", reason: "recipient_suppressed" },
      });
      await enqueueWebhookDeliveries(txDb, {
        teamId: auth.teamId,
        email: { emailId: row.id, from: payload.from, to: payload.to, subject: payload.subject },
        type: "email.suppressed",
        occurredAt: now,
        extras: suppressedEmailExtras("recipient_suppressed"),
        enqueue: hooks.collect,
      });
    });
    await hooks.flush();
  } catch (err) {
    console.error("suppressed email record failed", ...errorClassAndCode(err));
  }
}

/**
 * The single accept pipeline behind every send surface: the team's send
 * admission (sendRefusal), suppression strip, body encryption, atomic quota
 * reservation + email insert, and the send enqueue. Callers own transport
 * concerns (wire validation, idempotency keys, error shapes) and
 * sender-domain verification via verifySenderDomain.
 */
export async function acceptEmail(
  deps: AcceptEmailDeps,
  auth: AcceptEmailAuth,
  payload: AcceptEmailPayload,
  opts: {
    /**
     * Runs inside the accept transaction after the email insert; throwing
     * aborts the accept. The HTTP API records idempotency completion here.
     */
    completeInTx?: ((tx: Db, emailId: string) => Promise<void>) | undefined;
    /**
     * Run the quota reservation + insert inside this caller-owned transaction
     * instead of opening a new one, and skip the enqueue. Lets a batch accept
     * many items atomically (all-or-nothing) and enqueue after its own commit,
     * matching single-send's guarantee that a mid-flight failure sends nothing.
     */
    tx?: Db | undefined;
    /**
     * Skip the per-email quota reservation: the caller reserves once for the
     * whole batch after its loop, so the team's daily counter row is locked
     * for one statement instead of the length of the transaction. Rows insert
     * as queued; the caller parks them if its reservation fails.
     */
    quota?: "deferred" | undefined;
    /**
     * A review hold accepts and parks the mail instead of refusing it: the
     * sender sees it queued, as for any send, and nothing tells it the team
     * was caught. Releasing the hold sends it. Every other check still runs.
     */
    parkUnderReview?: boolean | undefined;
    /**
     * Keep a metadata-only "suppressed" email when the suppression list alone
     * empties `to`, written through deps.db outside any `tx`. Only the surface
     * that asks for it records, POST /emails; topic opt-outs, batches and the
     * other callers keep nothing.
     */
    recordSuppressed?: boolean | undefined;
    /** Who an inbox send's activity names; read from `auth` when absent. */
    actor?: InboxActor | undefined;
    /**
     * Skip the undeliverable-recipient check: the caller already ran it on
     * these recipients, or holds a transaction a DNS wait must not keep open.
     */
    recipientsChecked?: boolean | undefined;
    /**
     * With `tx`: where the accept's webhook rows go, for the caller to
     * queue after its own commit, as it queues the send.
     */
    webhooks?: WebhookEnqueue | undefined;
  } = {},
): Promise<AcceptEmailResult> {
  let underReview = false;
  if (auth.billing !== "uncapped") {
    const refusal = await sendRefusal(opts.tx ?? deps.db, auth.teamId);
    underReview =
      opts.parkUnderReview === true &&
      refusal?.reason === "team_suspended" &&
      refusal.suspension === "review";
    if (refusal && !underReview) return { ok: false, ...refusal };
  }
  const tooLarge = exceededSendSize(payload);
  if (tooLarge !== null) return { ok: false, reason: "attachments_too_large", maxBytes: tooLarge };
  if (!opts.recipientsChecked) {
    const [hit] = await undeliverableRecipients([
      ...payload.to,
      ...(payload.cc ?? []),
      ...(payload.bcc ?? []),
    ]);
    if (hit) {
      return {
        ok: false,
        reason: "undeliverable_recipient",
        address: hit.address,
        why: hit.reason,
      };
    }
  }

  const now = new Date();
  // Every surface meets the inbox rails here; inbox-aware callers decided
  // already and say so with payload.inbox. The accept surfaces (API, SMTP
  // relay) pass their ApiKeyAuth, and the actor reads only its key, inbox
  // and OAuth fields.
  const actor = opts.actor ?? inboxActorFromAuth(auth as ApiKeyAuth);
  let inboxAccept = payload.inbox;
  if (!inboxAccept && auth.billing !== "uncapped") {
    const gate = await gateGenericSend(opts.tx ?? deps.db, deps, {
      auth,
      billing: auth.billing,
      payload,
      actor,
      now,
    });
    if (!gate.ok) return gate;
    inboxAccept = gate.inbox ?? undefined;
  }

  // SECURITY: only the account-mail path may mark a row as system mail; any
  // other caller's copy of the mark is dropped, on a refused send's record too.
  let tags = payload.tags ?? null;
  if (tags && SYSTEM_MAIL_TAG in tags && auth.billing !== "uncapped") {
    tags = Object.fromEntries(Object.entries(tags).filter(([name]) => name !== SYSTEM_MAIL_TAG));
  }

  // Suppression: dedupe, check every recipient field, and strip suppressed
  // addresses; refuse only when no `to` recipient remains.
  const allRecipients = [
    ...new Set([...payload.to, ...(payload.cc ?? []), ...(payload.bcc ?? [])]),
  ];
  // Read through the caller's transaction when one is supplied: a batch holds
  // the connection open, so a read on deps.db would deadlock a single-conn pool.
  const suppressed = await findSuppressed(opts.tx ?? deps.db, auth.teamId, allRecipients, {
    transactional: !payload.topicId,
  });
  // The list alone, before topic opt-outs join the set: only it is recorded.
  const listSuppressed = new Set(suppressed);
  // Topic opt-outs drop exactly like suppression hits: strip the recipient,
  // keep sending to the rest, refuse only when no `to` remains.
  if (payload.topicId) {
    const optedOut = await findTopicOptOuts(
      opts.tx ?? deps.db,
      auth.teamId,
      payload.topicId,
      allRecipients,
    );
    for (const r of optedOut) suppressed.add(r);
  }
  const keep = (list: string[] | undefined) => list?.filter((r) => !suppressed.has(r));
  const to = keep(payload.to) ?? [];
  if (to.length === 0) {
    if (opts.recordSuppressed && payload.to.every((r) => listSuppressed.has(r))) {
      await recordSuppressedAttempt(deps, auth, payload, tags, now);
    }
    return { ok: false, reason: "all_suppressed" };
  }
  const cc = keep(payload.cc);
  const bcc = keep(payload.bcc);
  // Quota is charged per distinct mailbox, not per email: every recipient is
  // one SES message and one unit of shared reputation.
  const recipientCount = countDistinctRecipients(to, cc, bcc);

  // The row id is fixed before sealing: the envelope is bound to it.
  const emailId = randomUUID();
  const owner = { teamId: auth.teamId, rowId: emailId };
  const encrypted = await encryptEmailBody(
    {
      html: payload.html ?? null,
      text: payload.text ?? null,
      ...(payload.tracking ? { tracking: payload.tracking } : {}),
    },
    deps.keyring,
    owner,
  );
  // Attachments are content like html/text: sealed at rest, purged with the body.
  const sealedAttachments =
    payload.attachments && payload.attachments.length > 0
      ? await sealAttachments(payload.attachments, deps.keyring, owner)
      : null;

  const quota: TeamQuota =
    auth.billing === "uncapped" ? { kind: "none" } : teamQuota(auth.billing, deps.isCloud);
  // Quota reservation, email insert, and the caller's in-transaction hook
  // commit atomically (the quota contract). Over a DAILY cap mail is parked
  // as queued_quota — still accepted, drained after the midnight rollover;
  // a scheduled send is charged to its delivery day, so a team cannot stack
  // many days of the cap onto one future instant. A past scheduled_at sends
  // now and counts now (quotaChargeAt). A monthly plan counts every accept
  // against the current billing period, whenever it delivers.
  const deliveryAt = quotaChargeAt(payload.scheduledAt);
  const day = utcDay(deliveryAt);
  const hooks = webhookBatch(deps.enqueueWebhookDeliveries);
  let warmupFull: { cap: number; waiting: number } | null = null;
  const acceptRow = async (txDb: Db, inbox: InboxAcceptState | null) => {
    const reservation =
      opts.quota === "deferred"
        ? { reserved: true }
        : await reserveQuota(txDb, {
            teamId: auth.teamId,
            count: recipientCount,
            quota,
            day,
            at: deliveryAt,
          });
    // A monthly plan refuses at its period; its operator daily ceiling parks
    // like a daily cap, since the day frees at midnight.
    const dayRefused = "cap" in reservation && reservation.cap === "day";
    if (!reservation.reserved && quota.kind === "month" && !dayRefused) {
      return "monthly_quota_exceeded" as const;
    }
    const dayLimit =
      quota.kind === "day"
        ? quota.limit
        : quota.kind === "month"
          ? (quota.dailyCeiling ?? null)
          : null;
    if (!reservation.reserved && dayLimit !== null) {
      if ((await countParked(txDb, auth.teamId)) >= dayLimit * QUOTA_BACKLOG_DAYS) {
        return "quota_backlog_full" as const;
      }
    }
    // The plan said yes; the sending domain's warm-up has the last word. A
    // deferred batch runs the same gate after its own reservation.
    let parkReason: "warmup" | "review" | null = null;
    if (underReview && opts.quota !== "deferred") {
      // Charged above so a cap refuses it as any send; a parked row holds no
      // reservation, so the units go back and the drain charges them on
      // release, the warm-up included.
      if (reservation.reserved) {
        await releaseQuota(txDb, {
          teamId: auth.teamId,
          count: recipientCount,
          quota,
          day,
          at: deliveryAt,
        });
      }
      if ((await countParked(txDb, auth.teamId)) >= reviewBacklogLimit(quota)) {
        return "quota_backlog_full" as const;
      }
      parkReason = "review";
    } else if (reservation.reserved && opts.quota !== "deferred" && auth.billing !== "uncapped") {
      const warmup = await enforceDomainWarmup(txDb, {
        teamId: auth.teamId,
        domainId: payload.domainId,
        count: recipientCount,
        quota,
        day,
        at: deliveryAt,
      });
      if (warmup.kind === "backlog_full") {
        warmupFull = warmup;
        return "warmup_backlog_full" as const;
      }
      if (warmup.kind === "park") parkReason = "warmup";
    }
    const parked = !reservation.reserved || parkReason !== null;
    const [row] = await txDb
      .insert(schema.emails)
      .values({
        id: emailId,
        teamId: auth.teamId,
        domainId: payload.domainId,
        apiKeyId: auth.apiKeyId,
        from: payload.from,
        to,
        cc: cc && cc.length > 0 ? cc : null,
        bcc: bcc && bcc.length > 0 ? bcc : null,
        replyTo: payload.replyTo ?? null,
        subject: payload.subject,
        tags,
        headers: inbox?.headers ?? payload.headers ?? null,
        attachments: sealedAttachments,
        topicId: payload.topicId ?? null,
        latestStatus: parked ? "queued_quota" : "queued",
        parkReason,
        parkedAt: parked ? new Date() : null,
        scheduledAt: payload.scheduledAt ?? null,
        bodyCiphertext: encrypted.ciphertext,
        bodyIv: encrypted.iv,
        bodyWrappedDek: encrypted.wrappedDek,
        bodyKeyVersion: encrypted.keyVersion,
        inboxId: inbox?.inbox.id ?? null,
        threadId: inbox?.threadId ?? null,
        firstContact: inbox?.accept.firstContact ?? false,
      })
      .returning();
    if (!row) throw new Error("email insert returned no row");
    await opts.completeInTx?.(txDb, row.id);
    if (inbox) {
      await finishInboxAccept(txDb, inbox, {
        email: row,
        attachments: payload.attachments,
        actor,
        now,
        enqueue: opts.webhooks ?? hooks.collect,
      });
    }
    if (payload.scheduledAt && payload.scheduledAt.getTime() > now.getTime()) {
      await enqueueWebhookDeliveries(txDb, {
        teamId: auth.teamId,
        email: { emailId: row.id, from: row.from, to: row.to, subject: row.subject },
        type: "email.scheduled",
        occurredAt: now,
        enqueue: opts.webhooks ?? hooks.collect,
      });
    }
    return { id: row.id, parked, parkReason };
  };
  // The inbox's caps are charged before anything else is written, and
  // handed back if a later step refuses: the transaction commits on a refusal.
  const runAccept = async (txDb: Db) => {
    if (!inboxAccept) return acceptRow(txDb, null);
    const inbox = await beginInboxAccept(txDb, deps, {
      teamId: auth.teamId,
      accept: inboxAccept,
      recipients: recipientCount,
      subject: payload.subject,
      headers: payload.headers,
      now,
    });
    if (inbox === "cap") return "inbox_send_cap_reached" as const;
    if (inbox === "team_cap") return "shared_team_cap" as const;
    const out = await acceptRow(txDb, inbox);
    if (typeof out === "string") await refundInboxAccept(txDb, inbox);
    return out;
  };
  const accepted = opts.tx
    ? await runAccept(opts.tx)
    : await deps.db.transaction((tx) => runAccept(tx as unknown as Db));
  if (accepted === "quota_backlog_full") return { ok: false, reason: accepted };
  if (accepted === "warmup_backlog_full") {
    const { cap, waiting } = warmupFull ?? { cap: 0, waiting: 0 };
    const domain = senderDomain(payload.from) ?? payload.from;
    return { ok: false, reason: accepted, domain, cap, waiting };
  }
  if (accepted === "inbox_send_cap_reached" || accepted === "shared_team_cap") {
    return {
      ok: false,
      reason: accepted,
      retryAfterSec: secondsToNextUtcDay(now),
    };
  }
  if (accepted === "monthly_quota_exceeded") {
    return {
      ok: false,
      reason: "monthly_quota_exceeded",
      periodEnd: quota.kind === "month" ? quota.periodEnd : deliveryAt,
      overage: quota.kind === "month" && quota.overage,
    };
  }
  // After commit: hand the send to the queue (quota-parked emails wait for
  // the midnight drain instead). An enqueue failure must NOT undo the accept
  // — the email is committed, so rethrowing would let a retry create a
  // second email. The reconcile sweep re-enqueues any accepted email whose
  // job was lost. When the caller owns the transaction (opts.tx), it enqueues
  // after its own commit — the insert here is not yet durable.
  if (!opts.tx && !accepted.parked) {
    try {
      await deps.enqueueEmailSend(
        accepted.id,
        payload.scheduledAt ? { startAfter: payload.scheduledAt } : {},
      );
    } catch (err) {
      console.error("email.send enqueue failed; reconcile sweep will recover", err);
    }
  }
  if (!opts.tx) await hooks.flush();
  return {
    ok: true,
    id: accepted.id,
    parked: accepted.parked,
    recipientCount,
    day,
    at: deliveryAt,
    quota,
    underReview,
    parkReason: accepted.parkReason,
  };
}
