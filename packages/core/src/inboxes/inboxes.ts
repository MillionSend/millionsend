import type { Db } from "@millionsend/db";
import type { Plan } from "../plans.js";
import type { WebhookEnqueue } from "../webhooks.js";
import type { InboxActor } from "./activity.js";
import type { InboxSafety } from "./safety.js";
import type { InboxError, InboxKind, InboxListItemWire, InboxWire, ListQuery } from "./types.js";

export interface InboxDeps {
  sharedInboxDomain: string | null;
  receivingEnabled: boolean;
  enqueueWebhookDeliveries?: WebhookEnqueue | undefined;
}

export interface CreateInboxInput {
  email_address?: string | undefined;
  name?: string | undefined;
  from_name?: string | undefined;
  forwarding?: boolean | undefined;
  kind?: InboxKind | undefined;
  expires_in?: string | null | undefined;
  safety?: Partial<InboxSafety> | undefined;
}

export async function createInbox(
  _db: Db,
  _deps: InboxDeps,
  _p: {
    teamId: string;
    teamName: string;
    plan: Plan;
    isCloud: boolean;
    actor: InboxActor;
    input: CreateInboxInput;
    now?: Date | undefined;
  },
): Promise<{ ok: true; inbox: InboxWire } | { ok: false; error: InboxError }> {
  throw new Error("INBOX_CONTRACT_STUB");
}

export async function getInbox(
  _db: Db,
  _p: {
    teamId: string;
    idOrEmail: string;
    onlyInboxId?: string | null | undefined;
    now?: Date | undefined;
  },
): Promise<InboxWire | null> {
  throw new Error("INBOX_CONTRACT_STUB");
}

export async function listInboxes(
  _db: Db,
  _p: {
    teamId: string;
    query: ListQuery;
    kind?: InboxKind | undefined;
    onlyInboxId?: string | null | undefined;
    now?: Date | undefined;
  },
): Promise<{ data: InboxListItemWire[]; hasMore: boolean } | "bad_cursor"> {
  throw new Error("INBOX_CONTRACT_STUB");
}

export async function updateInbox(
  _db: Db,
  _deps: InboxDeps,
  _p: {
    teamId: string;
    inboxId: string;
    actor: InboxActor;
    patch: {
      name?: string | undefined;
      from_name?: string | undefined;
      expires_in?: string | null | undefined;
    };
  },
): Promise<{ ok: true; inbox: InboxWire } | { ok: false; error: InboxError }> {
  throw new Error("INBOX_CONTRACT_STUB");
}

export async function deleteInboxes(
  _db: Db,
  _deps: InboxDeps,
  _p: {
    teamId: string;
    inboxIds: string[];
    actor: InboxActor;
    reason: "deleted" | "expired" | "domain_deleted";
  },
): Promise<number> {
  throw new Error("INBOX_CONTRACT_STUB");
}

export async function expireInboxes(_db: Db, _deps: InboxDeps, _now: Date): Promise<number> {
  throw new Error("INBOX_CONTRACT_STUB");
}

export async function getInboxSafety(
  _db: Db,
  _p: { teamId: string; inboxId: string },
): Promise<InboxSafety | null> {
  throw new Error("INBOX_CONTRACT_STUB");
}

export async function updateInboxSafety(
  _db: Db,
  _deps: InboxDeps,
  _p: { teamId: string; inboxId: string; actor: InboxActor; patch: Partial<InboxSafety> },
): Promise<{ ok: true; safety: InboxSafety } | { ok: false; error: InboxError }> {
  throw new Error("INBOX_CONTRACT_STUB");
}
