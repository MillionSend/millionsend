import type { Db } from "@millionsend/db";
import type { Keyring } from "../crypto/keyring.js";
import type { QuotaTeamRow } from "../plans.js";
import type { InboxActor } from "./activity.js";
import type { InboxSendDeps, SendOutcome } from "./send.js";
import type { DraftListItemWire, DraftWire, InboxError, ListQuery } from "./types.js";

export async function createDraft(
  _db: Db,
  _deps: InboxSendDeps,
  _p: {
    teamId: string;
    inboxId: string;
    actor: InboxActor;
    input: {
      to?: string | string[] | null | undefined;
      cc?: string | string[] | null | undefined;
      bcc?: string | string[] | null | undefined;
      subject?: string | null | undefined;
      html?: string | null | undefined;
      text?: string | null | undefined;
      thread_id?: string | undefined;
      reply_to_email_id?: string | undefined;
    };
  },
): Promise<{ ok: true; draft: DraftWire; created: boolean } | { ok: false; error: InboxError }> {
  throw new Error("INBOX_CONTRACT_STUB");
}

export async function listDrafts(
  _db: Db,
  _p: { teamId: string; inboxId: string; query: ListQuery },
): Promise<{ data: DraftListItemWire[]; hasMore: boolean } | "bad_cursor"> {
  throw new Error("INBOX_CONTRACT_STUB");
}

export async function getDraft(
  _db: Db,
  _keyring: Keyring,
  _p: { teamId: string; inboxId: string; draftId: string },
): Promise<DraftWire | null> {
  throw new Error("INBOX_CONTRACT_STUB");
}

export async function updateDraft(
  _db: Db,
  _deps: InboxSendDeps,
  _p: {
    teamId: string;
    inboxId: string;
    draftId: string;
    actor: InboxActor;
    patch: Record<string, unknown>;
  },
): Promise<{ ok: true; draft: DraftWire } | { ok: false; error: InboxError }> {
  throw new Error("INBOX_CONTRACT_STUB");
}

export async function deleteDraft(
  _db: Db,
  _deps: InboxSendDeps,
  _p: { teamId: string; inboxId: string; draftId: string; actor: InboxActor },
): Promise<{ ok: true } | { ok: false; error: InboxError }> {
  throw new Error("INBOX_CONTRACT_STUB");
}

export async function sendDraft(
  _db: Db,
  _deps: InboxSendDeps,
  _p: {
    teamId: string;
    billing: QuotaTeamRow;
    actor: InboxActor;
    inboxId: string;
    draftId: string;
    idempotencyKey?: string | null | undefined;
  },
): Promise<SendOutcome> {
  throw new Error("INBOX_CONTRACT_STUB");
}

export async function rejectDraft(
  _db: Db,
  _deps: InboxSendDeps,
  _p: { teamId: string; inboxId: string; draftId: string; actor: InboxActor },
): Promise<{ ok: true; draft: DraftWire } | { ok: false; error: InboxError }> {
  throw new Error("INBOX_CONTRACT_STUB");
}

export async function expireDrafts(_db: Db, _deps: InboxSendDeps, _now: Date): Promise<number> {
  throw new Error("INBOX_CONTRACT_STUB");
}
