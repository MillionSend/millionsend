import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq } from "drizzle-orm";

/**
 * Claim the right to send one notification for (team, kind, period). True for
 * exactly one caller: the insert is the lock, so concurrent sweeps or several
 * surfaces detecting the same condition send it once.
 */
export async function claimNotification(
  db: Db,
  params: { teamId: string; kind: string; periodKey: string },
): Promise<boolean> {
  const rows = await db
    .insert(schema.teamNotifications)
    .values(params)
    .onConflictDoNothing()
    .returning({ teamId: schema.teamNotifications.teamId });
  return rows.length > 0;
}

/** Forget a kind's claims so the next episode notifies again. */
export async function clearNotifications(
  db: Db,
  params: { teamId: string; kind: string },
): Promise<void> {
  await db
    .delete(schema.teamNotifications)
    .where(
      and(
        eq(schema.teamNotifications.teamId, params.teamId),
        eq(schema.teamNotifications.kind, params.kind),
      ),
    );
}

/** The addresses account notifications go to. */
export async function listTeamOwners(
  db: Db,
  teamId: string,
): Promise<{ email: string; name: string }[]> {
  return db
    .select({ email: schema.user.email, name: schema.user.name })
    .from(schema.teamMembers)
    .innerJoin(schema.user, eq(schema.user.id, schema.teamMembers.userId))
    .where(and(eq(schema.teamMembers.teamId, teamId), eq(schema.teamMembers.role, "owner")));
}
