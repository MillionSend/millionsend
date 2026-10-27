import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { eq, sql } from "drizzle-orm";
import { firstRow } from "./driver-result.js";
import {
  FREE_BURST,
  FREE_BURST_REFILL_MS,
  freePoolOwner,
  OVERAGE_HARD_CAP,
  QUOTA_TOLERANCE,
  type TeamQuota,
} from "./plans.js";
import { bumpHourlyUsage } from "./usage-hourly.js";
import { utcDay } from "./utc-day.js";

/** A Free pool's shared cap, as a daily TeamQuota carries it. */
type DailyPool = NonNullable<Extract<TeamQuota, { kind: "day" }>["pool"]>;

/** A counter a reservation runs against, and the most it may reach (null: uncapped). */
interface Counted {
  accepted: number;
  ceiling: number | null;
}

/** Of the counters a reservation ran against, the one with the least room left. */
function tightest(counters: Counted[]): Counted {
  const room = (c: Counted) => (c.ceiling ?? Number.POSITIVE_INFINITY) - c.accepted;
  return counters.reduce((a, b) => (room(b) < room(a) ? b : a));
}

/**
 * `accepted` is the counter the reservation ran against (the UTC day on a
 * daily cap, the billing period on a monthly one) after the call; `ceiling`
 * is the most that counter may reach, null when nothing caps it.
 */
export type QuotaResult =
  | { reserved: true; accepted: number; ceiling: number | null }
  | {
      reserved: false;
      accepted: number;
      ceiling: number | null;
      /** Set when the operator's daily ceiling, not the billing period, refused a monthly plan's send. */
      cap?: "day";
    };

/**
 * The instant a send is charged to: its delivery time, never earlier than
 * now. A past scheduled_at sends at once and counts today; charged to its
 * own day it would land on an unspent counter, a fresh cap per past day.
 */
export function quotaChargeAt(scheduledAt: Date | null | undefined, now: Date = new Date()): Date {
  return scheduledAt && scheduledAt.getTime() > now.getTime() ? scheduledAt : now;
}

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
    /** An operator ceiling: a hard line the tolerance above `limit` never crosses. */
    hardLimit?: number | null;
    /**
     * A Free pool: its counter is reserved after the team's own, against the
     * pool's limit and tolerance, while the team's counter keeps only
     * `hardLimit`. Rows lock team first, pool second, on every path.
     */
    pool?: DailyPool | undefined;
    day?: string;
    /** The instant the sends count against (their delivery time); noon of `day` when only that is known. */
    at?: Date;
  },
): Promise<QuotaResult> {
  const { teamId, count, limit, pool } = params;
  if (count <= 0) throw new Error("count must be positive");
  const day = params.day ?? utcDay();
  const at = params.at ?? (params.day ? new Date(`${params.day}T12:00:00Z`) : new Date());
  const t = schema.usageCounters;
  const p = schema.freePoolUsage;
  const soft = limit === null || pool ? null : dailyCeiling(limit);
  const hard = params.hardLimit ?? null;
  const ceiling = soft === null ? hard : hard === null ? soft : Math.min(soft, hard);
  const poolCeiling = pool ? dailyCeiling(pool.limit) : null;
  // A refusal reports the counter with the least room, which batch
  // tail-parking fits its head under.
  const refused = async (): Promise<QuotaResult> => {
    const [team] = await db
      .select({ accepted: t.accepted })
      .from(t)
      .where(sql`${t.teamId} = ${teamId} and ${t.day} = ${day}`);
    const counters: Counted[] = [{ accepted: team?.accepted ?? 0, ceiling }];
    if (pool) {
      const [shared] = await db
        .select({ accepted: p.accepted })
        .from(p)
        .where(sql`${p.ownerId} = ${pool.ownerId} and ${p.day} = ${day}`);
      counters.push({ accepted: shared?.accepted ?? 0, ceiling: poolCeiling });
    }
    return { reserved: false, ...tightest(counters) };
  };

  if ((ceiling !== null && count > ceiling) || (poolCeiling !== null && count > poolCeiling)) {
    return refused();
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
  if (!row) return refused();
  const counted: Counted[] = [{ accepted: Number(row.accepted), ceiling }];

  if (pool) {
    const shared = firstRow<{ accepted: number }>(
      await db.execute<{ accepted: number }>(sql`
        insert into ${p} (owner_id, day, accepted)
        values (${pool.ownerId}, ${day}, ${count})
        on conflict (owner_id, day) do update
          set accepted = ${p.accepted} + ${count}
          where ${p.accepted} + ${count} <= ${poolCeiling}
        returning accepted
      `),
    );
    if (!shared) {
      // A refused send still commits (it parks), so the team's charge above
      // goes back here rather than with a rollback.
      await db.execute(sql`
        update ${t}
        set accepted = ${t.accepted} - ${count}
        where ${t.teamId} = ${teamId} and ${t.day} = ${day}
      `);
      return refused();
    }
    counted.push({ accepted: Number(shared.accepted), ceiling: poolCeiling });
  }

  await bumpHourlyUsage(db, { teamId, at, counts: { accepted: count } });
  return { reserved: true, ...tightest(counted) };
}

/**
 * Compensating release for non-transactional callers whose work failed after
 * a successful reservation, the Free pool's counter included. Floors at zero.
 */
export async function releaseDailyQuota(
  db: Db,
  params: { teamId: string; count: number; pool?: DailyPool | undefined; day?: string; at?: Date },
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
  if (params.pool) {
    const p = schema.freePoolUsage;
    await db.execute(sql`
      update ${p}
      set accepted = greatest(accepted - ${params.count}, 0)
      where ${p.ownerId} = ${params.pool.ownerId} and ${p.day} = ${day}
    `);
  }
  await bumpHourlyUsage(db, { teamId: params.teamId, at, counts: { accepted: -params.count } });
}

/**
 * Atomically reserve `count` sends against a monthly plan's billing period,
 * the same single-upsert shape as the daily table. No tolerance: at the
 * included volume the reservation is refused unless overage is on, in which
 * case the counter keeps growing (the excess is what the meter bills) until
 * OVERAGE_HARD_CAP times the volume. The daily counters are bumped alongside
 * (uncapped) so Metrics and the history table see every send.
 */
export async function reservePeriodQuota(
  db: Db,
  params: {
    teamId: string;
    count: number;
    included: number;
    periodStart: Date;
    overage: boolean;
    /** Operator ceiling on the UTC day; the daily counter then caps as on a daily plan. */
    dailyCeiling?: number | null | undefined;
    day?: string;
    at?: Date;
  },
): Promise<QuotaResult> {
  const { teamId, count, periodStart } = params;
  if (count <= 0) throw new Error("count must be positive");
  const ceiling = params.overage ? params.included * OVERAGE_HARD_CAP : params.included;
  const t = schema.usagePeriods;
  const current = async () => {
    const [row] = await db
      .select({ accepted: t.accepted })
      .from(t)
      .where(sql`${t.teamId} = ${teamId} and ${t.periodStart} = ${periodStart}`);
    return row?.accepted ?? 0;
  };
  if (count > ceiling) {
    return { reserved: false, accepted: await current(), ceiling };
  }
  const guard = sql`${t.accepted} + ${count} <= ${ceiling}`;
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
  const daily = await reserveDailyQuota(db, {
    teamId,
    count,
    limit: null,
    hardLimit: params.dailyCeiling ?? null,
    ...(params.day ? { day: params.day } : {}),
    ...(params.at ? { at: params.at } : {}),
  });
  if (!daily.reserved) {
    // The day refused, not the period: hand the period its count back so a
    // parked send is charged once, when the drain reserves it again.
    await releasePeriodCount(db, { teamId, count, periodStart });
    return { reserved: false, accepted: daily.accepted, ceiling: daily.ceiling, cap: "day" };
  }
  return { reserved: true, accepted: Number(row.accepted), ceiling };
}

/** Hands a billing period back `count` sends and leaves every day's counter alone; floors at zero. */
export async function releasePeriodCount(
  db: Db,
  params: { teamId: string; count: number; periodStart: Date },
): Promise<void> {
  const t = schema.usagePeriods;
  await db.execute(sql`
    update ${t}
    set accepted = greatest(accepted - ${params.count}, 0)
    where ${t.teamId} = ${params.teamId} and ${t.periodStart} = ${params.periodStart}
  `);
}

/** Compensating release for a period reservation; floors at zero and mirrors the daily release. */
export async function releasePeriodQuota(
  db: Db,
  params: { teamId: string; count: number; periodStart: Date; day?: string; at?: Date },
): Promise<void> {
  if (params.count <= 0) throw new Error("count must be positive");
  await releasePeriodCount(db, params);
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
      dailyCeiling: quota.dailyCeiling,
      ...when,
    });
  }
  return reserveDailyQuota(db, {
    teamId,
    count,
    limit: quota.kind === "day" ? quota.limit : null,
    hardLimit: quota.kind === "day" ? (quota.dailyCeiling ?? null) : null,
    pool: quota.kind === "day" ? quota.pool : undefined,
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
  await releaseDailyQuota(db, {
    teamId: params.teamId,
    count: params.count,
    pool: params.quota.kind === "day" ? params.quota.pool : undefined,
    ...when,
  });
}

/**
 * Sends counted so far on a UTC day against a daily cap: the Free pool's
 * counter when the quota carries one, the team's own otherwise. Every reader
 * that compares a day's usage with the cap, or shows it, reads it here.
 */
export async function readDailyUsage(
  db: Db,
  teamId: string,
  quota: TeamQuota,
  day: string = utcDay(),
): Promise<number> {
  const pool = quota.kind === "day" ? quota.pool : undefined;
  if (pool) {
    const p = schema.freePoolUsage;
    const [row] = await db
      .select({ accepted: p.accepted })
      .from(p)
      .where(sql`${p.ownerId} = ${pool.ownerId} and ${p.day} = ${day}`);
    return row?.accepted ?? 0;
  }
  const t = schema.usageCounters;
  const [row] = await db
    .select({ accepted: t.accepted })
    .from(t)
    .where(sql`${t.teamId} = ${teamId} and ${t.day} = ${day}`);
  return row?.accepted ?? 0;
}

const FREE_POOL_COUNTERS = ["sent", "sent_no_feedback", "hard_bounced", "complained"] as const;

/**
 * Adds a team's deliverability counts to the Free pool it is in when they are
 * written (freePoolOwner), if any, in the caller's transaction; usage_counters
 * names them. Call after the team's own counter bump: rows lock team first,
 * pool second. Column names come from FREE_POOL_COUNTERS only, never from input.
 */
export async function bumpFreePoolUsage(
  db: Db,
  params: {
    teamId: string;
    day: string;
    counts: Partial<Record<(typeof FREE_POOL_COUNTERS)[number], number>>;
  },
): Promise<void> {
  const entries = FREE_POOL_COUNTERS.flatMap((c) => {
    const n = params.counts[c];
    return n ? [[c, n] as const] : [];
  });
  if (entries.length === 0) return;
  const tm = schema.teams;
  const [team] = await db
    .select({ plan: tm.plan, currentPeriodEnd: tm.currentPeriodEnd, poolOwnerId: tm.poolOwnerId })
    .from(tm)
    .where(eq(tm.id, params.teamId));
  const ownerId = team ? freePoolOwner(team) : null;
  if (!ownerId) return;
  const p = schema.freePoolUsage;
  await db.execute(sql`
    insert into ${p} (owner_id, day, ${sql.raw(entries.map(([c]) => c).join(", "))})
    values (${ownerId}, ${params.day}, ${sql.join(
      entries.map(([, n]) => sql`${n}`),
      sql`, `,
    )})
    on conflict (owner_id, day) do update set ${sql.join(
      entries.map(([c, n]) => sql`${sql.raw(c)} = ${p}.${sql.raw(c)} + ${n}`),
      sql`, `,
    )}
  `);
}

/**
 * Books `n` recipients of a Free pool into its burst allowance (FREE_BURST at
 * once, then one every FREE_BURST_REFILL_MS) and returns when they may go:
 * `now` while the allowance holds them, else the instant it has refilled
 * enough. A GCRA in one upsert, so parallel lanes serialize on the pool's
 * row; it always books and never refuses, and the caller holds the mail
 * until the slot.
 */
export async function bookFreeBurst(db: Db, ownerId: string, n: number, now: Date): Promise<Date> {
  const b = schema.freePoolBursts;
  const step = n * FREE_BURST_REFILL_MS;
  const [row] = await db
    .insert(b)
    .values({ ownerId, tat: new Date(now.getTime() + step) })
    .onConflictDoUpdate({
      target: b.ownerId,
      set: {
        tat: sql`greatest(${b.tat}, ${now.toISOString()}::timestamptz) + ${step} * interval '1 millisecond'`,
      },
    })
    .returning({ tat: b.tat });
  if (!row) throw new Error("free burst booking returned no row");
  return new Date(Math.max(now.getTime(), row.tat.getTime() - FREE_BURST * FREE_BURST_REFILL_MS));
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
