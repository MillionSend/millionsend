import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq } from "drizzle-orm";
import { effectivePlan, type Plan, type TeamQuota, teamQuota } from "./plans.js";

/** effectivePlan for a team row; null when the team does not exist. */
export async function fetchEffectivePlan(db: Db, teamId: string): Promise<Plan | null> {
  const [team] = await db
    .select({ plan: schema.teams.plan, currentPeriodEnd: schema.teams.currentPeriodEnd })
    .from(schema.teams)
    .where(eq(schema.teams.id, teamId));
  return team ? effectivePlan(team.plan, team.currentPeriodEnd) : null;
}

/** The billing columns teamQuota reads, selected off a team row. */
export const QUOTA_COLUMNS = {
  plan: schema.teams.plan,
  planQuota: schema.teams.planQuota,
  currentPeriodStart: schema.teams.currentPeriodStart,
  currentPeriodEnd: schema.teams.currentPeriodEnd,
  stripeOverageItemId: schema.teams.stripeOverageItemId,
} as const;

/** teamQuota for a team row; null when the team does not exist. */
export async function fetchTeamQuota(
  db: Db,
  teamId: string,
  isCloud: boolean,
  now: Date = new Date(),
): Promise<TeamQuota | null> {
  const [team] = await db
    .select(QUOTA_COLUMNS)
    .from(schema.teams)
    .where(eq(schema.teams.id, teamId));
  return team ? teamQuota(team, isCloud, now) : null;
}

const PLAN_RANK: Record<Plan, number> = { free: 0, starter: 1, pro: 2, scale: 3 };

/** The highest effective plan among the teams a user owns; free when they own none. */
export async function fetchBestOwnedPlan(db: Db, userId: string): Promise<Plan> {
  const rows = await db
    .select({ plan: schema.teams.plan, currentPeriodEnd: schema.teams.currentPeriodEnd })
    .from(schema.teamMembers)
    .innerJoin(schema.teams, eq(schema.teams.id, schema.teamMembers.teamId))
    .where(and(eq(schema.teamMembers.userId, userId), eq(schema.teamMembers.role, "owner")));
  return rows
    .map((row) => effectivePlan(row.plan, row.currentPeriodEnd))
    .reduce<Plan>((best, plan) => (PLAN_RANK[plan] > PLAN_RANK[best] ? plan : best), "free");
}

/**
 * Emails a day the instance has promised across every team: a daily cap as
 * is, a monthly volume spread over 30 days. Against the SES account's 24-hour
 * quota this says how far the sold plans could go on a busy day.
 */
export async function committedDailyVolume(db: Db, now: Date = new Date()): Promise<number> {
  const rows = await db.select(QUOTA_COLUMNS).from(schema.teams);
  return Math.round(
    rows.reduce((sum, row) => {
      const quota = teamQuota(row, true, now);
      if (quota.kind === "day") return sum + quota.limit;
      return quota.kind === "month" ? sum + quota.included / 30 : sum;
    }, 0),
  );
}
