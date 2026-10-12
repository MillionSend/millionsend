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

/** The one send decision for mail from an agent-inbox or shared-domain address, on every surface. */
export function decideAgentSend(_input: AgentSendInput): AgentSendDecision {
  throw new Error("INBOX_CONTRACT_STUB");
}
