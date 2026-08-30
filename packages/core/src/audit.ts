import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";

export const AUDIT_ACTIONS = [
  "api_key.created",
  "api_key.revoked",
  "domain.created",
  "domain.verified",
  "domain.deleted",
  "webhook.created",
  "webhook.updated",
  "webhook.deleted",
  "member.invited",
  "member.joined",
  "member.removed",
  "member.role_changed",
  "member.left",
  "invitation.revoked",
  "team.created",
  "team.deleted",
  "instance.settings_updated",
  "billing.checkout_started",
  "billing.portal_opened",
  "billing.subscription_updated",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

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

/** Actor for a REST/MCP request: the key when one signed it, else the OAuth token. */
export function apiRequestActor(auth: { apiKeyId: string | null }): AuditActor {
  return auth.apiKeyId ? { apiKeyId: auth.apiKeyId } : "oauth";
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
