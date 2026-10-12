import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import type { ApiKeyAuth } from "../api-key-auth.js";

/** Who acted on an inbox. An api_key with an inboxId is an inbox-scoped key. */
export type InboxActor =
  | { kind: "user"; userId: string }
  | { kind: "api_key"; apiKeyId: string; inboxId: string | null }
  | { kind: "oauth"; userId: string; clientId: string }
  | { kind: "system" };

/** The actor behind an authenticated API call: every MCP call is oauth. */
export function inboxActorFromAuth(auth: ApiKeyAuth): InboxActor {
  if (auth.oauthClientId && auth.userId) {
    return { kind: "oauth", userId: auth.userId, clientId: auth.oauthClientId };
  }
  if (auth.apiKeyId) return { kind: "api_key", apiKeyId: auth.apiKeyId, inboxId: auth.inboxId };
  return { kind: "system" };
}

/** "user:<id>" | "api_key:<id>" | "oauth:<client_id>:<user_id>" | "system". */
export function encodeInboxActor(a: InboxActor): string {
  switch (a.kind) {
    case "user":
      return `user:${a.userId}`;
    case "api_key":
      return `api_key:${a.apiKeyId}`;
    case "oauth":
      return `oauth:${a.clientId}:${a.userId}`;
    case "system":
      return "system";
  }
}

/** An inbox_activity actor as encodeInboxActor wrote it, read back. */
export type ParsedInboxActor =
  | { kind: "user"; userId: string }
  | { kind: "api_key"; apiKeyId: string }
  | { kind: "oauth"; clientId: string; userId: string }
  | { kind: "system" };

/** Inverse of encodeInboxActor; anything else reads as system. */
export function parseInboxActor(encoded: string): ParsedInboxActor {
  if (encoded.startsWith("user:")) return { kind: "user", userId: encoded.slice(5) };
  if (encoded.startsWith("api_key:")) return { kind: "api_key", apiKeyId: encoded.slice(8) };
  if (encoded.startsWith("oauth:")) {
    // The user id is last: a client id may itself carry colons.
    const rest = encoded.slice(6);
    const cut = rest.lastIndexOf(":");
    if (cut > 0)
      return { kind: "oauth", clientId: rest.slice(0, cut), userId: rest.slice(cut + 1) };
  }
  return { kind: "system" };
}

/** A webhook's data.source. Resend's "agent" is never emitted: MillionSend runs no agent of its own. */
export function webhookSource(a: InboxActor): "api" | "dashboard" | "system" {
  if (a.kind === "user") return "dashboard";
  return a.kind === "system" ? "system" : "api";
}

/** Agent views never see held mail: inbox-scoped keys and every MCP call. */
export function isAgentActor(a: InboxActor): boolean {
  return a.kind === "oauth" || (a.kind === "api_key" && a.inboxId !== null);
}

/** Who may approve a held send or release quarantine: a person, or a team-wide key. */
export function canApprove(a: InboxActor): boolean {
  return a.kind === "user" || (a.kind === "api_key" && a.inboxId === null);
}

export const INBOX_ACTIVITY_ACTIONS = [
  "inbox.created",
  "inbox.updated",
  "inbox.deleted",
  "inbox.expired",
  "inbox.safety_updated",
  "email.quarantined",
  "email.released",
  "email.sent",
  "email.drafted",
  "email.refused",
  "email.forwarded",
  "email.deleted",
  "code.read",
  "thread.updated",
  "label.created",
  "label.updated",
  "label.deleted",
  "draft.created",
  "draft.updated",
  "draft.sent",
  "draft.approved",
  "draft.rejected",
  "draft.deleted",
  "draft.expired",
  "key.created",
  "key.revoked",
] as const;
export type InboxActivityAction = (typeof INBOX_ACTIVITY_ACTIONS)[number];

/**
 * One inbox_activity row. Pass the caller's transaction so the action and
 * its row commit together. `decision.reasons` carries reason codes only,
 * never content, codes or addresses.
 */
export async function recordInboxActivity(
  db: Db,
  entry: {
    teamId: string;
    inboxId: string;
    actor: InboxActor;
    action: InboxActivityAction;
    threadId?: string | null | undefined;
    emailId?: string | null | undefined;
    draftId?: string | null | undefined;
    decision?: { result: string; reasons: string[] } | null | undefined;
  },
): Promise<void> {
  await db.insert(schema.inboxActivity).values({
    teamId: entry.teamId,
    inboxId: entry.inboxId,
    actor: encodeInboxActor(entry.actor),
    action: entry.action,
    threadId: entry.threadId ?? null,
    emailId: entry.emailId ?? null,
    draftId: entry.draftId ?? null,
    decision: entry.decision ?? null,
  });
}
