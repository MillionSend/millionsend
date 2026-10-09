import { fetchTeamStanding } from "@millionsend/core";
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

/** Whether the user owns or belongs to a team suspended for phishing, in any role. */
export async function belongsToPhishingSuspendedTeam(db: Db, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ teamId: schema.teamMembers.teamId })
    .from(schema.teamMembers)
    .innerJoin(schema.teams, eq(schema.teams.id, schema.teamMembers.teamId))
    .where(
      and(
        eq(schema.teamMembers.userId, userId),
        isNotNull(schema.teams.suspendedAt),
        eq(schema.teams.suspensionReason, "phishing"),
      ),
    )
    .limit(1);
  return row !== undefined;
}
