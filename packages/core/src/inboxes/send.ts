import { abuseJudgeConfig, env } from "@millionsend/config";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import { simpleParser } from "mailparser";
import {
  type AcceptEmailAuth,
  type AcceptEmailDeps,
  type AcceptEmailPayload,
  type AcceptEmailResult,
  acceptEmail,
  estimateAttachmentBytes,
  type InboxAccept,
  MAX_ATTACHMENT_BYTES,
  verifySenderDomain,
} from "../accept-email.js";
import { attachmentVerdict } from "../attachment-policy.js";
import { canonicalBodyHash } from "../canonical-json.js";
import { createSemaphore } from "../concurrency.js";
import { decryptEmailBody, type EmailAttachment, openAttachments } from "../crypto/envelope.js";
import { firstRow } from "../driver-result.js";
import { beginIdempotent, completeIdempotent, releaseIdempotent } from "../idempotency.js";
import { imitatedBrandIn } from "../imitated-brands.js";
import {
  getMonitorSettingsRow,
  type MonitorSettings,
  resolveMonitorSettings,
} from "../monitor-settings.js";
import { registrableDomain } from "../org-domain.js";
import { effectivePlan, monthlyQuotaMessage, type Plan, type QuotaTeamRow } from "../plans.js";
import { outgoingSecretValues } from "../receiving/codes.js";
import { inboxKey, resolveThread, teamMemberEmails } from "../receiving/inbox-routing.js";
import {
  openReceivedRaw,
  RECEIVED_EMAIL_META_COLUMNS,
  type ReceivedEmailMeta,
} from "../receiving/message.js";
import { allowlisted } from "../receiving/trust.js";
import { undeliverableRecipientMessage } from "../recipient-domains.js";
import { screeningTier } from "../screening.js";
import { formatMailbox, parseMailbox, parseSingleSender } from "../sender-address.js";
import { QUOTA_COLUMNS } from "../team-plan.js";
import { sendRefusalError } from "../team-standing.js";
import { utcDay } from "../utc-day.js";
import {
  enqueueTeamWebhookEvents,
  type QueuedWebhookDelivery,
  type WebhookEnqueue,
} from "../webhooks.js";
import { type InboxActor, isAgentActor, recordInboxActivity } from "./activity.js";
import {
  addressKey,
  forwardedMessage,
  forwardSubject,
  headerValue,
  msgIds,
  replyHeaders,
  replyRecipients,
  replySubject,
  setHeader,
  withThreadToken,
} from "./compose.js";
import { draftForHeldSend, loadDraftWire } from "./drafts.js";
import { threadEmailEvent } from "./events.js";
import {
  forwardMarker,
  type InboxKeys,
  secretMac,
  threadTokenId,
  verifyForwardMarker,
} from "./keys.js";
import {
  FORWARD_WAIT_MAX,
  findLiveInbox,
  RECEIVED_SECRET_WINDOW,
  RECIPIENTS_PER_SEND_MAX,
  SHARED_PAUSED_RETRY_MS,
} from "./limits.js";
import {
  type AgentSendDecision,
  type AgentSendInput,
  decideAgentSend,
  INBOX_KEY_FROM_MESSAGE,
  isSharedInboxSender,
  type RecipientClass,
  SHARED_RECIPIENTS_MAX,
  SHARED_REFUSALS,
} from "./send-policy.js";
import { refusedLabel } from "./shared-domain.js";
import { type SharedSending, sharedSendMode } from "./shared-mode.js";
import { getThread } from "./threads.js";
import {
  type DraftWire,
  EMAIL_QUARANTINED_MESSAGE,
  type InboxError,
  type ScreeningVerdict,
  type SenderTrust,
  type SentEmailWire,
  type ThreadEmailAttachmentWire,
  type ThreadSummaryWire,
} from "./types.js";
import {
  outboundThreadEmailWire,
  sentEmailWire,
  sesMessageIdHeader,
  threadSummaryWire,
} from "./wire.js";

/** sent: 200; draft: 202 (held for approval); refused: the error's status. */
export type SendOutcome =
  | { kind: "sent"; email: SentEmailWire; threadId: string | null; inboxId: string | null }
  | { kind: "draft"; draft: DraftWire }
  | { kind: "refused"; error: InboxError };

export interface InboxSendDeps extends AcceptEmailDeps {
  inboxKeys: InboxKeys;
  sharedInboxDomain: string | null;
  enqueueWebhookDeliveries?: WebhookEnqueue | undefined;
}

export interface ReplyBody {
  html?: string | undefined;
  text?: string | undefined;
  subject?: string | undefined;
  cc?: string | string[] | undefined;
  bcc?: string | string[] | undefined;
  reply_all?: boolean | undefined;
  requires_approval?: boolean | undefined;
}

export interface ForwardBody {
  to: string | string[];
  cc?: string | string[] | undefined;
  bcc?: string | string[] | undefined;
  html?: string | undefined;
  text?: string | undefined;
  subject?: string | undefined;
  requires_approval?: boolean | undefined;
}

type InboxRow = typeof schema.inboxes.$inferSelect;
type EmailRow = typeof schema.emails.$inferSelect;

/** A message a reply or forward answers: one the inbox received, or one it sent. */
export type SendTarget =
  | {
      direction: "inbound";
      row: ReceivedEmailMeta;
      /** The tier in the inbox it is answered from; the row's own outside any inbox. */
      senderTrust: SenderTrust;
      /** Null while held (pending screening or quarantined). */
      deliveredAt: Date | null;
      verdict: ScreeningVerdict;
    }
  | { direction: "outbound"; row: EmailRow };

export const refused = (
  status: InboxError["status"],
  name: string,
  message: string,
): SendOutcome => ({ kind: "refused", error: { status, name, message } });

const notFound = (what: "Inbox" | "Thread" | "Email" | "Draft") =>
  refused(404, "not_found", `${what} not found.`);

const invalid = (message: string) => refused(422, "validation_error", message);

export const isOutcome = (v: unknown): v is SendOutcome =>
  typeof v === "object" && v !== null && "kind" in v;

const MiB = 1024 * 1024;

/** The instance's trust & safety settings: the process's reader when it has one, else a read. */
async function instanceSettings(
  db: Db,
  deps: Pick<AcceptEmailDeps, "monitorSettings"> = {},
): Promise<MonitorSettings> {
  if (deps.monitorSettings) return deps.monitorSettings();
  return resolveMonitorSettings(
    await getMonitorSettingsRow(db),
    env as unknown as Record<string, unknown>,
  ).settings;
}

/**
 * Whether the team sits in the content monitor's new tier, where send_policy
 * "open" is unavailable: the tier as screening reads it ahead of a send, so
 * the safety check and the send rails never disagree.
 */
export async function teamInNewTier(
  db: Db,
  teamId: string,
  now = new Date(),
  settings?: MonitorSettings,
): Promise<boolean> {
  return (await screeningTier(db, settings ?? (await instanceSettings(db)), teamId, now)) === "new";
}

function sharedModeUnder(settings: MonitorSettings, plan: Plan, isCloud: boolean): SharedSending {
  return sharedSendMode({ settings, plan, isCloud, judgeConfigured: abuseJudgeConfig() !== null });
}

/** What the team's addresses on the shared domain may send now; `plan` is the effective plan. */
export async function teamSharedSending(
  db: Db,
  deps: Pick<AcceptEmailDeps, "isCloud" | "monitorSettings">,
  plan: Plan,
): Promise<SharedSending> {
  return sharedModeUnder(await instanceSettings(db, deps), plan, deps.isCloud);
}

/** A shared-domain inbox's email past SHARED_RECIPIENTS_MAX distinct recipients. */
export function sharedRecipientsExceeded(
  inbox: Pick<InboxRow, "domainId">,
  recipients: readonly string[],
): boolean {
  return (
    inbox.domainId === null && new Set(recipients.map(addressKey)).size > SHARED_RECIPIENTS_MAX
  );
}

const TRUSTED_TIERS: ReadonlySet<string> = new Set(["owner", "allowlisted", "known_thread"]);

/**
 * A Reply-To counts as its message's own only at the From's organization,
 * or when that message came from someone the inbox already trusts (a null
 * tier trusts no one): anything else could steer a reply to a third party.
 */
function replyToTrusted(replyTo: string, from: string, senderTrust: string | null): boolean {
  const org = (a: string) => registrableDomain(a.slice(a.lastIndexOf("@") + 1));
  return (senderTrust !== null && TRUSTED_TIERS.has(senderTrust)) || org(replyTo) === org(from);
}

/**
 * The answered message's Reply-To entries it does not vouch for. On the
 * shared domain no sender's tier vouches, as in threadSenders.
 */
export function untrustedReplyTos(target: SendTarget, shared: boolean): string[] {
  if (target.direction !== "inbound") return [];
  return target.row.replyTo.filter(
    (rt) => !replyToTrusted(rt, target.row.from, shared ? null : target.senderTrust),
  );
}

/**
 * The From and trusted Reply-To of every delivered inbound message of a
 * thread. On the shared domain only authenticated senders count, since a
 * forged From would make a "reply" a first message to whoever it names, and
 * a Reply-To only at its From's organization: an owner or allowlisted
 * sender is someone the team named, not someone who proved the address.
 */
export async function threadSenders(
  db: Db,
  p: { inboxId: string; threadId: string; shared: boolean },
): Promise<Set<string>> {
  const m = schema.receivedEmailInboxes;
  const r = schema.receivedEmails;
  const rows = await db
    .select({ from: r.from, replyTo: r.replyTo, trust: m.senderTrust })
    .from(m)
    .innerJoin(r, eq(r.id, m.receivedEmailId))
    .where(
      and(
        eq(m.inboxId, p.inboxId),
        eq(m.threadId, p.threadId),
        isNotNull(m.deliveredAt),
        p.shared ? notInArray(m.senderTrust, ["unauthenticated", "failed"]) : undefined,
      ),
    );
  const out = new Set<string>();
  for (const row of rows) {
    if (row.from) out.add(addressKey(row.from));
    for (const rt of row.replyTo) {
      if (replyToTrusted(rt, row.from, p.shared ? null : row.trust)) out.add(addressKey(rt));
    }
  }
  return out;
}

const BURST_WINDOW_MS = 60 * 60_000;
/** Unattended sends one address may get within the burst window before the next waits for a person. */
const BURST_MAX = 10;

async function classifyRecipients(
  db: Db,
  p: {
    teamId: string;
    inbox: InboxRow;
    threadId: string | null;
    recipients: readonly string[];
    untrustedReplyTo: ReadonlySet<string>;
    now: Date;
  },
): Promise<{
  recipients: { address: string; cls: RecipientClass; viaUntrustedReplyTo: boolean }[];
  burstExceeded: boolean;
}> {
  const c = schema.inboxCorrespondents;
  // The shared domain is every team's: there, only addresses a member proved
  // (a login) or an authenticated sender count as people the inbox answers,
  // never owner_addresses or allowlist entries a team typed in.
  const shared = p.inbox.domainId === null;
  const [logins, senders, known] = await Promise.all([
    teamMemberEmails(db, p.teamId),
    p.threadId
      ? threadSenders(db, { inboxId: p.inbox.id, threadId: p.threadId, shared })
      : new Set<string>(),
    p.recipients.length > 0
      ? db
          .select({ address: c.address, burstStart: c.burstStart, burstCount: c.burstCount })
          .from(c)
          .where(and(eq(c.inboxId, p.inbox.id), inArray(c.address, [...p.recipients])))
      : [],
  ]);
  const owners = new Set([
    ...logins,
    ...(shared ? [] : p.inbox.safety.owner_addresses.map(addressKey)),
  ]);
  const knownAddresses = new Set(known.map((k) => k.address));
  const burstExceeded = known.some(
    (k) =>
      k.burstStart !== null &&
      p.now.getTime() - k.burstStart.getTime() < BURST_WINDOW_MS &&
      k.burstCount >= BURST_MAX,
  );
  const recipients = p.recipients.map((address) => {
    const cls: RecipientClass = owners.has(address)
      ? "owner"
      : !shared && allowlisted(address, p.inbox.safety.allowlist)
        ? "allowlisted"
        : senders.has(address)
          ? "thread"
          : knownAddresses.has(address)
            ? "known"
            : "new";
    const vouched = cls === "owner" || cls === "allowlisted" || cls === "thread";
    return { address, cls, viaUntrustedReplyTo: !vouched && p.untrustedReplyTo.has(address) };
  });
  return { recipients, burstExceeded };
}

/** Bounds the MAC lookups one send costs; a body past it is checked on its first values. */
const SECRET_VALUES_MAX = 2000;

/** Whether outgoing content repeats a code, sign-in link or token the team received within the window. */
async function receivedSecretHit(
  db: Db,
  keys: InboxKeys,
  p: {
    teamId: string;
    content: { subject: string; html: string | null; text: string | null };
    now: Date;
  },
): Promise<boolean> {
  const { subject, text, html } = p.content;
  const values = outgoingSecretValues(subject, text, html).slice(0, SECRET_VALUES_MAX);
  if (values.length === 0) return false;
  const s = schema.receivedSecrets;
  const [hit] = await db
    .select({ teamId: s.teamId })
    .from(s)
    .where(
      and(
        eq(s.teamId, p.teamId),
        inArray(
          s.mac,
          values.map((v) => secretMac(keys, p.teamId, v)),
        ),
        gt(s.createdAt, new Date(p.now.getTime() - RECEIVED_SECRET_WINDOW)),
      ),
    )
    .limit(1);
  return hit !== undefined;
}

/** decideAgentSend's shared-domain inputs; off the shared domain none of them is read. */
function sharedInputs(
  inbox: InboxRow,
  settings: MonitorSettings | undefined,
  p: { billing: QuotaTeamRow; isCloud: boolean; now: Date },
): Pick<AgentSendInput, "sharedMode" | "sharedNamesOk" | "sharedTeamCap"> {
  if (inbox.domainId !== null || !settings) {
    return {
      sharedMode: { mode: "open", cause: null },
      sharedNamesOk: true,
      sharedTeamCap: Number.POSITIVE_INFINITY,
    };
  }
  // A shared address lives at <team label>.<shared domain>.
  const label = inbox.emailAddress.slice(inbox.emailAddress.lastIndexOf("@") + 1).split(".")[0];
  const plan = effectivePlan(p.billing.plan, p.billing.currentPeriodEnd, p.now);
  return {
    sharedMode: sharedModeUnder(settings, plan, p.isCloud),
    // The same guards create applies, so a name it took is never held back
    // here, while an address issued before them is.
    sharedNamesOk:
      !imitatedBrandIn(inbox.fromName ?? "", { everydayWords: false }) &&
      !imitatedBrandIn(inbox.localPart, { everydayWords: false }) &&
      !refusedLabel(label ?? ""),
    sharedTeamCap: settings.sharedInboxTeamDailyCap,
  };
}

/** decideAgentSend over what the database knows of the inbox, its thread, its recipients and its team. */
export async function decideInboxSend(
  db: Db,
  deps: Pick<AcceptEmailDeps, "isCloud" | "monitorSettings"> & { inboxKeys: InboxKeys },
  p: {
    teamId: string;
    /** The team's billing columns, raw: the plan is read as effectivePlan. */
    billing: QuotaTeamRow;
    inbox: InboxRow;
    actor: InboxActor;
    approved: boolean;
    requiresApproval: boolean;
    /** The thread the send joins; null starts a conversation. */
    threadId: string | null;
    /** To, Cc and Bcc as mailboxes. */
    recipients: readonly string[];
    /** Recipients taken from the answered message's Reply-To when it does not vouch for them. */
    untrustedReplyTo: readonly string[];
    replyTarget: { automated: string | null } | null;
    content: { subject: string; html: string | null; text: string | null };
    /** Forwarding a received message that carried a code or sign-in link. */
    forwardedSecret: boolean;
    now: Date;
  },
): Promise<AgentSendDecision> {
  const recipients = [...new Set(p.recipients.map(addressKey))];
  const { safety } = p.inbox;
  const shared = p.inbox.domainId === null;
  const unattended = !p.approved && p.inbox.kind === "agent";
  const unattendedOpen = unattended && safety.send_policy === "open";
  const settings = shared || unattendedOpen ? await instanceSettings(db, deps) : undefined;
  const day = utcDay(p.now);
  const ud = schema.inboxUsageDaily;
  const uc = schema.usageCounters;
  const [classified, usage, teamTierNew, team] = await Promise.all([
    classifyRecipients(db, {
      teamId: p.teamId,
      inbox: p.inbox,
      threadId: p.threadId,
      recipients,
      untrustedReplyTo: new Set(p.untrustedReplyTo.map(addressKey)),
      now: p.now,
    }),
    db
      .select({ recipients: ud.recipients, newRecipients: ud.newRecipients })
      .from(ud)
      .where(and(eq(ud.inboxId, p.inbox.id), eq(ud.day, day))),
    unattendedOpen ? teamInNewTier(db, p.teamId, p.now, settings) : false,
    shared
      ? db
          .select({ recipients: uc.sharedRecipients })
          .from(uc)
          .where(and(eq(uc.teamId, p.teamId), eq(uc.day, day)))
      : [],
  ]);
  const privateHit =
    unattended &&
    safety.private_codes &&
    (p.forwardedSecret ||
      (await receivedSecretHit(db, deps.inboxKeys, {
        teamId: p.teamId,
        content: p.content,
        now: p.now,
      })));
  return decideAgentSend({
    inbox: {
      id: p.inbox.id,
      kind: p.inbox.kind,
      shared,
      safety,
      firstSentAt: p.inbox.firstSentAt,
    },
    teamTierNew,
    ...sharedInputs(p.inbox, settings, { billing: p.billing, isCloud: deps.isCloud, now: p.now }),
    actor: p.actor,
    approved: p.approved,
    requiresApproval: p.requiresApproval,
    isReply: p.threadId !== null,
    recipients: classified.recipients,
    replyTarget: p.replyTarget,
    burstExceeded: classified.burstExceeded,
    privateHit,
    usage: {
      recipientsToday: usage[0]?.recipients ?? 0,
      newRecipientsToday: usage[0]?.newRecipients ?? 0,
      sharedRecipientsToday: team[0]?.recipients ?? 0,
    },
    now: p.now,
  });
}

/** The accept pipeline's refusal as an inbox send answers it. */
export function acceptFailure(result: Exclude<AcceptEmailResult, { ok: true }>): InboxError {
  switch (result.reason) {
    case "quota_backlog_full":
    case "warmup_backlog_full":
      return {
        status: 429,
        name: "daily_quota_exceeded",
        message:
          "Daily sending quota exceeded and the queued backlog is full; retry after the UTC day rolls over",
      };
    case "monthly_quota_exceeded":
      return { status: 429, name: "monthly_quota_exceeded", message: monthlyQuotaMessage(result) };
    case "attachments_too_large":
      return {
        status: 422,
        name: "validation_error",
        message: `The email exceeds ${result.maxBytes / MiB} MiB`,
      };
    case "all_suppressed":
      return {
        status: 422,
        name: "all_recipients_suppressed",
        message: "All recipients are suppressed",
      };
    case "team_suspended":
    case "sending_paused": {
      const { code, message } = sendRefusalError(result);
      return { status: 403, name: code, message };
    }
    case "inbox_send_policy":
      return {
        status: 403,
        name: "inbox_send_policy",
        message: `The sending inbox's rules hold this email${result.reasons.length > 0 ? ` (${result.reasons.join(", ")})` : ""}`,
      };
    case "inbox_send_cap_reached":
      return {
        status: 429,
        name: "inbox_send_cap_reached",
        message: "This inbox reached its daily send limit; retry after the UTC day rolls over",
        retryAfterSec: result.retryAfterSec,
      };
    case "shared_paused":
    case "shared_plan":
    case "shared_domain":
    case "shared_recipients":
      return { ...SHARED_REFUSALS[result.reason] };
    case "shared_team_cap":
      return { ...SHARED_REFUSALS.shared_team_cap, retryAfterSec: result.retryAfterSec };
    case "shared_from":
      return { status: 422, name: "validation_error", message: result.message };
    case "inbox_scope":
      return {
        status: 403,
        name: "restricted_api_key",
        message: INBOX_KEY_FROM_MESSAGE,
      };
    case "undeliverable_recipient":
      return {
        status: 422,
        name: "validation_error",
        message: undeliverableRecipientMessage(
          { address: result.address, reason: result.why },
          { forSend: true },
        ),
      };
  }
}

/** The RFC 3834 reason of the received message `messageId` names in this inbox; undefined when it is none of its. */
async function receivedAutomated(
  db: Db,
  p: { teamId: string; inboxId: string; messageId: string },
): Promise<string | null | undefined> {
  const r = schema.receivedEmails;
  const m = schema.receivedEmailInboxes;
  const [row] = await db
    .select({ automated: r.automated })
    .from(r)
    .innerJoin(m, and(eq(m.receivedEmailId, r.id), eq(m.inboxId, p.inboxId)))
    .where(and(eq(r.teamId, p.teamId), eq(r.messageId, p.messageId)))
    .limit(1);
  return row ? row.automated : undefined;
}

/** The RFC 3834 reason of the newest message the inbox received in a thread; null for none. */
async function latestInboundAutomated(
  db: Db,
  p: { inboxId: string; threadId: string },
): Promise<string | null> {
  const r = schema.receivedEmails;
  const m = schema.receivedEmailInboxes;
  const [row] = await db
    .select({ automated: r.automated })
    .from(m)
    .innerJoin(r, eq(r.id, m.receivedEmailId))
    .where(and(eq(m.inboxId, p.inboxId), eq(m.threadId, p.threadId), isNotNull(m.deliveredAt)))
    .orderBy(desc(m.createdAt))
    .limit(1);
  return row?.automated ?? null;
}

/**
 * The shared domain's From rules a generic send from a shared inbox broke,
 * as a message naming the first one, or null. Inbox endpoints write the
 * From themselves; here the caller does, so it may carry the inbox's own
 * address and display name only, and nothing those endpoints never send.
 */
function sharedFromProblem(payload: AcceptEmailPayload, inbox: InboxRow): string | null {
  const from = parseMailbox(payload.from);
  if (from?.address.toLowerCase() !== inbox.emailAddress) {
    return `from must be ${inbox.emailAddress} exactly, with no +tag, on the shared domain`;
  }
  if (from.name !== undefined && from.name !== inbox.fromName) {
    return "from's display name must be left out or match the inbox's from_name on the shared domain";
  }
  const field = payload.scheduledAt
    ? "scheduled_at"
    : payload.replyTo?.length
      ? "reply_to"
      : payload.attachments?.length
        ? "attachments"
        : Object.keys(payload.headers ?? {}).length > 0
          ? "headers"
          : null;
  return field && `${field} is not available on the shared domain`;
}

/**
 * The acceptEmail hook for every surface that does not decide itself (POST
 * /emails, batch, the SMTP relay, MCP send_email): a From that is an inbox
 * address runs the inbox's rules, which on these surfaces send or refuse,
 * since there is no draft to hold.
 */
export async function gateGenericSend(
  db: Db,
  deps: AcceptEmailDeps,
  p: {
    auth: AcceptEmailAuth;
    billing: QuotaTeamRow;
    payload: AcceptEmailPayload;
    actor: InboxActor;
    now: Date;
  },
): Promise<{ ok: true; inbox: InboxAccept | null } | Exclude<AcceptEmailResult, { ok: true }>> {
  const { auth, payload } = p;
  const address = parseSingleSender(payload.from)?.address;
  // A +tag form of an inbox's address is that inbox's own, as routing reads it.
  let inbox: InboxRow | null = null;
  for (const key of address ? new Set([inboxKey(address, false), inboxKey(address, true)]) : []) {
    inbox ??= await findLiveInbox(db, { teamId: auth.teamId, address: key, now: p.now });
  }
  if (!inbox) {
    if (auth.inboxId) return { ok: false, reason: "inbox_scope" };
    // Only open mode lets a shared From this far: every other surface refuses it up front.
    if (isSharedInboxSender(payload.from, deps.sharedInboxDomain)) {
      return {
        ok: false,
        reason: "shared_from",
        message: "from must be the address of one of your inboxes on the shared domain",
      };
    }
    return { ok: true, inbox: null };
  }
  // An inbox-scoped key sends from its address as written, never a +tag form, as over SMTP.
  if (
    auth.inboxId &&
    (auth.inboxId !== inbox.id || address?.toLowerCase() !== inbox.emailAddress)
  ) {
    return { ok: false, reason: "inbox_scope" };
  }
  const recipients = [...payload.to, ...(payload.cc ?? []), ...(payload.bcc ?? [])];
  if (inbox.domainId === null) {
    const problem = sharedFromProblem(payload, inbox);
    if (problem) return { ok: false, reason: "shared_from", message: problem };
    if (sharedRecipientsExceeded(inbox, recipients)) {
      return { ok: false, reason: "shared_recipients" };
    }
  }
  if (!deps.inboxKeys) throw new Error("inboxKeys is not configured");
  const inReplyTo = msgIds(headerValue(payload.headers, "In-Reply-To"))[0];
  const refs = msgIds([
    ...(inReplyTo ? [inReplyTo] : []),
    ...msgIds(headerValue(payload.headers, "References")),
  ]).slice(0, 50);
  const thread = await resolveThread(db, deps.inboxKeys, {
    teamId: auth.teamId,
    inboxId: inbox.id,
    refs,
  });
  const threadId = thread?.threadId ?? null;
  const parent = inReplyTo
    ? await receivedAutomated(db, { teamId: auth.teamId, inboxId: inbox.id, messageId: inReplyTo })
    : undefined;
  // Threaded by References or a token alone, it answers the thread's newest received message.
  const automated = threadId
    ? parent !== undefined
      ? parent
      : await latestInboundAutomated(db, { inboxId: inbox.id, threadId })
    : undefined;
  const decision = await decideInboxSend(
    db,
    { ...deps, inboxKeys: deps.inboxKeys },
    {
      teamId: auth.teamId,
      billing: p.billing,
      inbox,
      actor: p.actor,
      approved: false,
      requiresApproval: false,
      threadId,
      recipients,
      untrustedReplyTo: [],
      replyTarget: automated === undefined ? null : { automated },
      content: {
        subject: payload.subject,
        html: payload.html ?? null,
        text: payload.text ?? null,
      },
      forwardedSecret: false,
      now: p.now,
    },
  );
  if (decision.result === "send") {
    return {
      ok: true,
      inbox: {
        inboxId: inbox.id,
        threadId,
        firstContact: decision.firstContact,
        newRecipients: decision.newRecipients,
        countTowardCap: decision.countTowardCap,
      },
    };
  }
  const reasons = decision.result === "draft" ? decision.reasons : [decision.name];
  await recordInboxActivity(db, {
    teamId: auth.teamId,
    inboxId: inbox.id,
    actor: p.actor,
    action: "email.refused",
    threadId,
    decision: { result: decision.result, reasons },
  });
  if (decision.result === "draft") return { ok: false, reason: "inbox_send_policy", reasons };
  if (decision.name === "restricted_api_key") return { ok: false, reason: "inbox_scope" };
  const retryAfterSec = decision.retryAfterSec ?? 1;
  if (decision.reason === "shared_team_cap") {
    return { ok: false, reason: "shared_team_cap", retryAfterSec };
  }
  if (decision.name === "inbox_send_cap_reached") {
    return { ok: false, reason: "inbox_send_cap_reached", retryAfterSec };
  }
  return { ok: false, reason: decision.reason ?? "shared_domain" };
}

/** An inbox send inside the accept transaction, from its cap charge to its email row. */
export interface InboxAcceptState {
  teamId: string;
  inbox: InboxRow;
  accept: InboxAccept;
  threadId: string;
  /** The send opened its thread. */
  created: boolean;
  /** The payload's headers led by the thread token, with Auto-Submitted on unattended agent mail. */
  headers: Record<string, string>;
  day: string;
  recipients: number;
}

/**
 * The team's recipients of shared-domain mail today, charged against
 * sharedInboxTeamDailyCap by a guarded upsert; false when it has no room.
 */
async function chargeSharedRecipients(
  tx: Db,
  p: { teamId: string; day: string; recipients: number },
): Promise<boolean> {
  // Read through the transaction, not the process's reader: a pooled read
  // could wait on the connection this transaction holds.
  const cap = (await instanceSettings(tx)).sharedInboxTeamDailyCap;
  // The day's first row inserts unguarded.
  if (p.recipients > cap) return false;
  const uc = schema.usageCounters;
  const charged = firstRow(
    await tx.execute(sql`
      insert into ${uc} (team_id, day, shared_recipients)
      values (${p.teamId}, ${p.day}, ${p.recipients})
      on conflict (team_id, day) do update
        set shared_recipients = ${uc.sharedRecipients} + ${p.recipients}
        where ${uc.sharedRecipients} + ${p.recipients} <= ${cap}
      returning team_id
    `),
  );
  return charged !== undefined;
}

async function refundSharedRecipients(
  tx: Db,
  p: { teamId: string; day: string; recipients: number },
): Promise<void> {
  const uc = schema.usageCounters;
  await tx
    .update(uc)
    .set({ sharedRecipients: sql`greatest(0, ${uc.sharedRecipients} - ${p.recipients})` })
    .where(and(eq(uc.teamId, p.teamId), eq(uc.day, p.day)));
}

/**
 * Inside the accept transaction, before any other write: the inbox's daily
 * cap charged by a guarded upsert (a race past the cap finds no room), the
 * team's shared-domain cap the same way for a shared inbox, and the thread
 * the send joins or opens. "cap" or "team_cap" when a charge found no room;
 * nothing was written then.
 */
export async function beginInboxAccept(
  tx: Db,
  deps: Pick<AcceptEmailDeps, "inboxKeys">,
  p: {
    teamId: string;
    accept: InboxAccept;
    recipients: number;
    subject: string;
    headers: Record<string, string> | undefined;
    now: Date;
  },
): Promise<InboxAcceptState | "cap" | "team_cap"> {
  const { accept } = p;
  const [inbox] = await tx
    .select()
    .from(schema.inboxes)
    .where(and(eq(schema.inboxes.id, accept.inboxId), eq(schema.inboxes.teamId, p.teamId)));
  if (!inbox) throw new Error("inbox send accepted for an inbox that no longer exists");
  const cap = accept.countTowardCap ? inbox.safety.send_cap : null;
  if (cap !== null && p.recipients > cap) return "cap";
  const day = utcDay(p.now);
  const team = { teamId: p.teamId, day, recipients: p.recipients };
  const shared = inbox.domainId === null;
  // The team's row first: intake locks usage_counters before inbox_usage_daily too.
  if (shared && !(await chargeSharedRecipients(tx, team))) return "team_cap";
  const ud = schema.inboxUsageDaily;
  const fresh = accept.newRecipients.length;
  const charged = firstRow(
    await tx.execute(sql`
      insert into ${ud} (inbox_id, day, recipients, new_recipients)
      values (${inbox.id}, ${day}, ${p.recipients}, ${fresh})
      on conflict (inbox_id, day) do update
        set recipients = ${ud.recipients} + ${p.recipients},
            new_recipients = ${ud.newRecipients} + ${fresh}
        where ${cap === null ? sql`true` : sql`${ud.recipients} + ${p.recipients} <= ${cap}`}
      returning inbox_id
    `),
  );
  if (!charged) {
    if (shared) await refundSharedRecipients(tx, team);
    return "cap";
  }
  let threadId = accept.threadId;
  if (threadId === null) {
    const [thread] = await tx
      .insert(schema.inboxThreads)
      .values({
        teamId: p.teamId,
        inboxId: inbox.id,
        subject: p.subject,
        folder: "sent",
        lastMessageAt: p.now,
      })
      .returning({ id: schema.inboxThreads.id });
    if (!thread) throw new Error("inbox thread insert returned no row");
    threadId = thread.id;
  }
  let headers = { ...(p.headers ?? {}) };
  if (deps.inboxKeys) {
    const domain = inbox.emailAddress.slice(inbox.emailAddress.lastIndexOf("@") + 1);
    headers = withThreadToken(
      headers,
      threadTokenId(deps.inboxKeys, { teamId: p.teamId, inboxId: inbox.id, threadId, domain }),
    );
  }
  // RFC 3834 §5: an agent's unattended mail says it was automatic, so the
  // other side's loop guard holds its answer. A person's send says nothing.
  if (inbox.kind === "agent" && accept.countTowardCap && !headerValue(headers, "Auto-Submitted")) {
    headers = setHeader(
      headers,
      "Auto-Submitted",
      headerValue(headers, "In-Reply-To") ? "auto-replied" : "auto-generated",
    );
  }
  return {
    teamId: p.teamId,
    inbox,
    accept,
    threadId,
    created: accept.threadId === null,
    headers,
    day,
    recipients: p.recipients,
  };
}

/** Undoes beginInboxAccept when the accept refuses later in the same transaction. */
export async function refundInboxAccept(tx: Db, state: InboxAcceptState): Promise<void> {
  if (state.inbox.domainId === null) await refundSharedRecipients(tx, state);
  const ud = schema.inboxUsageDaily;
  await tx
    .update(ud)
    .set({
      recipients: sql`greatest(0, ${ud.recipients} - ${state.recipients})`,
      newRecipients: sql`greatest(0, ${ud.newRecipients} - ${state.accept.newRecipients.length})`,
    })
    .where(and(eq(ud.inboxId, state.inbox.id), eq(ud.day, state.day)));
  if (state.created) {
    await tx.delete(schema.inboxThreads).where(eq(schema.inboxThreads.id, state.threadId));
  }
}

/** Positional attachment ids, as Resend lists the files of mail an inbox sent. */
export function sentAttachments(
  attachments: readonly EmailAttachment[] | null | undefined,
): ThreadEmailAttachmentWire[] {
  return (attachments ?? []).map((a, i) => ({
    id: String(i),
    filename: a.filename ?? null,
    size: estimateAttachmentBytes([a]),
  }));
}

/**
 * After the email row, in the same transaction: the thread's participants
 * and clock, the inbox's first send, the correspondents (with the burst
 * window of unattended mail), the activity row, and inbox.email.sent, after
 * inbox.thread.created when the send opened its thread.
 */
export async function finishInboxAccept(
  tx: Db,
  state: InboxAcceptState,
  p: {
    email: EmailRow;
    attachments: readonly EmailAttachment[] | undefined;
    actor: InboxActor;
    now: Date;
    enqueue: WebhookEnqueue;
  },
): Promise<void> {
  const { inbox, threadId, accept } = state;
  const { now } = p;
  const keys = [
    ...new Set([...p.email.to, ...(p.email.cc ?? []), ...(p.email.bcc ?? [])].map(addressKey)),
  ];
  const t = schema.inboxThreads;
  await tx
    .update(t)
    .set({
      lastMessageAt: now,
      participants: sql`array(select distinct unnest(${t.participants} || array[${sql.join(
        keys.map((k) => sql`${k}`),
        sql`, `,
      )}]::text[]))`,
    })
    .where(eq(t.id, threadId));
  await tx
    .update(schema.inboxes)
    .set({ firstSentAt: now })
    .where(and(eq(schema.inboxes.id, inbox.id), isNull(schema.inboxes.firstSentAt)));
  const c = schema.inboxCorrespondents;
  const automated = accept.countTowardCap;
  const restart = sql`${c.burstStart} is null or ${c.burstStart} <= ${new Date(now.getTime() - BURST_WINDOW_MS)}`;
  if (keys.length > 0) {
    await tx
      .insert(c)
      .values(
        keys.map((address) => ({
          inboxId: inbox.id,
          address,
          firstOutAt: now,
          lastOutAt: now,
          burstStart: automated ? now : null,
          burstCount: automated ? 1 : 0,
          lastSeenAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [c.inboxId, c.address],
        set: {
          firstOutAt: sql`coalesce(${c.firstOutAt}, excluded.first_out_at)`,
          lastOutAt: sql`excluded.last_out_at`,
          lastSeenAt: sql`excluded.last_seen_at`,
          ...(automated
            ? {
                burstStart: sql`case when ${restart} then excluded.burst_start else ${c.burstStart} end`,
                burstCount: sql`case when ${restart} then 1 else ${c.burstCount} + 1 end`,
              }
            : {}),
        },
      });
  }
  await recordInboxActivity(tx, {
    teamId: state.teamId,
    inboxId: inbox.id,
    actor: p.actor,
    action: "email.sent",
    threadId,
    emailId: p.email.id,
    decision: { result: "send", reasons: automated ? [] : ["approved"] },
  });
  const thread: ThreadSummaryWire | null = state.created
    ? threadSummaryWire(
        { id: threadId, subject: p.email.subject, folder: "sent" },
        { labels: [], read: true, quarantined: 0 },
      )
    : await getThread(tx, { teamId: state.teamId, inboxId: inbox.id, threadId, agentView: false });
  if (!thread) return;
  const email = outboundThreadEmailWire(p.email, {
    html: null,
    text: null,
    attachments: sentAttachments(p.attachments),
  });
  await enqueueTeamWebhookEvents(tx, {
    teamId: state.teamId,
    events: [
      ...(state.created
        ? [
            threadEmailEvent("inbox.thread.created", {
              inboxId: inbox.id,
              thread,
              email,
              occurredAt: now,
            }),
          ]
        : []),
      threadEmailEvent("inbox.email.sent", { inboxId: inbox.id, thread, email, occurredAt: now }),
    ],
    enqueue: p.enqueue,
  });
}

/** Webhook rows written inside a transaction, handed to the queue once it committed. */
export function deferredEnqueue(): {
  enqueue: WebhookEnqueue;
  flush: (to: WebhookEnqueue | undefined) => Promise<void>;
} {
  const rows: QueuedWebhookDelivery[] = [];
  return {
    enqueue: async (batch) => {
      rows.push(...batch);
    },
    flush: async (to) => {
      if (rows.length === 0 || !to) return;
      // The rows are committed; a queue hiccup only delays them to the reconcile sweep.
      await to(rows).catch((err: unknown) => {
        console.warn("inbox webhook enqueue failed; the reconcile sweep will send", err);
      });
    },
  };
}

/** The accept auth an inbox actor sends with; the activity rows still name the actor. */
function acceptAuth(teamId: string, billing: QuotaTeamRow, actor: InboxActor): AcceptEmailAuth {
  return {
    teamId,
    billing,
    apiKeyId: actor.kind === "api_key" ? actor.apiKeyId : null,
    inboxId: actor.kind === "api_key" ? actor.inboxId : null,
  };
}

/** A reply or forward from a person in the dashboard is approved by being theirs; any other caller is an agent. */
const directlyApproved = (actor: InboxActor) => actor.kind === "user";

/** What a held send becomes: the draft kept for a person's approval. */
export interface HoldSpec {
  type: "reply" | "standalone";
  forward: boolean;
  /** The answered or forwarded message. */
  targetId: string | null;
  forwardMode?: "attachment" | undefined;
  /** Sending this existing draft: a hold marks it pending instead of writing another. */
  draftId?: string | undefined;
}

/** One send, ready for the inbox rails and the accept pipeline. */
export interface PreparedSend {
  teamId: string;
  billing: QuotaTeamRow;
  actor: InboxActor;
  /** Null: received mail answered from a plain team address, outside any inbox. */
  inbox: InboxRow | null;
  threadId: string | null;
  from: string;
  domainId: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  html: string | null;
  text: string | null;
  attachments: EmailAttachment[];
  headers: Record<string, string>;
  approved: boolean;
  requiresApproval: boolean;
  replyTarget: { automated: string | null } | null;
  untrustedReplyTo: string[];
  forwardedSecret: boolean;
  hold: HoldSpec;
  now: Date;
}

interface SentContent {
  html: string | null;
  text: string | null;
  attachments: readonly EmailAttachment[];
}

/** A sent email's body and files from their seals; all empty once the content purge ran. */
async function openSentContent(
  deps: Pick<AcceptEmailDeps, "keyring">,
  row: EmailRow,
): Promise<SentContent> {
  const owner = { teamId: row.teamId, rowId: row.id };
  const body =
    row.bodyCiphertext && row.bodyIv && row.bodyWrappedDek && row.bodyKeyVersion !== null
      ? await decryptEmailBody(
          {
            ciphertext: row.bodyCiphertext,
            iv: row.bodyIv,
            wrappedDek: row.bodyWrappedDek,
            keyVersion: row.bodyKeyVersion,
          },
          deps.keyring,
          owner,
        )
      : { html: null, text: null };
  const attachments = row.attachments
    ? await openAttachments(row.attachments, deps.keyring, owner)
    : [];
  return { html: body.html, text: body.text, attachments };
}

/** The SentEmail of an email row; its content read back from the seals unless the caller has it. */
export async function sentEmailOf(
  db: Db,
  deps: Pick<AcceptEmailDeps, "keyring">,
  p: { teamId: string; emailId: string; content?: SentContent },
): Promise<SendOutcome> {
  const [row] = await db
    .select()
    .from(schema.emails)
    .where(and(eq(schema.emails.id, p.emailId), eq(schema.emails.teamId, p.teamId)));
  if (!row) return notFound("Email");
  const content = p.content ?? (await openSentContent(deps, row));
  return {
    kind: "sent",
    email: sentEmailWire(
      row,
      { html: content.html, text: content.text, attachments: sentAttachments(content.attachments) },
      { threadId: row.threadId, inboxId: row.inboxId },
    ),
    threadId: row.threadId,
    inboxId: row.inboxId,
  };
}

/**
 * The rails, then the accept: sent, held as a draft for a person, or
 * refused. Every decision writes its inbox_activity row. `complete` runs in
 * the transaction that records the outcome (an Idempotency-Key's record).
 */
export async function dispatchSend(
  db: Db,
  deps: InboxSendDeps,
  p: PreparedSend,
  opts: {
    complete?: ((tx: Db, recorded: string) => Promise<void>) | undefined;
    /** In the accept transaction after the email row, before inbox.email.sent. */
    onSent?: ((tx: Db, emailId: string, threadId: string | null) => Promise<void>) | undefined;
  } = {},
): Promise<SendOutcome> {
  const recipients = [...p.to, ...p.cc, ...p.bcc];
  if (new Set(recipients.map(addressKey)).size > RECIPIENTS_PER_SEND_MAX) {
    return invalid(`to, cc and bcc together cannot exceed ${RECIPIENTS_PER_SEND_MAX} recipients`);
  }
  if (p.inbox && sharedRecipientsExceeded(p.inbox, recipients)) {
    return { kind: "refused", error: { ...SHARED_REFUSALS.shared_recipients } };
  }
  let accept: InboxAccept | undefined;
  if (p.inbox) {
    const decision = await decideInboxSend(db, deps, {
      teamId: p.teamId,
      billing: p.billing,
      inbox: p.inbox,
      actor: p.actor,
      approved: p.approved,
      requiresApproval: p.requiresApproval,
      threadId: p.threadId,
      recipients,
      untrustedReplyTo: p.untrustedReplyTo,
      replyTarget: p.replyTarget,
      content: { subject: p.subject, html: p.html, text: p.text },
      forwardedSecret: p.forwardedSecret,
      now: p.now,
    });
    if (decision.result === "refuse") {
      await recordInboxActivity(db, {
        teamId: p.teamId,
        inboxId: p.inbox.id,
        actor: p.actor,
        action: "email.refused",
        threadId: p.threadId,
        decision: { result: "refuse", reasons: [decision.name] },
      });
      return {
        kind: "refused",
        error: {
          status: decision.status,
          name: decision.name,
          message: decision.message,
          ...(decision.retryAfterSec !== undefined
            ? { retryAfterSec: decision.retryAfterSec }
            : {}),
        },
      };
    }
    if (decision.result === "draft") {
      const draft = await draftForHeldSend(
        db,
        deps,
        {
          teamId: p.teamId,
          inboxId: p.inbox.id,
          actor: p.actor,
          spec: p.hold,
          threadId: p.threadId,
          to: p.to,
          cc: p.cc,
          bcc: p.bcc,
          subject: p.subject,
          body: { html: p.html, text: p.text },
          reasons: decision.reasons,
          now: p.now,
        },
        opts.complete,
      );
      return { kind: "draft", draft };
    }
    accept = {
      inboxId: p.inbox.id,
      threadId: p.threadId,
      firstContact: decision.firstContact,
      newRecipients: decision.newRecipients,
      countTowardCap: decision.countTowardCap,
    };
  }
  const { complete, onSent } = opts;
  // Keyed on the forwarded message, so that message's history shows the forward.
  const forwarded = p.inbox && p.hold.forward ? p.hold.targetId : null;
  const result = await acceptEmail(
    deps,
    acceptAuth(p.teamId, p.billing, p.actor),
    {
      from: p.from,
      to: p.to,
      cc: p.cc.length > 0 ? p.cc : undefined,
      bcc: p.bcc.length > 0 ? p.bcc : undefined,
      subject: p.subject,
      html: p.html ?? undefined,
      text: p.text ?? undefined,
      headers: Object.keys(p.headers).length > 0 ? p.headers : undefined,
      attachments: p.attachments.length > 0 ? p.attachments : undefined,
      domainId: p.domainId,
      inbox: accept,
    },
    {
      actor: p.actor,
      parkUnderReview: true,
      completeInTx:
        complete || onSent || forwarded
          ? async (tx, emailId) => {
              await complete?.(tx, emailId);
              if (!onSent && !forwarded) return;
              const [row] = await tx
                .select({ threadId: schema.emails.threadId })
                .from(schema.emails)
                .where(eq(schema.emails.id, emailId));
              if (forwarded && p.inbox) {
                await recordInboxActivity(tx, {
                  teamId: p.teamId,
                  inboxId: p.inbox.id,
                  actor: p.actor,
                  action: "email.forwarded",
                  threadId: row?.threadId ?? null,
                  emailId: forwarded,
                });
              }
              await onSent?.(tx, emailId, row?.threadId ?? null);
            }
          : undefined,
    },
  );
  if (!result.ok) return { kind: "refused", error: acceptFailure(result) };
  return sentEmailOf(db, deps, {
    teamId: p.teamId,
    emailId: result.id,
    content: { html: p.html, text: p.text, attachments: p.attachments },
  });
}

// ponytail: per process; a burst of forwards of 40 MiB messages queues here
// instead of in memory. A shared queue if several API replicas forward at once.
const forwardParse = createSemaphore(2);

/** A received message's bodies and files, for a forward; null once the content purge emptied it. */
export async function openReceivedForForward(
  db: Db,
  deps: Pick<AcceptEmailDeps, "keyring">,
  p: { teamId: string; id: string },
): Promise<{
  raw: Buffer;
  html: string | null;
  text: string | null;
  attachments: EmailAttachment[];
  /** X-MillionSend-Forwarded as received: one of our forwards when verifyForwardMarker says so. */
  forwardedBy: string | null;
} | null> {
  const r = schema.receivedEmails;
  const [row] = await db
    .select()
    .from(r)
    .where(and(eq(r.id, p.id), eq(r.teamId, p.teamId)));
  const raw = row ? await openReceivedRaw(row, deps.keyring) : null;
  if (!raw) return null;
  const parsed = await forwardParse(() =>
    simpleParser(raw, {
      skipHtmlToText: true,
      skipTextToHtml: true,
      skipTextLinks: true,
      keepCidLinks: true,
    }),
  );
  const marker = parsed.headers.get("x-millionsend-forwarded");
  return {
    raw,
    html: parsed.html || null,
    text: parsed.text ?? null,
    attachments: parsed.attachments.map((a) => ({
      ...(a.filename ? { filename: a.filename } : {}),
      content: a.content.toString("base64"),
      contentType: a.contentType,
      ...(a.cid ? { contentId: a.cid.replace(/^<|>$/g, "") } : {}),
    })),
    forwardedBy: typeof marker === "string" ? marker : null,
  };
}

/** Why forwarded files may not ride along: the 10 MiB cap, or a file no send may carry. */
export function forwardedFilesProblem(attachments: readonly EmailAttachment[]): string | null {
  if (estimateAttachmentBytes(attachments) > MAX_ATTACHMENT_BYTES) {
    return `Forwarded attachments exceed ${MAX_ATTACHMENT_BYTES / MiB} MiB`;
  }
  for (const a of attachments) {
    const verdict = attachmentVerdict({
      filename: a.filename,
      contentType: a.contentType,
      bytes: Buffer.from(a.content, "base64"),
    });
    if (verdict.action === "reject") return verdict.reason;
  }
  return null;
}

/** A forwarded message's content and files, refused for malware or files no send may carry. */
async function forwardOriginal(
  db: Db,
  deps: Pick<AcceptEmailDeps, "keyring">,
  p: { teamId: string; target: SendTarget; mode: "inline" | "attachment" },
): Promise<
  | { html: string | null; text: string | null; attachments: EmailAttachment[]; attached: boolean }
  | SendOutcome
> {
  const { target } = p;
  if (target.direction === "inbound" && target.row.virusVerdict === "fail") {
    return refused(403, "email_quarantined", "This email carries malware; it can't be forwarded");
  }
  const gone = invalid("This email's content is no longer stored");
  let original: {
    html: string | null;
    text: string | null;
    attachments: EmailAttachment[];
    raw: Buffer | null;
  };
  if (target.direction === "inbound") {
    const opened = await openReceivedForForward(db, deps, { teamId: p.teamId, id: target.row.id });
    if (!opened) return gone;
    original = opened;
  } else {
    const sent = await openSentContent(deps, target.row);
    if (sent.html === null && sent.text === null) return gone;
    original = { ...sent, attachments: [...sent.attachments], raw: null };
  }
  const attached = p.mode === "attachment" && original.raw !== null;
  const attachments: EmailAttachment[] =
    attached && original.raw
      ? [
          {
            filename: "forwarded_message.eml",
            content: original.raw.toString("base64"),
            contentType: "message/rfc822",
          },
        ]
      : original.attachments;
  const problem = forwardedFilesProblem(attachments);
  if (problem) return invalid(problem);
  return { html: original.html, text: original.text, attachments, attached };
}

/** The files a forward carries: the original's, or the original itself as a .eml. */
export async function forwardFiles(
  db: Db,
  deps: Pick<AcceptEmailDeps, "keyring">,
  p: { teamId: string; target: SendTarget; mode: "inline" | "attachment" },
): Promise<EmailAttachment[] | SendOutcome> {
  const original = await forwardOriginal(db, deps, p);
  return isOutcome(original) ? original : original.attachments;
}

/** A mailbox list as written on the wire, normalized; null when an entry is not one address. */
export function mailboxes(value: string | readonly string[] | null | undefined): string[] | null {
  const list =
    value === undefined || value === null ? [] : typeof value === "string" ? [value] : value;
  const out: string[] = [];
  for (const entry of list) {
    const mailbox = parseMailbox(entry);
    if (!mailbox) return null;
    out.push(formatMailbox(mailbox));
  }
  return out;
}

/** Why a subject may not go out: Resend's 1-2000 characters on one line. */
export function subjectProblem(subject: string): string | null {
  if (subject.trim() === "") return "subject must not be empty";
  if (subject.length > 2000) return "subject must be at most 2000 characters";
  if (/[\r\n]/.test(subject)) return "subject must not contain line breaks";
  return null;
}

const hasContent = (v: string | null | undefined) => typeof v === "string" && v.trim() !== "";

/** The inbox's From, with its display name when it has one. */
export const inboxFrom = (inbox: InboxRow) =>
  formatMailbox({ name: inbox.fromName ?? undefined, address: inbox.emailAddress });

/** A message of the inbox's thread, received (with its membership) or sent. */
export async function loadThreadTarget(
  db: Db,
  p: { teamId: string; inboxId: string; threadId: string; emailId: string },
): Promise<SendTarget | null> {
  const m = schema.receivedEmailInboxes;
  const r = schema.receivedEmails;
  const [inbound] = await db
    .select({
      row: RECEIVED_EMAIL_META_COLUMNS,
      senderTrust: m.senderTrust,
      deliveredAt: m.deliveredAt,
      verdict: m.verdict,
    })
    .from(m)
    .innerJoin(r, eq(r.id, m.receivedEmailId))
    .where(
      and(
        eq(m.receivedEmailId, p.emailId),
        eq(m.inboxId, p.inboxId),
        eq(m.threadId, p.threadId),
        eq(r.teamId, p.teamId),
      ),
    );
  if (inbound) return { direction: "inbound", ...inbound };
  const e = schema.emails;
  const [outbound] = await db
    .select()
    .from(e)
    .where(
      and(
        eq(e.id, p.emailId),
        eq(e.teamId, p.teamId),
        eq(e.inboxId, p.inboxId),
        eq(e.threadId, p.threadId),
      ),
    );
  return outbound ? { direction: "outbound", row: outbound } : null;
}

/** An agent's credential never reaches held mail: pending reads as absent, quarantined says so. */
function heldFromAgent(
  actor: InboxActor,
  held: { deliveredAt: Date | null; verdict: ScreeningVerdict } | null,
): SendOutcome | null {
  if (!held || held.deliveredAt !== null || !isAgentActor(actor)) return null;
  return held.verdict === "pending"
    ? notFound("Email")
    : refused(403, "email_quarantined", EMAIL_QUARANTINED_MESSAGE);
}

/** In-Reply-To and References answering `target`. */
export function targetParentHeaders(target: SendTarget): Record<string, string> {
  return replyHeaders(
    target.direction === "inbound"
      ? { messageId: target.row.messageId, references: target.row.references }
      : {
          messageId: target.row.sesMessageId ? sesMessageIdHeader(target.row.sesMessageId) : null,
          references: msgIds(headerValue(target.row.headers, "References")),
        },
  );
}

class IdempotencyTakeover extends Error {}

/**
 * Idempotency-Key for the inbox sends: the stored outcome replays (a held
 * send as "draft:<id>", answered 202 again), a different request under the
 * key conflicts, a refusal frees the key.
 */
export async function withIdempotency(
  db: Db,
  deps: Pick<AcceptEmailDeps, "keyring">,
  p: { teamId: string; key: string | null | undefined; request: unknown },
  run: (
    complete: ((tx: Db, recorded: string) => Promise<void>) | undefined,
  ) => Promise<SendOutcome>,
): Promise<SendOutcome> {
  const { key, teamId } = p;
  if (!key) return run(undefined);
  const bodyHash = canonicalBodyHash(p.request);
  const replay = async (recorded: string): Promise<SendOutcome> => {
    if (!recorded.startsWith("draft:")) return sentEmailOf(db, deps, { teamId, emailId: recorded });
    const draft = await loadDraftWire(db, deps.keyring, { teamId, draftId: recorded.slice(6) });
    return draft ? { kind: "draft", draft } : notFound("Draft");
  };
  const begin = await beginIdempotent(db, { teamId, key, bodyHash });
  if (begin.kind === "replay") {
    const first = begin.emailIds[0];
    return first
      ? replay(first)
      : refused(409, "concurrent_idempotent_requests", "Idempotency record is incomplete");
  }
  if (begin.kind === "conflict") {
    return refused(
      409,
      "invalid_idempotent_request",
      "Idempotency key was used with a different payload",
    );
  }
  if (begin.kind === "in_flight") {
    return refused(
      409,
      "concurrent_idempotent_requests",
      "A request with this idempotency key is still processing",
    );
  }
  const complete = async (tx: Db, recorded: string) => {
    if (!(await completeIdempotent(tx, { teamId, key, emailIds: [recorded] }))) {
      throw new IdempotencyTakeover();
    }
  };
  try {
    const out = await run(complete);
    if (out.kind === "refused") await releaseIdempotent(db, { teamId, key });
    return out;
  } catch (err) {
    if (err instanceof IdempotencyTakeover) {
      const again = await beginIdempotent(db, { teamId, key, bodyHash });
      if (again.kind === "replay" && again.emailIds[0]) return replay(again.emailIds[0]);
      return refused(409, "concurrent_idempotent_requests", "Request superseded by a retry");
    }
    await releaseIdempotent(db, { teamId, key }).catch(() => {});
    throw err;
  }
}

/** A custom-domain inbox's sending domain, verified as POST /emails verifies one; null on the shared domain. */
export async function inboxSendDomain(
  db: Db,
  teamId: string,
  inbox: InboxRow,
): Promise<string | null | SendOutcome> {
  if (inbox.domainId === null) return null;
  const verdict = await verifySenderDomain(db, teamId, inbox.emailAddress);
  if (!verdict.ok) {
    return invalid(`The ${verdict.fromDomain ?? "sender"} domain is not verified for this team`);
  }
  return verdict.domainId;
}

interface ReplyContext {
  teamId: string;
  actor: InboxActor;
  /** Null: received mail answered from a plain team address. */
  inbox: InboxRow | null;
  threadId: string | null;
  target: SendTarget;
  /** What "Re:" or "Fwd:" go in front of when the caller gives no subject. */
  subjectBase: string | null;
  from: string;
  domainId: string | null;
  /** Addresses reply_all never copies. */
  own: string[];
  now: Date;
}

/** A reply to `target`; recipients and threading per Resend. */
function prepareReply(
  c: ReplyContext,
  billing: QuotaTeamRow,
  body: ReplyBody,
): PreparedSend | SendOutcome {
  if (!hasContent(body.html) && !hasContent(body.text)) {
    return invalid("Provide html or text with some content");
  }
  const subject = body.subject ?? replySubject(c.subjectBase);
  const subjectIssue = subjectProblem(subject);
  if (subjectIssue) return invalid(subjectIssue);
  const cc = mailboxes(body.cc);
  const bcc = mailboxes(body.bcc);
  if (!cc || !bcc) return invalid("cc and bcc must be email addresses");
  const { target } = c;
  const recipients = replyRecipients({
    target:
      target.direction === "inbound"
        ? {
            direction: "inbound",
            from: target.row.from,
            replyTo: target.row.replyTo,
            to: target.row.to,
            cc: target.row.cc,
          }
        : { direction: "outbound", to: target.row.to, cc: target.row.cc ?? [] },
    replyAll: body.reply_all === true,
    own: c.own,
    cc,
    bcc,
  });
  if (recipients.to.length === 0) return invalid("The answered email names no one to reply to");
  return {
    teamId: c.teamId,
    billing,
    actor: c.actor,
    inbox: c.inbox,
    threadId: c.threadId,
    from: c.from,
    domainId: c.domainId,
    to: recipients.to,
    cc: recipients.cc,
    bcc: recipients.bcc,
    subject,
    html: body.html ?? null,
    text: body.text ?? null,
    attachments: [],
    headers: targetParentHeaders(target),
    approved: directlyApproved(c.actor),
    requiresApproval: body.requires_approval === true,
    replyTarget: { automated: target.direction === "inbound" ? target.row.automated : null },
    untrustedReplyTo: untrustedReplyTos(target, c.inbox?.domainId === null),
    forwardedSecret: false,
    hold: { type: "reply", forward: false, targetId: target.row.id },
    now: c.now,
  };
}

/** A forward of `target`: the note above the original, or the original attached as a .eml. */
async function prepareForward(
  db: Db,
  deps: InboxSendDeps,
  c: ReplyContext,
  billing: QuotaTeamRow,
  body: ForwardBody & { mode?: "inline" | "attachment" | undefined },
): Promise<PreparedSend | SendOutcome> {
  const to = mailboxes(body.to);
  const cc = mailboxes(body.cc);
  const bcc = mailboxes(body.bcc);
  if (!to || !cc || !bcc) return invalid("to, cc and bcc must be email addresses");
  if (to.length === 0) return invalid("to must name at least one recipient");
  const subject = body.subject ?? forwardSubject(c.subjectBase);
  const subjectIssue = subjectProblem(subject);
  if (subjectIssue) return invalid(subjectIssue);
  const { target } = c;
  const original = await forwardOriginal(db, deps, {
    teamId: c.teamId,
    target,
    mode: body.mode ?? "inline",
  });
  if (isOutcome(original)) return original;
  const note = { html: body.html ?? null, text: body.text ?? null };
  const content = original.attached
    ? { html: note.html, text: note.text ?? (note.html === null ? "" : null) }
    : forwardedMessage(note, {
        from:
          target.direction === "inbound"
            ? formatMailbox({ name: target.row.fromName || undefined, address: target.row.from })
            : target.row.from,
        date: target.row.createdAt,
        subject: target.row.subject === "" ? null : target.row.subject,
        to: target.row.to,
        html: original.html,
        text: original.text,
      });
  return {
    teamId: c.teamId,
    billing,
    actor: c.actor,
    inbox: c.inbox,
    threadId: c.threadId,
    from: c.from,
    domainId: c.domainId,
    to,
    cc,
    bcc,
    subject,
    html: content.html,
    text: content.text,
    attachments: original.attachments,
    headers: {},
    approved: directlyApproved(c.actor),
    requiresApproval: body.requires_approval === true,
    replyTarget: null,
    untrustedReplyTo: [],
    forwardedSecret: target.direction === "inbound" && target.row.extractedKinds.length > 0,
    hold: {
      type: "reply",
      forward: true,
      targetId: target.row.id,
      ...(original.attached ? { forwardMode: "attachment" as const } : {}),
    },
    now: c.now,
  };
}

async function threadSubject(db: Db, threadId: string): Promise<string | null> {
  const [thread] = await db
    .select({ subject: schema.inboxThreads.subject })
    .from(schema.inboxThreads)
    .where(eq(schema.inboxThreads.id, threadId));
  return thread ? thread.subject : null;
}

/** The inbox, thread and answered message of a thread route, as the caller may see them. */
async function threadContext(
  db: Db,
  p: {
    teamId: string;
    actor: InboxActor;
    inboxId: string;
    threadId: string;
    emailId: string;
    now: Date;
  },
): Promise<ReplyContext | SendOutcome> {
  if (p.actor.kind === "api_key" && p.actor.inboxId !== null && p.actor.inboxId !== p.inboxId) {
    return notFound("Inbox");
  }
  const inbox = await findLiveInbox(db, { teamId: p.teamId, inboxId: p.inboxId, now: p.now });
  if (!inbox) return notFound("Inbox");
  const subject = await threadSubject(db, p.threadId);
  if (subject === null) return notFound("Thread");
  const target = await loadThreadTarget(db, p);
  if (!target) return notFound("Email");
  const held = heldFromAgent(p.actor, target.direction === "inbound" ? target : null);
  if (held) return held;
  const domainId = await inboxSendDomain(db, p.teamId, inbox);
  if (isOutcome(domainId)) return domainId;
  return {
    teamId: p.teamId,
    actor: p.actor,
    inbox,
    threadId: p.threadId,
    target,
    subjectBase: subject === "" ? null : subject,
    from: inboxFrom(inbox),
    domainId,
    own: [inbox.emailAddress, ...(inbox.receivingAddress ? [inbox.receivingAddress] : [])],
    now: p.now,
  };
}

export async function replyInThread(
  db: Db,
  deps: InboxSendDeps,
  p: {
    teamId: string;
    billing: QuotaTeamRow;
    actor: InboxActor;
    inboxId: string;
    threadId: string;
    emailId: string;
    body: ReplyBody;
    idempotencyKey?: string | null | undefined;
  },
): Promise<SendOutcome> {
  const request = {
    route: "POST /inboxes/{inbox_id}/threads/{thread_id}/emails/{email_id}/reply",
    params: { inboxId: p.inboxId, threadId: p.threadId, emailId: p.emailId },
    body: p.body,
  };
  return withIdempotency(
    db,
    deps,
    { teamId: p.teamId, key: p.idempotencyKey, request },
    async (complete) => {
      const ctx = await threadContext(db, { ...p, now: new Date() });
      if (isOutcome(ctx)) return ctx;
      const prepared = prepareReply(ctx, p.billing, p.body);
      return isOutcome(prepared) ? prepared : dispatchSend(db, deps, prepared, { complete });
    },
  );
}

export async function forwardInThread(
  db: Db,
  deps: InboxSendDeps,
  p: {
    teamId: string;
    billing: QuotaTeamRow;
    actor: InboxActor;
    inboxId: string;
    threadId: string;
    emailId: string;
    body: ForwardBody;
    idempotencyKey?: string | null | undefined;
  },
): Promise<SendOutcome> {
  const request = {
    route: "POST /inboxes/{inbox_id}/threads/{thread_id}/emails/{email_id}/forward",
    params: { inboxId: p.inboxId, threadId: p.threadId, emailId: p.emailId },
    body: p.body,
  };
  return withIdempotency(
    db,
    deps,
    { teamId: p.teamId, key: p.idempotencyKey, request },
    async (complete) => {
      const ctx = await threadContext(db, { ...p, now: new Date() });
      if (isOutcome(ctx)) return ctx;
      const prepared = await prepareForward(db, deps, ctx, p.billing, p.body);
      return isOutcome(prepared) ? prepared : dispatchSend(db, deps, prepared, { complete });
    },
  );
}

/**
 * Where an answer to received mail goes out from: the inbox of a membership
 * (the caller's, the one asked for, the one `from` names, else the first),
 * or, for catch-all mail, a plain address of the team with no inbox rails
 * unless that address is an inbox's.
 */
async function receivedContext(
  db: Db,
  p: {
    teamId: string;
    actor: InboxActor;
    receivedEmailId: string;
    from: string | undefined;
    inboxId: string | undefined;
    now: Date;
  },
): Promise<ReplyContext | SendOutcome> {
  const r = schema.receivedEmails;
  const [row] = await db
    .select(RECEIVED_EMAIL_META_COLUMNS)
    .from(r)
    .where(and(eq(r.id, p.receivedEmailId), eq(r.teamId, p.teamId)));
  if (!row) return notFound("Email");
  const fromAddress = p.from ? parseSingleSender(p.from)?.address.toLowerCase() : undefined;
  if (p.from && !fromAddress) {
    return invalid(
      'from must be a single address like ada@example.com or "Ada Lovelace" <ada@example.com>',
    );
  }
  const m = schema.receivedEmailInboxes;
  const i = schema.inboxes;
  const memberships = await db
    .select({
      inboxId: m.inboxId,
      threadId: m.threadId,
      senderTrust: m.senderTrust,
      deliveredAt: m.deliveredAt,
      verdict: m.verdict,
      emailAddress: i.emailAddress,
    })
    .from(m)
    .innerJoin(i, eq(i.id, m.inboxId))
    .where(and(eq(m.receivedEmailId, row.id), eq(m.teamId, p.teamId)))
    .orderBy(asc(i.createdAt));
  const scoped = p.actor.kind === "api_key" ? p.actor.inboxId : null;
  const wanted =
    scoped ?? p.inboxId ?? memberships.find((x) => x.emailAddress === fromAddress)?.inboxId;
  const membership = wanted
    ? memberships.find((x) => x.inboxId === wanted)
    : (memberships.find((x) => x.deliveredAt !== null) ?? memberships[0]);
  if (scoped && !membership) return notFound("Email");
  if (p.inboxId && !membership) return notFound("Inbox");
  const held = heldFromAgent(p.actor, membership ?? null);
  if (held) return held;
  const virusHeld = row.catchAll && row.virusVerdict === "fail" && row.releasedAt === null;
  if (!membership && virusHeld && isAgentActor(p.actor)) {
    return refused(403, "email_quarantined", EMAIL_QUARANTINED_MESSAGE);
  }
  if (membership && (!fromAddress || fromAddress === membership.emailAddress)) {
    const inbox = await findLiveInbox(db, {
      teamId: p.teamId,
      inboxId: membership.inboxId,
      now: p.now,
    });
    if (!inbox) return notFound("Inbox");
    const domainId = await inboxSendDomain(db, p.teamId, inbox);
    if (isOutcome(domainId)) return domainId;
    return {
      teamId: p.teamId,
      actor: p.actor,
      inbox,
      threadId: membership.threadId,
      target: {
        direction: "inbound",
        row,
        senderTrust: membership.senderTrust,
        deliveredAt: membership.deliveredAt,
        verdict: membership.verdict,
      },
      subjectBase: row.subject === "" ? null : row.subject,
      from: inboxFrom(inbox),
      domainId,
      own: [inbox.emailAddress, ...(inbox.receivingAddress ? [inbox.receivingAddress] : [])],
      now: p.now,
    };
  }
  const from = p.from ?? row.receivedFor[0];
  if (!from) return invalid("This email names no address to answer from; set from");
  const verdict = await verifySenderDomain(db, p.teamId, from);
  if (!verdict.ok) {
    return invalid(`The ${verdict.fromDomain ?? "sender"} domain is not verified for this team`);
  }
  return {
    teamId: p.teamId,
    actor: p.actor,
    inbox: null,
    threadId: null,
    target: {
      direction: "inbound",
      row,
      senderTrust: row.senderTrust,
      deliveredAt: row.createdAt,
      verdict: "clean",
    },
    subjectBase: row.subject === "" ? null : row.subject,
    from,
    domainId: verdict.domainId,
    own: [from, ...row.receivedFor],
    now: p.now,
  };
}

export async function replyToReceivedEmail(
  db: Db,
  deps: InboxSendDeps,
  p: {
    teamId: string;
    billing: QuotaTeamRow;
    actor: InboxActor;
    receivedEmailId: string;
    body: ReplyBody & { from?: string | undefined; inbox_id?: string | undefined };
    idempotencyKey?: string | null | undefined;
  },
): Promise<SendOutcome> {
  const request = {
    route: "POST /emails/receiving/{id}/reply",
    params: { id: p.receivedEmailId },
    body: p.body,
  };
  return withIdempotency(
    db,
    deps,
    { teamId: p.teamId, key: p.idempotencyKey, request },
    async (complete) => {
      const ctx = await receivedContext(db, {
        ...p,
        from: p.body.from,
        inboxId: p.body.inbox_id,
        now: new Date(),
      });
      if (isOutcome(ctx)) return ctx;
      const prepared = prepareReply(ctx, p.billing, p.body);
      return isOutcome(prepared) ? prepared : dispatchSend(db, deps, prepared, { complete });
    },
  );
}

export async function forwardReceivedEmail(
  db: Db,
  deps: InboxSendDeps,
  p: {
    teamId: string;
    billing: QuotaTeamRow;
    actor: InboxActor;
    receivedEmailId: string;
    body: ForwardBody & {
      from?: string | undefined;
      inbox_id?: string | undefined;
      mode?: "inline" | "attachment" | undefined;
    };
    idempotencyKey?: string | null | undefined;
  },
): Promise<SendOutcome> {
  const request = {
    route: "POST /emails/receiving/{id}/forward",
    params: { id: p.receivedEmailId },
    body: p.body,
  };
  return withIdempotency(
    db,
    deps,
    { teamId: p.teamId, key: p.idempotencyKey, request },
    async (complete) => {
      const ctx = await receivedContext(db, {
        ...p,
        from: p.body.from,
        inboxId: p.body.inbox_id,
        now: new Date(),
      });
      if (isOutcome(ctx)) return ctx;
      const prepared = await prepareForward(db, deps, ctx, p.billing, p.body);
      return isOutcome(prepared) ? prepared : dispatchSend(db, deps, prepared, { complete });
    },
  );
}

/** A new conversation from an inbox (the dashboard's Send email); a shared address starts one in open mode only. */
export async function sendNewFromInbox(
  db: Db,
  deps: InboxSendDeps,
  p: {
    teamId: string;
    billing: QuotaTeamRow;
    actor: InboxActor;
    inboxId: string;
    message: {
      to: string[];
      cc?: string[] | undefined;
      bcc?: string[] | undefined;
      subject: string;
      html?: string | undefined;
      text?: string | undefined;
    };
    requiresApproval?: boolean | undefined;
  },
): Promise<SendOutcome> {
  const now = new Date();
  const inbox = await findLiveInbox(db, { teamId: p.teamId, inboxId: p.inboxId, now });
  if (!inbox) return notFound("Inbox");
  const { message } = p;
  const to = mailboxes(message.to);
  const cc = mailboxes(message.cc);
  const bcc = mailboxes(message.bcc);
  if (!to || !cc || !bcc) return invalid("to, cc and bcc must be email addresses");
  if (to.length === 0) return invalid("to must name at least one recipient");
  const subjectIssue = subjectProblem(message.subject);
  if (subjectIssue) return invalid(subjectIssue);
  if (!hasContent(message.html) && !hasContent(message.text)) {
    return invalid("Provide html or text with some content");
  }
  const domainId = await inboxSendDomain(db, p.teamId, inbox);
  if (isOutcome(domainId)) return domainId;
  return dispatchSend(db, deps, {
    teamId: p.teamId,
    billing: p.billing,
    actor: p.actor,
    inbox,
    threadId: null,
    from: inboxFrom(inbox),
    domainId,
    to,
    cc,
    bcc,
    subject: message.subject,
    html: message.html ?? null,
    text: message.text ?? null,
    attachments: [],
    headers: {},
    approved: directlyApproved(p.actor),
    requiresApproval: p.requiresApproval === true,
    replyTarget: null,
    untrustedReplyTo: [],
    forwardedSecret: false,
    hold: { type: "standalone", forward: false, targetId: null },
    now,
  });
}

/** A forward_to copy the shared domain holds back for now: the job runs again at `until`. */
export type ForwardWait = { kind: "wait"; until: Date };

/**
 * The inbox.forward job: a delivered message passed on, inline, to the
 * inbox's forward_to owners, approved (the owners chose them). Null when
 * there is nothing to forward: not delivered, no live target, malware, the
 * content purged, or a message that is already one of our forwards, which
 * stops two inboxes forwarding to each other after one hop. A copy the
 * shared domain holds back (sending paused, or the team past today's cap)
 * waits until FORWARD_WAIT_MAX after delivery; past that, the refusal is final.
 */
export async function forwardToForwardTargets(
  db: Db,
  deps: InboxSendDeps,
  job: { receivedEmailId: string; inboxId: string },
): Promise<SendOutcome | ForwardWait | null> {
  const now = new Date();
  const m = schema.receivedEmailInboxes;
  const [membership] = await db
    .select()
    .from(m)
    .where(and(eq(m.receivedEmailId, job.receivedEmailId), eq(m.inboxId, job.inboxId)));
  if (!membership || membership.deliveredAt === null) return null;
  const { teamId } = membership;
  const inbox = await findLiveInbox(db, { teamId, inboxId: job.inboxId });
  if (!inbox || inbox.safety.forward_to.length === 0) return null;
  const shared = inbox.domainId === null;
  // Safety was valid when saved; a member may have left the team since. The
  // shared domain forwards to members' logins only, as safetyProblem saves.
  const owners = new Set([
    ...(await teamMemberEmails(db, teamId)),
    ...(shared ? [] : inbox.safety.owner_addresses.map(addressKey)),
  ]);
  const targets = inbox.safety.forward_to.filter((a) => owners.has(addressKey(a)));
  if (targets.length === 0) return null;
  const r = schema.receivedEmails;
  const [row] = await db
    .select(RECEIVED_EMAIL_META_COLUMNS)
    .from(r)
    .where(and(eq(r.id, job.receivedEmailId), eq(r.teamId, teamId)));
  if (!row || row.virusVerdict === "fail") return null;
  const deadline = membership.deliveredAt.getTime() + FORWARD_WAIT_MAX;
  const waitFor = (ms: number): ForwardWait | null =>
    now.getTime() + ms <= deadline ? { kind: "wait", until: new Date(now.getTime() + ms) } : null;
  // Read ahead of the content, so a held copy costs no decrypt and leaves no
  // refusal row each time it looks; past the deadline the send below refuses it.
  // ponytail: each held copy polls every SHARED_PAUSED_RETRY_MS until the
  // deadline; re-arm held copies when the switch turns on if long pauses make that count.
  if (shared && !(await instanceSettings(db, deps)).sharedInboxSend) {
    const wait = waitFor(SHARED_PAUSED_RETRY_MS);
    if (wait) return wait;
  }
  const opened = await openReceivedForForward(db, deps, { teamId, id: row.id });
  if (
    !opened ||
    (opened.forwardedBy !== null && verifyForwardMarker(deps.inboxKeys, opened.forwardedBy))
  ) {
    return null;
  }
  const domainId = await inboxSendDomain(db, teamId, inbox);
  if (isOutcome(domainId)) return domainId;
  const [billing] = await db
    .select(QUOTA_COLUMNS)
    .from(schema.teams)
    .where(eq(schema.teams.id, teamId));
  if (!billing) return null;
  const content = forwardedMessage(
    { html: null, text: null },
    {
      from: formatMailbox({ name: row.fromName || undefined, address: row.from }),
      date: row.createdAt,
      subject: row.subject === "" ? null : row.subject,
      to: row.to,
      html: opened.html,
      text: opened.text,
    },
  );
  const system: InboxActor = { kind: "system" };
  const out = await dispatchSend(db, deps, {
    teamId,
    billing,
    actor: system,
    inbox,
    threadId: membership.threadId,
    from: inboxFrom(inbox),
    domainId,
    to: targets,
    cc: [],
    bcc: [],
    subject: forwardSubject(row.subject === "" ? null : row.subject),
    html: content.html,
    text: content.text,
    // ponytail: files past the cap or refused stay behind; the owner opens
    // the original in the dashboard. A link to it if owners ask for the files.
    attachments: forwardedFilesProblem(opened.attachments) === null ? opened.attachments : [],
    headers: {
      "X-MillionSend-Forwarded": forwardMarker(deps.inboxKeys, inbox.id),
      ...(inbox.kind === "agent" ? { "Auto-Submitted": "auto-generated" } : {}),
    },
    approved: true,
    requiresApproval: false,
    replyTarget: null,
    untrustedReplyTo: [],
    forwardedSecret: false,
    hold: { type: "reply", forward: true, targetId: row.id },
    now,
  });
  // A refusal with a retry-after (the team's daily shared-domain cap) clears with the day.
  if (out.kind === "refused" && out.error.retryAfterSec !== undefined) {
    return waitFor(out.error.retryAfterSec * 1000) ?? out;
  }
  return out;
}

/**
 * The sending domain an answer to received mail would go out from, as the
 * reply and forward resolve it (null: the shared domain), so a
 * domain-scoped key can be held to its domain before anything is sent.
 */
export async function receivedAnswerDomain(
  db: Db,
  p: {
    teamId: string;
    actor: InboxActor;
    receivedEmailId: string;
    from: string | undefined;
    inboxId: string | undefined;
  },
): Promise<string | null | SendOutcome> {
  const ctx = await receivedContext(db, { ...p, now: new Date() });
  return isOutcome(ctx) ? ctx : ctx.domainId;
}
