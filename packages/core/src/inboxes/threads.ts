import type { Db } from "@millionsend/db";
import type { Keyring } from "../crypto/keyring.js";
import type { InboxActor } from "./activity.js";
import type { InboxDeps } from "./inboxes.js";
import type {
  InboxError,
  ListQuery,
  MoveFolder,
  ThreadEmailWire,
  ThreadFolder,
  ThreadListItemWire,
  ThreadSearchResultWire,
  ThreadSummaryWire,
} from "./types.js";

export interface ThreadListQuery {
  folders?: ThreadFolder[] | undefined;
  labels?: string[] | undefined;
  read?: boolean | undefined;
  limit?: number | undefined;
  after?: string | undefined;
  before?: string | undefined;
  /** Owner views only: threads whose messages are all held. */
  includeHeld?: boolean | undefined;
}

export interface ThreadSearchQuery extends ThreadListQuery {
  query?: string | undefined;
  from?: string[] | undefined;
  to?: string[] | undefined;
  cc?: string[] | undefined;
  bcc?: string[] | undefined;
  hasAttachment?: boolean | undefined;
  startDate?: string | undefined;
  endDate?: string | undefined;
}

export async function listThreads(
  _db: Db,
  _p: { teamId: string; inboxId: string; query: ThreadListQuery; agentView: boolean },
): Promise<{ data: ThreadListItemWire[]; hasMore: boolean } | { error: InboxError }> {
  throw new Error("INBOX_CONTRACT_STUB");
}

export async function searchThreads(
  _db: Db,
  _p: { teamId: string; inboxId: string; query: ThreadSearchQuery; agentView: boolean },
): Promise<{ data: ThreadSearchResultWire[]; hasMore: boolean } | { error: InboxError }> {
  throw new Error("INBOX_CONTRACT_STUB");
}

export async function getThread(
  _db: Db,
  _p: { teamId: string; inboxId: string; threadId: string; agentView: boolean },
): Promise<ThreadSummaryWire | null> {
  throw new Error("INBOX_CONTRACT_STUB");
}

export async function updateThread(
  _db: Db,
  _deps: InboxDeps,
  _p: {
    teamId: string;
    inboxId: string;
    threadId: string;
    actor: InboxActor;
    read?: boolean | undefined;
    folder?: MoveFolder | undefined;
    labelId?: string | undefined;
    /** The dashboard's removal; the API cannot remove labels (Resend). */
    removeLabelId?: string | undefined;
  },
): Promise<{ ok: true; thread: ThreadSummaryWire } | { ok: false; error: InboxError }> {
  throw new Error("INBOX_CONTRACT_STUB");
}

export async function trashThread(
  _db: Db,
  _deps: InboxDeps,
  _p: { teamId: string; inboxId: string; threadId: string; actor: InboxActor },
): Promise<{ ok: true; deleted: boolean } | { ok: false; error: InboxError }> {
  throw new Error("INBOX_CONTRACT_STUB");
}

export async function purgeTrashedThreads(_db: Db, _now: Date): Promise<number> {
  throw new Error("INBOX_CONTRACT_STUB");
}

export async function listThreadEmails(
  _db: Db,
  _keyring: Keyring,
  _p: {
    teamId: string;
    inboxId: string;
    threadId: string;
    query: ListQuery;
    agentView: boolean;
    includeHeld: boolean;
    /** Support view: metadata only, never content. */
    envelopeOnly?: boolean | undefined;
  },
): Promise<{ data: ThreadEmailWire[]; hasMore: boolean } | { error: InboxError }> {
  throw new Error("INBOX_CONTRACT_STUB");
}

export async function getThreadEmail(
  _db: Db,
  _keyring: Keyring,
  _p: {
    teamId: string;
    inboxId: string;
    threadId: string;
    emailId: string;
    agentView: boolean;
    includeHeld: boolean;
    envelopeOnly?: boolean | undefined;
  },
): Promise<ThreadEmailWire | { error: InboxError }> {
  throw new Error("INBOX_CONTRACT_STUB");
}
