import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import { effectivePlan, type Plan } from "./plans.js";

/** effectivePlan for a team row; null when the team does not exist. */
export async function fetchEffectivePlan(db: Db, teamId: string): Promise<Plan | null> {
  const [team] = await db
    .select({ plan: schema.teams.plan, currentPeriodEnd: schema.teams.currentPeriodEnd })
    .from(schema.teams)
    .where(eq(schema.teams.id, teamId));
  return team ? effectivePlan(team.plan, team.currentPeriodEnd) : null;
}
