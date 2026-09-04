import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq } from "drizzle-orm";
import { effectivePlan, type Plan } from "./plans.js";

/** effectivePlan for a team row; null when the team does not exist. */
export async function fetchEffectivePlan(db: Db, teamId: string): Promise<Plan | null> {
  const [team] = await db
    .select({ plan: schema.teams.plan, currentPeriodEnd: schema.teams.currentPeriodEnd })
    .from(schema.teams)
    .where(eq(schema.teams.id, teamId));
  return team ? effectivePlan(team.plan, team.currentPeriodEnd) : null;
}

const PLAN_RANK: Record<Plan, number> = { free: 0, pro: 1, scale: 2 };

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
