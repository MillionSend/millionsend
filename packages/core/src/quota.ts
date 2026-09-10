import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { sql } from "drizzle-orm";
import { firstRow } from "./driver-result.js";
import { QUOTA_TOLERANCE, type TeamQuota } from "./plans.js";
import { bumpHourlyUsage } from "./usage-hourly.js";
import { utcDay } from "./utc-day.js";

/**
 * `accepted` is the counter the reservation ran against (the UTC day on a
 * daily cap, the billing period on a monthly one) after the call; `ceiling`
 * is the most that counter may reach, null when nothing caps it.
 */
export type QuotaResult =
  | { reserved: true; accepted: number; ceiling: number | null }
  | { reserved: false; accepted: number; ceiling: number | null };

/**
 * Atomically reserve `count` sends against a team's daily limit (UTC day).
 * Single upsert with the limit re-checked inside the UPDATE's WHERE, so
 * concurrent requests can never overshoot the cap — no cached aggregates.
 * `limit === null` means unlimited (Scale plan / self-host): counts are still
 * recorded for metrics but never rejected.
 *
 * CONTRACT: call inside the same transaction that inserts the email rows —
 * a crash between reserve and insert otherwise burns quota with nothing
 * sent. Callers that cannot share a transaction must compensate failures
 * with releaseDailyQuota.
 */
/** Most a team may accept in one UTC day: the plan cap plus its tolerance. */
export function dailyCeiling(limit: number): number {
  return Math.floor(limit * (1 + QUOTA_TOLERANCE));
}

export async function reserveDailyQuota(
  db: Db,
  params: {
    teamId: string;
    count: number;
    limit: number | null;
    day?: string;
    /** The instant the sends count against (their delivery time); noon of `day` when only that is known. */
    at?: Date;
  },
): Promise<QuotaResult> {
  const { teamId, count, limit } = params;
  if (count <= 0) throw new Error("count must be positive");
  const day = params.day ?? utcDay();
  const at = params.at ?? (params.day ? new Date(`${params.day}T12:00:00Z`) : new Date());
  const t = schema.usageCounters;
  const ceiling = limit === null ? null : dailyCeiling(limit);

  if (ceiling !== null && count > ceiling) {
    const existing = await db
      .select({ accepted: t.accepted })
      .from(t)
      .where(sql`${t.teamId} = ${teamId} and ${t.day} = ${day}`);
    return { reserved: false, accepted: existing[0]?.accepted ?? 0, ceiling };
  }

  const guard = ceiling === null ? sql`true` : sql`${t.accepted} + ${count} <= ${ceiling}`;
  const rows = await db.execute<{ accepted: number }>(sql`
    insert into ${t} (team_id, day, accepted)
    values (${teamId}, ${day}, ${count})
    on conflict (team_id, day) do update
      set accepted = ${t.accepted} + ${count}
      where ${guard}
    returning accepted
  `);

  const row = firstRow<{ accepted: number }>(rows);
  if (row) {
    await bumpHourlyUsage(db, { teamId, at, counts: { accepted: count } });
    return { reserved: true, accepted: Number(row.accepted), ceiling };
  }

  const existing = await db
    .select({ accepted: t.accepted })
    .from(t)
    .where(sql`${t.teamId} = ${teamId} and ${t.day} = ${day}`);
  return { reserved: false, accepted: existing[0]?.accepted ?? 0, ceiling };
}

/**
 * Compensating release for non-transactional callers whose work failed after
 * a successful reservation. Floors at zero.
 */
export async function releaseDailyQuota(
  db: Db,
  params: { teamId: string; count: number; day?: string; at?: Date },
): Promise<void> {
  if (params.count <= 0) throw new Error("count must be positive");
  const day = params.day ?? utcDay();
  const at = params.at ?? (params.day ? new Date(`${params.day}T12:00:00Z`) : new Date());
  const t = schema.usageCounters;
  await db.execute(sql`
    update ${t}
    set accepted = greatest(accepted - ${params.count}, 0)
    where ${t.teamId} = ${params.teamId} and ${t.day} = ${day}
  `);
  await bumpHourlyUsage(db, { teamId: params.teamId, at, counts: { accepted: -params.count } });
}

/**
 * Atomically reserve `count` sends against a monthly plan's billing period,
 * the same single-upsert shape as the daily table. No tolerance: at the
 * included volume the reservation is refused unless overage is on, in which
 * case the counter keeps growing and the excess is what the meter bills.
 * The daily counters are bumped alongside (uncapped) so Metrics and the
 * history table see every send.
 */
export async function reservePeriodQuota(
  db: Db,
  params: {
    teamId: string;
    count: number;
    included: number;
    periodStart: Date;
    overage: boolean;
    day?: string;
    at?: Date;
  },
): Promise<QuotaResult> {
  const { teamId, count, periodStart } = params;
  if (count <= 0) throw new Error("count must be positive");
  const ceiling = params.overage ? null : params.included;
  const t = schema.usagePeriods;
  const current = async () => {
    const [row] = await db
      .select({ accepted: t.accepted })
      .from(t)
      .where(sql`${t.teamId} = ${teamId} and ${t.periodStart} = ${periodStart}`);
    return row?.accepted ?? 0;
  };
  if (ceiling !== null && count > ceiling) {
    return { reserved: false, accepted: await current(), ceiling };
  }
  const guard = ceiling === null ? sql`true` : sql`${t.accepted} + ${count} <= ${ceiling}`;
  const rows = await db.execute<{ accepted: number }>(sql`
    insert into ${t} (team_id, period_start, accepted)
    values (${teamId}, ${periodStart}, ${count})
    on conflict (team_id, period_start) do update
      set accepted = ${t.accepted} + ${count}
      where ${guard}
    returning accepted
  `);
  const row = firstRow<{ accepted: number }>(rows);
  if (!row) return { reserved: false, accepted: await current(), ceiling };
  await reserveDailyQuota(db, {
    teamId,
    count,
    limit: null,
    ...(params.day ? { day: params.day } : {}),
    ...(params.at ? { at: params.at } : {}),
  });
  return { reserved: true, accepted: Number(row.accepted), ceiling };
}

/** Compensating release for a period reservation; floors at zero and mirrors the daily release. */
export async function releasePeriodQuota(
  db: Db,
  params: { teamId: string; count: number; periodStart: Date; day?: string; at?: Date },
): Promise<void> {
  if (params.count <= 0) throw new Error("count must be positive");
  const t = schema.usagePeriods;
  await db.execute(sql`
    update ${t}
    set accepted = greatest(accepted - ${params.count}, 0)
    where ${t.teamId} = ${params.teamId} and ${t.periodStart} = ${params.periodStart}
  `);
  await releaseDailyQuota(db, {
    teamId: params.teamId,
    count: params.count,
    ...(params.day ? { day: params.day } : {}),
    ...(params.at ? { at: params.at } : {}),
  });
}

/**
 * Reserve against whatever caps the team (teamQuota): the UTC day on a daily
 * plan, the billing period on a monthly one, nothing on self-host (counted
 * only). The one entry point every accept surface goes through.
 */
export async function reserveQuota(
  db: Db,
  params: { teamId: string; count: number; quota: TeamQuota; day?: string; at?: Date },
): Promise<QuotaResult> {
  const { teamId, count, quota } = params;
  const when = {
    ...(params.day ? { day: params.day } : {}),
    ...(params.at ? { at: params.at } : {}),
  };
  if (quota.kind === "month") {
    return reservePeriodQuota(db, {
      teamId,
      count,
      included: quota.included,
      periodStart: quota.periodStart,
      overage: quota.overage,
      ...when,
    });
  }
  return reserveDailyQuota(db, {
    teamId,
    count,
    limit: quota.kind === "day" ? quota.limit : null,
    ...when,
  });
}

/** Compensating release for reserveQuota. */
export async function releaseQuota(
  db: Db,
  params: { teamId: string; count: number; quota: TeamQuota; day?: string; at?: Date },
): Promise<void> {
  const when = {
    ...(params.day ? { day: params.day } : {}),
    ...(params.at ? { at: params.at } : {}),
  };
  if (params.quota.kind === "month") {
    await releasePeriodQuota(db, {
      teamId: params.teamId,
      count: params.count,
      periodStart: params.quota.periodStart,
      ...when,
    });
    return;
  }
  await releaseDailyQuota(db, { teamId: params.teamId, count: params.count, ...when });
}

/** Sends accepted so far, and how many past the included volume the meter already knows about. */
export async function readPeriodUsage(
  db: Db,
  teamId: string,
  periodStart: Date,
): Promise<{ accepted: number; reportedOverage: number }> {
  const t = schema.usagePeriods;
  const [row] = await db
    .select({ accepted: t.accepted, reportedOverage: t.reportedOverage })
    .from(t)
    .where(sql`${t.teamId} = ${teamId} and ${t.periodStart} = ${periodStart}`);
  return row ?? { accepted: 0, reportedOverage: 0 };
}

/** The remaining room under a quota after a reservation answered; null when nothing caps it. */
export function quotaRoom(result: QuotaResult): number | null {
  return result.ceiling === null ? null : Math.max(0, result.ceiling - result.accepted);
}
