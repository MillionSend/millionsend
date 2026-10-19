import { parseSingleSender } from "../sender-address.js";
import { DAY_MS, nextUtcDayStart } from "../utc-day.js";
import type { InboxActor } from "./activity.js";
import type { InboxSafety } from "./safety.js";
import type { SharedSending } from "./shared-mode.js";
import type { InboxKind } from "./types.js";

/**
 * owner: member logins and owner_addresses; allowlisted: an allowlist match;
 * thread: the From (or trusted Reply-To) of a delivered inbound message in
 * the thread; known: an inbox_correspondents row; new otherwise.
 */
export type RecipientClass = "owner" | "allowlisted" | "thread" | "known" | "new";

export interface AgentSendInput {
  inbox: {
    id: string;
    kind: InboxKind;
    shared: boolean;
    safety: InboxSafety;
    firstSentAt: Date | null;
  };
  teamTierNew: boolean;
  /** Read for a shared inbox only, as are sharedNamesOk and sharedTeamCap. */
  sharedMode: SharedSending;
  /** The inbox's from_name and the team's label pass the brand guard. */
  sharedNamesOk: boolean;
  /** Recipients the team may reach from the shared domain per UTC day. */
  sharedTeamCap: number;
  actor: InboxActor;
  /** canApprove(actor) acting through the dashboard, or an approval. */
  approved: boolean;
  /** The request's requires_approval flag. */
  requiresApproval: boolean;
  /** In an existing, resolved thread. */
  isReply: boolean;
  /** Bcc included; +tag addresses as written. */
  recipients: { address: string; cls: RecipientClass; viaUntrustedReplyTo: boolean }[];
  replyTarget: { automated: string | null } | null;
  /** More than 10 automated sends to one address within 60 minutes. */
  burstExceeded: boolean;
  /** Outgoing content matched a received secret within RECEIVED_SECRET_WINDOW. */
  privateHit: boolean;
  /** sharedRecipientsToday is the team's, from every shared inbox. */
  usage: { recipientsToday: number; newRecipientsToday: number; sharedRecipientsToday: number };
  now: Date;
}

export type AgentSendDecision =
  | { result: "send"; firstContact: boolean; newRecipients: string[]; countTowardCap: boolean }
  | { result: "draft"; reasons: string[] }
  | {
      result: "refuse";
      status: 403 | 429;
      name: "inbox_send_policy" | "inbox_send_cap_reached" | "restricted_api_key";
      message: string;
      retryAfterSec?: number | undefined;
      /** The shared-domain rule that refused, when one did. */
      reason?: Exclude<SharedRefusalReason, "shared_recipients"> | undefined;
    };

export const INBOX_KEY_FROM_MESSAGE = "This API key can only send from its inbox address";

export const SHARED_REPLY_ONLY_MESSAGE =
  "Addresses on the shared domain only reply inside their threads";

/** To, cc and bcc together, per email from a shared-domain address. */
export const SHARED_RECIPIENTS_MAX = 10;

/** Each cause the shared domain refuses a send for, with its answer on every surface. */
export const SHARED_REFUSALS = {
  shared_paused: {
    status: 403,
    name: "inbox_send_policy",
    message: "Sending from addresses on the shared domain is paused; mail to them still arrives",
  },
  shared_plan: {
    status: 403,
    name: "inbox_send_policy",
    message: "On the Free plan, addresses on the shared domain only reply inside their threads",
  },
  shared_domain: { status: 403, name: "inbox_send_policy", message: SHARED_REPLY_ONLY_MESSAGE },
  shared_team_cap: {
    status: 429,
    name: "inbox_send_cap_reached",
    message: "Your team reached today's limit for mail from the shared domain",
  },
  shared_recipients: {
    status: 422,
    name: "validation_error",
    message: `At most ${SHARED_RECIPIENTS_MAX} recipients per email from the shared domain`,
  },
} as const;

export type SharedRefusalReason = keyof typeof SHARED_REFUSALS;

/**
 * The refusal of a send the team's shared-domain mode doesn't allow. Open
 * mode answers shared_domain: only the inbox's own names hold it back then.
 */
export function sharedModeReason(
  s: SharedSending,
): "shared_paused" | "shared_plan" | "shared_domain" {
  if (s.mode === "receive_only") return "shared_paused";
  return s.cause === "plan" ? "shared_plan" : "shared_domain";
}

function sharedRefusal(
  reason: Exclude<SharedRefusalReason, "shared_recipients">,
  now: Date,
): AgentSendDecision {
  const { status, name, message } = SHARED_REFUSALS[reason];
  return {
    result: "refuse",
    status,
    name,
    message,
    reason,
    ...(reason === "shared_team_cap" ? { retryAfterSec: secondsToNextUtcDay(now) } : {}),
  };
}

/** retry-after for a daily limit: whole seconds until the next UTC midnight, at least one. */
export function secondsToNextUtcDay(now: Date): number {
  return Math.max(1, Math.ceil((nextUtcDayStart(now).getTime() - now.getTime()) / 1000));
}

/** New recipients an inbox may write to on day `d` of its sending: 10, 20, 40, 80… */
export function rampLimit(firstSentAt: Date | null, now: Date): number {
  const days = firstSentAt
    ? Math.max(0, Math.floor((now.getTime() - firstSentAt.getTime()) / DAY_MS))
    : 0;
  return 10 * 2 ** days;
}

/** The one send decision for mail from an agent-inbox or shared-domain address, on every surface. */
export function decideAgentSend(input: AgentSendInput): AgentSendDecision {
  const { inbox, actor, recipients, now } = input;
  const { safety } = inbox;
  if (actor.kind === "api_key" && actor.inboxId !== null && actor.inboxId !== inbox.id) {
    return {
      result: "refuse",
      status: 403,
      name: "restricted_api_key",
      message: INBOX_KEY_FROM_MESSAGE,
    };
  }
  const trusted = (r: (typeof recipients)[number]) =>
    r.cls === "owner" || r.cls === "allowlisted" || r.cls === "thread";
  const ownerOrAllowlisted = (r: (typeof recipients)[number]) =>
    r.cls === "owner" || r.cls === "allowlisted";
  // Ahead of `approved`: the shared domain's rules bind people too.
  if (inbox.shared) {
    const { sharedMode } = input;
    // Names that fail the brand guard were never reviewed, so they keep the inbox replying only.
    const replyOnly = sharedMode.mode !== "open" || !input.sharedNamesOk;
    if (
      sharedMode.mode === "receive_only" ||
      (replyOnly && (!input.isReply || !recipients.every(trusted)))
    ) {
      return sharedRefusal(sharedModeReason(sharedMode), now);
    }
    if (input.usage.sharedRecipientsToday + recipients.length > input.sharedTeamCap) {
      return sharedRefusal("shared_team_cap", now);
    }
  }
  if (
    !input.approved &&
    safety.send_cap !== null &&
    input.usage.recipientsToday + recipients.length > safety.send_cap
  ) {
    return {
      result: "refuse",
      status: 429,
      name: "inbox_send_cap_reached",
      message: "This inbox reached its daily send limit",
      retryAfterSec: secondsToNextUtcDay(now),
    };
  }
  const reasons: string[] = [];
  const unattended = !input.approved && inbox.kind === "agent";
  const fresh = recipients.filter((r) => r.cls === "new");
  if (unattended) {
    if (input.replyTarget?.automated) reasons.push(`loop_guard:${input.replyTarget.automated}`);
    if (input.burstExceeded) reasons.push("loop_burst");
    if (recipients.some((r) => r.viaUntrustedReplyTo)) reasons.push("reply_to_redirect");
    // "open" stands only for an established team; a new one's reads as reply_only.
    const policy =
      safety.send_policy === "open" && input.teamTierNew ? "reply_only" : safety.send_policy;
    const replyOk = input.isReply && recipients.every(trusted);
    const allowed =
      policy === "open" ||
      replyOk ||
      (policy === "allowlist" && recipients.every(ownerOrAllowlisted));
    if (!allowed) reasons.push("send_policy");
    if (safety.private_codes && input.privateHit && !recipients.every(ownerOrAllowlisted)) {
      reasons.push("private_code");
    }
    if (
      fresh.length > 0 &&
      input.usage.newRecipientsToday + fresh.length >
        Math.min(safety.send_cap ?? Number.POSITIVE_INFINITY, rampLimit(inbox.firstSentAt, now))
    ) {
      reasons.push("ramp");
    }
    if (safety.require_approval) reasons.push("require_approval");
    if (input.requiresApproval) reasons.push("approval_required");
  }
  if (reasons.length > 0) return { result: "draft", reasons };
  return {
    result: "send",
    firstContact: fresh.length > 0,
    newRecipients: fresh.map((r) => r.address),
    countTowardCap: !input.approved,
  };
}

/** Whether `from` is an address on SHARED_INBOX_DOMAIN or one of its subdomains. */
export function isSharedInboxSender(
  from: string,
  sharedDomain: string | null | undefined,
): boolean {
  if (!sharedDomain) return false;
  const domain = parseSingleSender(from)?.domain;
  return domain !== undefined && (domain === sharedDomain || domain.endsWith(`.${sharedDomain}`));
}
