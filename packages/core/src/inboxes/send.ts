import type { Db } from "@millionsend/db";
import type { AcceptEmailDeps } from "../accept-email.js";
import type { QuotaTeamRow } from "../plans.js";
import type { WebhookEnqueue } from "../webhooks.js";
import type { InboxActor } from "./activity.js";
import type { InboxKeys } from "./keys.js";
import type { DraftWire, InboxError, SentEmailWire } from "./types.js";

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

export async function replyInThread(
  _db: Db,
  _deps: InboxSendDeps,
  _p: {
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
  throw new Error("INBOX_CONTRACT_STUB");
}

export async function forwardInThread(
  _db: Db,
  _deps: InboxSendDeps,
  _p: {
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
  throw new Error("INBOX_CONTRACT_STUB");
}

export async function replyToReceivedEmail(
  _db: Db,
  _deps: InboxSendDeps,
  _p: {
    teamId: string;
    billing: QuotaTeamRow;
    actor: InboxActor;
    receivedEmailId: string;
    body: ReplyBody & { from?: string | undefined; inbox_id?: string | undefined };
    idempotencyKey?: string | null | undefined;
  },
): Promise<SendOutcome> {
  throw new Error("INBOX_CONTRACT_STUB");
}

export async function forwardReceivedEmail(
  _db: Db,
  _deps: InboxSendDeps,
  _p: {
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
  throw new Error("INBOX_CONTRACT_STUB");
}

export async function sendNewFromInbox(
  _db: Db,
  _deps: InboxSendDeps,
  _p: {
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
  throw new Error("INBOX_CONTRACT_STUB");
}
