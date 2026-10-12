import { parseSingleSender } from "../sender-address.js";
import { DAY_MS, nextUtcDayStart } from "../utc-day.js";
import type { InboxActor } from "./activity.js";
import type { InboxSafety } from "./safety.js";
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
  usage: { recipientsToday: number; newRecipientsToday: number };
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
    };

export const INBOX_KEY_FROM_MESSAGE = "This API key can only send from its inbox address";

export const SHARED_REPLY_ONLY_MESSAGE =
  "Addresses on the shared domain only reply inside their threads";

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
  if (inbox.shared && (!input.isReply || !recipients.every(trusted))) {
    return {
      result: "refuse",
      status: 403,
      name: "inbox_send_policy",
      message: SHARED_REPLY_ONLY_MESSAGE,
    };
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
    // "open" stands only for a custom-domain inbox of an established team;
    // otherwise it reads as reply_only.
    const policy =
      safety.send_policy === "open" && (inbox.shared || input.teamTierNew)
        ? "reply_only"
        : safety.send_policy;
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

/** An allowlist entry `local@domain` matches exactly; `*@domain` the domain and its subdomains. */
export function allowlistIncludes(allowlist: readonly string[], address: string): boolean {
  const a = address.toLowerCase();
  const domain = a.slice(a.lastIndexOf("@") + 1);
  return allowlist.some((entry) => {
    const e = entry.toLowerCase();
    if (!e.startsWith("*@")) return e === a;
    const d = e.slice(2);
    return domain === d || domain.endsWith(`.${d}`);
  });
}
