import { type AuditEvent, recordAudit as recordAuditRow } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import type { AuthSession } from "./trpc";

/**
 * Dashboard binding of the core helper: the actor is always the session
 * user and the team defaults to the active membership. Call after commit.
 */
export function recordAudit(
  ctx: { db: Db; session: AuthSession; teamId: string },
  event: Omit<AuditEvent, "teamId" | "actor"> & { teamId?: string },
): Promise<void> {
  return recordAuditRow(ctx.db, {
    ...event,
    teamId: event.teamId ?? ctx.teamId,
    actor: { userId: ctx.session.user.id },
  });
}
