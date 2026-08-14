import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { asc, eq } from "drizzle-orm";

export type TeamRole = (typeof schema.teamMemberRoleEnum.enumValues)[number];

export interface ActiveMembership {
  teamId: string;
  role: TeamRole;
  teamName: string;
}

/**
 * The active team is the user's oldest membership (MVP: single team per
 * user). This is the ONLY place the session→team resolution rule lives;
 * both the tRPC context and the dashboard layout guard call it. teamId must
 * never come from client input.
 */
export async function getActiveMembership(
  db: Db,
  userId: string,
): Promise<ActiveMembership | null> {
  const rows = await db
    .select({
      teamId: schema.teamMembers.teamId,
      role: schema.teamMembers.role,
      teamName: schema.teams.name,
    })
    .from(schema.teamMembers)
    .innerJoin(schema.teams, eq(schema.teams.id, schema.teamMembers.teamId))
    .where(eq(schema.teamMembers.userId, userId))
    .orderBy(asc(schema.teamMembers.createdAt))
    .limit(1);
  return rows[0] ?? null;
}
