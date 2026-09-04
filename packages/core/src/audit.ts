import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";

import { AUDIT_ACTIONS, type AuditAction } from "./audit-actions.js";

export { AUDIT_ACTIONS, type AuditAction };

/** Who did it: a signed-in user, an API key, an OAuth (MCP) token, Stripe, or the platform itself. */
export type AuditActor = { userId: string } | { apiKeyId: string } | "oauth" | "stripe" | "system";

export interface AuditEvent {
  /** Null only for actions with no team (none today); rows outlive their team. */
  teamId: string | null;
  actor: AuditActor;
  action: AuditAction;
  target?: { type: string; id: string };
  /** Identifying facts only (names, roles, plans). Never secrets or message bodies. */
  metadata?: Record<string, unknown>;
}

export type ParsedAuditActor =
  | { kind: "user"; id: string }
  | { kind: "api_key"; id: string }
  | { kind: "oauth" | "stripe" | "system" };

/** Actor for a REST/MCP request: the key when one signed it, else the OAuth token's holder. */
export function apiRequestActor(auth: { apiKeyId: string | null; userId?: string }): AuditActor {
  if (auth.apiKeyId) return { apiKeyId: auth.apiKeyId };
  return auth.userId ? { userId: auth.userId } : "oauth";
}

function encodeActor(actor: AuditActor): string {
  if (typeof actor === "string") return actor;
  return "userId" in actor ? `user:${actor.userId}` : `api_key:${actor.apiKeyId}`;
}

/** Inverse of the actor_id encoding; unknown shapes read as system. */
export function parseAuditActor(actorId: string | null): ParsedAuditActor {
  if (actorId === "oauth" || actorId === "stripe") return { kind: actorId };
  if (actorId?.startsWith("user:")) return { kind: "user", id: actorId.slice(5) };
  if (actorId?.startsWith("api_key:")) return { kind: "api_key", id: actorId.slice(8) };
  return { kind: "system" };
}

/**
 * Append one audit row. Call AFTER the mutation commits (never inside its
 * transaction): the write is best-effort — a failure is logged and swallowed
 * so the trail can never fail the action it records.
 */
export async function recordAudit(db: Db, event: AuditEvent): Promise<void> {
  try {
    await db.insert(schema.auditLog).values({
      teamId: event.teamId,
      actorId: encodeActor(event.actor),
      action: event.action,
      target: event.target ? `${event.target.type}:${event.target.id}` : null,
      data: event.metadata ?? null,
    });
  } catch (err) {
    console.error("audit write failed", err);
  }
}
