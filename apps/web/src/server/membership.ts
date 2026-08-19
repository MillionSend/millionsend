import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { asc, eq } from "drizzle-orm";
import { uploadsEnabled } from "./storage";

export type TeamRole = (typeof schema.teamMemberRoleEnum.enumValues)[number];
export type TeamPlan = (typeof schema.planEnum.enumValues)[number];

/**
 * Selection cookie only — it picks among the session's own memberships and
 * is re-validated against teamMembers on every request. It is never an
 * authorization input.
 */
export const ACTIVE_TEAM_COOKIE = "ms_active_team";

export interface ActiveMembership {
  teamId: string;
  role: TeamRole;
  teamName: string;
  plan: TeamPlan;
  logoUrl: string | null;
}

/** All memberships for a user, oldest first (the first one is the default team). */
export async function listMemberships(db: Db, userId: string): Promise<ActiveMembership[]> {
  const rows = await db
    .select({
      teamId: schema.teamMembers.teamId,
      role: schema.teamMembers.role,
      teamName: schema.teams.name,
      plan: schema.teams.plan,
      logoUrl: schema.teams.logoUrl,
    })
    .from(schema.teamMembers)
    .innerJoin(schema.teams, eq(schema.teams.id, schema.teamMembers.teamId))
    .where(eq(schema.teamMembers.userId, userId))
    .orderBy(asc(schema.teamMembers.createdAt));
  // Storage off ⇒ logo URLs may be dead (bucket gone/private); every surface
  // falls back to the initial tile rather than render a broken image.
  return uploadsEnabled() ? rows : rows.map((row) => ({ ...row, logoUrl: null }));
}

/**
 * This is the ONLY place the session→team resolution rule lives; both the
 * tRPC context and the dashboard layout guard call it. `preferredTeamId`
 * (from ACTIVE_TEAM_COOKIE) only selects among the user's own teamMembers
 * rows — an id the user is not a member of falls back to the oldest
 * membership, so the cookie can never grant access. teamId must never come
 * from client input.
 */
export async function getActiveMembership(
  db: Db,
  userId: string,
  preferredTeamId?: string,
): Promise<ActiveMembership | null> {
  const memberships = await listMemberships(db, userId);
  return memberships.find((m) => m.teamId === preferredTeamId) ?? memberships[0] ?? null;
}
