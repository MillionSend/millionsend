import { randomUUID } from "node:crypto";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, count, eq } from "drizzle-orm";
import { type EmailAttachment, encryptEmailBody, sealAttachments } from "./crypto/envelope.js";
import type { Keyring } from "./crypto/keyring.js";
import { PLAN_DAILY_LIMIT, type Plan } from "./plans.js";
import { reserveDailyQuota } from "./quota.js";
import { parseSingleSender } from "./sender-address.js";
import { extractAddrSpec, findSuppressed, normalizeAddress } from "./suppressions.js";
import { findTopicOptOuts } from "./topics.js";
import { utcDay } from "./utc-day.js";

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

/** True when `from` is the instance's shared onboarding sender (same addr-spec). */
export function isOnboardingSender(from: string, onboardingFrom: string | undefined): boolean {
  if (!onboardingFrom) return false;
  const sender = parseSingleSender(from);
  const platform = parseSingleSender(onboardingFrom);
  return sender !== null && platform !== null && sender.address === platform.address;
}

export type OnboardingSenderVerdict =
  | { ok: true; domainId: null; address: string }
  | { ok: false; reason: "recipient_not_member" };

/**
 * The instance's shared onboarding sender (ONBOARDING_EMAIL_FROM): any team
 * may send from it without a verified domain, but only to its own members'
 * inboxes — so the first-email snippet runs as written and the shared
 * address can never reach a stranger. Null when `from` is not that sender;
 * callers then fall through to verifySenderDomain.
 */
export async function verifyOnboardingSender(
  db: Db,
  teamId: string,
  from: string,
  recipients: readonly string[],
  onboardingFrom: string | undefined,
): Promise<OnboardingSenderVerdict | null> {
  if (!isOnboardingSender(from, onboardingFrom)) return null;
  const members = await db
    .select({ email: schema.user.email })
    .from(schema.teamMembers)
    .innerJoin(schema.user, eq(schema.user.id, schema.teamMembers.userId))
    .where(eq(schema.teamMembers.teamId, teamId));
  const allowed = new Set(members.map((m) => normalizeAddress(m.email)));
  const strangers = recipients.some((r) => {
    const address = extractAddrSpec(r);
    return address === null || !allowed.has(normalizeAddress(address));
  });
  if (strangers) return { ok: false, reason: "recipient_not_member" };
  // parseSingleSender succeeded inside isOnboardingSender.
  return { ok: true, domainId: null, address: parseSingleSender(from)?.address ?? "" };
}

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
}

/** SECURITY: must come from verified authentication, never from the payload. */
export interface AcceptEmailAuth {
  teamId: string;
  plan: Plan;
  /** Null when the caller authenticated with something other than an API key (OAuth/MCP). */
  apiKeyId: string | null;
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
  tags?: Record<string, string> | null | undefined;
  /** Custom SMTP headers; transport-owned names are rejected at the wire. */
  headers?: Record<string, string> | undefined;
  attachments?: EmailAttachment[] | undefined;
  scheduledAt?: Date | undefined;
  /** From verifySenderDomain — callers verify the sender before accepting;
   * null only for the shared onboarding sender (verifyOnboardingSender). */
  domainId: string | null;
  /** Topic-scoped send; callers validate team ownership before accepting. */
  topicId?: string | undefined;
}

/** Decoded attachment bytes allowed per email, summed across attachments. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Decoded size of base64 attachments: 3 bytes per 4 chars; padding makes this a ≤2-byte overestimate. */
export function estimateAttachmentBytes(
  attachments: readonly { content?: string | undefined }[],
): number {
  return attachments.reduce((sum, a) => sum + Math.floor(((a.content?.length ?? 0) * 3) / 4), 0);
}

/**
 * Over-quota mail parks as queued_quota until the nightly drain; the backlog
 * is bounded to this many days' worth of the plan's limit so a key past its
 * cap cannot grow the table without bound.
 */
export const QUOTA_BACKLOG_DAYS = 3;

export type AcceptEmailResult =
  | { ok: true; id: string; parked: boolean }
  | { ok: false; reason: "all_suppressed" }
  | { ok: false; reason: "attachments_too_large"; maxBytes: number }
  | { ok: false; reason: "quota_backlog_full" };

/**
 * The single accept pipeline behind every send surface: suppression strip,
 * body encryption, atomic quota reservation + email insert, and the send
 * enqueue. Callers own transport concerns (wire validation, idempotency
 * keys, error shapes) and sender-domain verification via verifySenderDomain.
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
  } = {},
): Promise<AcceptEmailResult> {
  if (estimateAttachmentBytes(payload.attachments ?? []) > MAX_ATTACHMENT_BYTES) {
    return { ok: false, reason: "attachments_too_large", maxBytes: MAX_ATTACHMENT_BYTES };
  }

  // Suppression: dedupe, check every recipient field, and strip suppressed
  // addresses; refuse only when no `to` recipient remains.
  const allRecipients = [
    ...new Set([...payload.to, ...(payload.cc ?? []), ...(payload.bcc ?? [])]),
  ];
  // Read through the caller's transaction when one is supplied: a batch holds
  // the connection open, so a read on deps.db would deadlock a single-conn pool.
  const suppressed = await findSuppressed(opts.tx ?? deps.db, auth.teamId, allRecipients);
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
  if (to.length === 0) return { ok: false, reason: "all_suppressed" };
  const cc = keep(payload.cc);
  const bcc = keep(payload.bcc);
  // Quota is charged per distinct mailbox, not per email: every recipient is
  // one SES message and one unit of shared reputation.
  const recipientCount = new Set(
    [...to, ...(cc ?? []), ...(bcc ?? [])].map((r) => normalizeAddress(extractAddrSpec(r))),
  ).size;

  // The row id is fixed before sealing: the envelope is bound to it.
  const emailId = randomUUID();
  const owner = { teamId: auth.teamId, rowId: emailId };
  const encrypted = await encryptEmailBody(
    { html: payload.html ?? null, text: payload.text ?? null },
    deps.keyring,
    owner,
  );
  // Attachments are content like html/text: sealed at rest, purged with the body.
  const sealedAttachments =
    payload.attachments && payload.attachments.length > 0
      ? await sealAttachments(payload.attachments, deps.keyring, owner)
      : null;

  const limit = deps.isCloud ? PLAN_DAILY_LIMIT[auth.plan] : null;
  // Quota reservation, email insert, and the caller's in-transaction hook
  // commit atomically (the quota contract). Over-quota mail is parked as
  // queued_quota — still accepted, drained after the midnight rollover.
  const runAccept = async (txDb: Db) => {
    // A scheduled send is charged to its delivery day, so a team cannot
    // stack many days of the cap onto one future instant.
    const quota = await reserveDailyQuota(txDb, {
      teamId: auth.teamId,
      count: recipientCount,
      limit,
      ...(payload.scheduledAt ? { day: utcDay(payload.scheduledAt) } : {}),
    });
    if (!quota.reserved && limit !== null) {
      const [parked] = await txDb
        .select({ n: count() })
        .from(schema.emails)
        .where(
          and(
            eq(schema.emails.teamId, auth.teamId),
            eq(schema.emails.latestStatus, "queued_quota"),
          ),
        );
      if ((parked?.n ?? 0) >= limit * QUOTA_BACKLOG_DAYS) return null;
    }
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
        tags: payload.tags ?? null,
        headers: payload.headers ?? null,
        attachments: sealedAttachments,
        topicId: payload.topicId ?? null,
        latestStatus: quota.reserved ? "queued" : "queued_quota",
        scheduledAt: payload.scheduledAt ?? null,
        bodyCiphertext: encrypted.ciphertext,
        bodyIv: encrypted.iv,
        bodyWrappedDek: encrypted.wrappedDek,
        bodyKeyVersion: encrypted.keyVersion,
      })
      .returning({ id: schema.emails.id });
    if (!row) throw new Error("email insert returned no row");
    await opts.completeInTx?.(txDb, row.id);
    return { id: row.id, parked: !quota.reserved };
  };
  const accepted = opts.tx
    ? await runAccept(opts.tx)
    : await deps.db.transaction((tx) => runAccept(tx as unknown as Db));
  if (accepted === null) return { ok: false, reason: "quota_backlog_full" };
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
  return { ok: true, id: accepted.id, parked: accepted.parked };
}
