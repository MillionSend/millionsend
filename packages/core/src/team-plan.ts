import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, count, eq, isNull, sql } from "drizzle-orm";
import { parseAuditActor } from "./audit.js";
import { GUARDRAIL_WINDOW_DAYS } from "./deliverability.js";
import { resultRows } from "./driver-result.js";
import {
  effectivePlan,
  freePoolOwner,
  PLAN_CONTACT_LIMIT,
  type Plan,
  type TeamQuota,
  teamQuota,
} from "./plans.js";
import { DAY_MS, utcDay } from "./utc-day.js";

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
  planStatus: schema.teams.planStatus,
  currentPeriodStart: schema.teams.currentPeriodStart,
  currentPeriodEnd: schema.teams.currentPeriodEnd,
  overageEnabled: schema.teams.overageEnabled,
  dailySendCeiling: schema.teams.dailySendCeiling,
  poolOwnerId: schema.teams.poolOwnerId,
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

/**
 * Fills teams.pool_owner_id where createTeam did not: the user the team's
 * team.created audit row names, else its earliest owner. Cloud only, since
 * self-host has no Free pools; idempotent, so each worker boot runs it. The
 * instance's own (system) team is never in a pool. A team on Free brings its
 * counts of the guardrail window into its pool, in the transaction that
 * records the creator, so its bounce and complaint record and its day's
 * count carry over, added once by whichever run records it. Returns how many
 * teams it filled.
 */
export async function backfillPoolOwners(
  db: Db,
  isCloud: boolean,
  now: Date = new Date(),
): Promise<number> {
  if (!isCloud) return 0;
  const t = schema.teams;
  const a = schema.auditLog;
  const m = schema.teamMembers;
  const c = schema.usageCounters;
  const p = schema.freePoolUsage;
  const since = utcDay(now.getTime() - (GUARDRAIL_WINDOW_DAYS - 1) * DAY_MS);
  const rows = resultRows<{ id: string; creator: string | null; owner: string | null }>(
    await db.execute(sql`
      select ${t.id} as id,
        (select ${a.actorId} from ${a}
          where ${a.teamId} = ${t.id} and ${a.action} = 'team.created'
          order by ${a.createdAt} limit 1) as creator,
        (select ${m.userId} from ${m}
          where ${m.teamId} = ${t.id} and ${m.role} = 'owner'
          order by ${m.createdAt}, ${m.id} limit 1) as owner
      from ${t}
      where ${t.poolOwnerId} is null and ${t.plan} <> 'system'
    `),
  );
  let filled = 0;
  for (const row of rows) {
    const creator = parseAuditActor(row.creator);
    const ownerId = creator.kind === "user" ? creator.id : row.owner;
    if (!ownerId) continue;
    const recorded = await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const [team] = await txDb
        .update(t)
        .set({ poolOwnerId: ownerId })
        .where(and(eq(t.id, row.id), isNull(t.poolOwnerId)))
        .returning({
          plan: t.plan,
          currentPeriodEnd: t.currentPeriodEnd,
          poolOwnerId: t.poolOwnerId,
        });
      if (!team) return false;
      if (freePoolOwner(team, now)) {
        await txDb.execute(sql`
          insert into ${p} (owner_id, day, accepted, sent, sent_no_feedback, hard_bounced, complained)
          select ${ownerId}::text, ${c.day}, ${c.accepted}, ${c.sent}, ${c.sentNoFeedback},
            ${c.hardBounced}, ${c.complained}
          from ${c}
          where ${c.teamId} = ${row.id} and ${c.day} >= ${since}
          on conflict (owner_id, day) do update set
            accepted = ${p.accepted} + excluded.accepted,
            sent = ${p.sent} + excluded.sent,
            sent_no_feedback = ${p.sentNoFeedback} + excluded.sent_no_feedback,
            hard_bounced = ${p.hardBounced} + excluded.hard_bounced,
            complained = ${p.complained} + excluded.complained
        `);
      }
      return true;
    });
    if (recorded) filled += 1;
  }
  return filled;
}

const PLAN_RANK: Record<Plan, number> = { free: 0, starter: 1, pro: 2, scale: 3, system: 4 };

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
      if (quota.kind !== "month") return sum;
      const spread = quota.included / 30;
      return sum + (quota.dailyCeiling == null ? spread : Math.min(spread, quota.dailyCeiling));
    }, 0),
  );
}

/**
 * How many more contacts the team may add under its plan's cap; null when
 * nothing caps them (self-host, uncapped plans). Read before an insert, not
 * locked: two imports racing the cap can land a few rows past it, which the
 * cap tolerates (it is a plan boundary, not a safety limit).
 */
export async function contactRoom(
  db: Db,
  teamId: string,
  plan: Plan,
  isCloud: boolean,
): Promise<number | null> {
  const limit = isCloud ? PLAN_CONTACT_LIMIT[plan] : null;
  if (limit === null) return null;
  const [row] = await db
    .select({ n: count() })
    .from(schema.contacts)
    .where(eq(schema.contacts.teamId, teamId));
  return limit - (row?.n ?? 0);
}
