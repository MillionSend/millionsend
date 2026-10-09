import { fetchTeamStanding, SILENT_SUSPENSIONS } from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { and, eq, isNotNull } from "drizzle-orm";
import en from "../../messages/en/common.json";
import ptBR from "../../messages/pt-BR/common.json";
import { activeLocale } from "./locale";

const MESSAGES = { en: en.suspensionLock, "pt-BR": ptBR.suspensionLock } as const;

export type SuspensionLock = keyof typeof en.suspensionLock;

/**
 * What a suspended team's own people may not do, in the caller's language.
 * PRECONDITION_FAILED is the code the dashboard shows a server message for.
 * The operator console never routes through here.
 */
export async function suspensionLockError(lock: SuspensionLock): Promise<TRPCError> {
  return new TRPCError({
    code: "PRECONDITION_FAILED",
    message: MESSAGES[await activeLocale()][lock],
  });
}

export async function assertTeamNotSuspended(
  db: Db,
  teamId: string,
  lock: SuspensionLock,
): Promise<void> {
  if ((await fetchTeamStanding(db, teamId))?.suspended) throw await suspensionLockError(lock);
}

/** Whether the user owns or belongs, in any role, to a team under a silent suspension. */
export async function belongsToSilentlySuspendedTeam(db: Db, userId: string): Promise<boolean> {
  // Matched here rather than in SQL: a reason the schema lacks yet would be
  // an invalid enum literal to Postgres.
  const suspended = await db
    .select({ reason: schema.teams.suspensionReason })
    .from(schema.teamMembers)
    .innerJoin(schema.teams, eq(schema.teams.id, schema.teamMembers.teamId))
    .where(and(eq(schema.teamMembers.userId, userId), isNotNull(schema.teams.suspendedAt)));
  return suspended.some((row) => SILENT_SUSPENSIONS.includes(row.reason ?? ""));
}
