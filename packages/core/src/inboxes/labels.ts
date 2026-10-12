import type { Db } from "@millionsend/db";
import type { InboxActor } from "./activity.js";
import type { InboxDeps } from "./inboxes.js";
import type { InboxError, LabelWire } from "./types.js";

export async function listLabels(
  _db: Db,
  _p: { teamId: string; inboxId: string },
): Promise<LabelWire[]> {
  throw new Error("INBOX_CONTRACT_STUB");
}

export async function createLabel(
  _db: Db,
  _deps: InboxDeps,
  _p: {
    teamId: string;
    inboxId: string;
    actor: InboxActor;
    name: string;
    color?: string | undefined;
  },
): Promise<{ ok: true; label: LabelWire } | { ok: false; error: InboxError }> {
  throw new Error("INBOX_CONTRACT_STUB");
}

export async function updateLabel(
  _db: Db,
  _deps: InboxDeps,
  _p: {
    teamId: string;
    inboxId: string;
    labelId: string;
    actor: InboxActor;
    name?: string | undefined;
    color?: string | undefined;
  },
): Promise<{ ok: true; label: LabelWire } | { ok: false; error: InboxError }> {
  throw new Error("INBOX_CONTRACT_STUB");
}

export async function deleteLabel(
  _db: Db,
  _deps: InboxDeps,
  _p: { teamId: string; inboxId: string; labelId: string; actor: InboxActor },
): Promise<boolean> {
  throw new Error("INBOX_CONTRACT_STUB");
}
