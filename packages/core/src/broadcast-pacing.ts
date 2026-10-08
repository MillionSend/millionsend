import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, asc, eq, gte, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { resultRows } from "./driver-result.js";
import {
  type LadderPlan,
  PAID_RUNGS,
  PLAN_RUNGS,
  type PlanRung,
  quotaPeriod,
  type TeamQuota,
  teamRung,
} from "./plans.js";
import { readPeriodUsage, releaseQuota } from "./quota.js";
import {
  type BroadcastEstimate,
  bulkShare,
  type PlanCap,
  type PlannedBroadcast,
  planBulkWaves,
  planCaps,
  SES_QUOTA_SLOT_MS,
  transactionalSent24h,
} from "./ses-capacity.js";
import { fetchTeamQuota } from "./team-plan.js";
import { DAY_MS, utcDay } from "./utc-day.js";

/**
 * The database side of broadcast pacing: what the worker's room ledger, the
 * send planner and the console read about bulk mail per SES region. A
 * region is the sender domain's, so every count joins domains.
 */

export interface RegionBulkCounts {
  /** Broadcast rows SES accepted in the last 24 hours. */
  sent24h: number;
  /** Every row SES accepted in the last 24 hours, transactional included. */
  allSent24h: number;
  /** Broadcast rows queued with a job (the wave in flight). */
  queued: number;
}

/** Sends and queued bulk rows per region; a region with neither is absent. */
export async function regionBulkCounts(
  db: Db,
  now: Date = new Date(),
): Promise<Map<string, RegionBulkCounts>> {
  const e = schema.emails;
  const d = schema.domains;
  const out = new Map<string, RegionBulkCounts>();
  const sent = await db
    .select({
      region: d.region,
      all: sql<number>`count(*)::int`,
      bulk: sql<number>`count(*) filter (where ${e.broadcastId} is not null)::int`,
    })
    .from(e)
    .innerJoin(d, eq(d.id, e.domainId))
    .where(gte(e.sentAt, new Date(now.getTime() - DAY_MS)))
    .groupBy(d.region);
  for (const row of sent) {
    out.set(row.region, { sent24h: row.bulk, allSent24h: row.all, queued: 0 });
  }
  const queued = await db
    .select({ region: d.region, n: sql<number>`count(*)::int` })
    .from(e)
    .innerJoin(d, eq(d.id, e.domainId))
    .where(and(eq(e.latestStatus, "queued"), isNotNull(e.broadcastId)))
    .groupBy(d.region);
  for (const row of queued) {
    out.set(row.region, { sent24h: 0, allSent24h: 0, ...out.get(row.region), queued: row.n });
  }
  return out;
}

// Raw statements bind instants as ISO strings with a cast: postgres-js
// refuses a Date parameter here, which PGlite (the test driver) accepts.
/** Bulk sends in one region over the last 24 hours, by drain slot, for the planner's window. */
export async function bulkSentBySlot(
  db: Db,
  opts: { region: string; now?: Date },
): Promise<{ at: number; count: number }[]> {
  const now = opts.now ?? new Date();
  const e = schema.emails;
  const d = schema.domains;
  const slotSeconds = SES_QUOTA_SLOT_MS / 1000;
  const rows = resultRows<{ at: string; n: number }>(
    await db.execute(sql`
      select to_timestamp(floor(extract(epoch from ${e.sentAt}) / ${slotSeconds}) * ${slotSeconds}) as at,
        count(*)::int as n
      from ${e} join ${d} on ${d.id} = ${e.domainId}
      where ${e.sentAt} >= ${new Date(now.getTime() - DAY_MS).toISOString()}::timestamptz
        and ${e.broadcastId} is not null
        and ${d.region} = ${opts.region}
      group by 1
      order by 1
    `),
  );
  return rows.map((r) => ({ at: new Date(r.at).getTime(), count: Number(r.n) }));
}

export interface SendingBroadcast {
  id: string;
  teamId: string;
  scheduledAt: Date | null;
  /** The sender domain's region, read off its rows; null before the first page is written. */
  region: string | null;
  queued: number;
  parked: number;
  sent: number;
}

/**
 * Broadcasts still going out, oldest first (the drain's FIFO), with their
 * rows by state. `region` and `teamId` narrow the list; the counts are per
 * broadcast over the emails table, so callers ask only when a sending
 * broadcast exists.
 */
export async function sendingBroadcasts(
  db: Db,
  opts: { region?: string; teamId?: string } = {},
): Promise<SendingBroadcast[]> {
  const b = schema.broadcasts;
  // Spelled out: inside a scalar subquery drizzle leaves column names
  // unqualified, and emails, domains and broadcasts all have an id.
  const region = sql<
    string | null
  >`(select d.region from emails e join domains d on d.id = e.domain_id where e.broadcast_id = broadcasts.id limit 1)`;
  const countWhere = (status: "queued" | "queued_quota") =>
    sql<number>`(select count(*)::int from emails e where e.broadcast_id = broadcasts.id and e.latest_status = ${status})`;
  const rows = await db
    .select({
      id: b.id,
      teamId: b.teamId,
      scheduledAt: b.scheduledAt,
      region,
      queued: countWhere("queued"),
      // Contacts the walk has not reached yet wait like parked rows; the
      // walk writes far faster than the drain releases, so they are always
      // there by their slot. Written rows can outrun the audience when
      // contacts join mid-walk, hence the floor.
      parked: sql<number>`(select count(*) filter (where e.latest_status = 'queued_quota')::int + case when broadcasts.recipient_count is null then greatest(0, coalesce(broadcasts.audience_count, 0) - count(*)::int) else 0 end from emails e where e.broadcast_id = broadcasts.id)`,
      sent: sql<number>`(select count(*)::int from emails e where e.broadcast_id = broadcasts.id and e.sent_at is not null)`,
    })
    .from(b)
    .where(and(eq(b.status, "sending"), opts.teamId ? eq(b.teamId, opts.teamId) : undefined))
    .orderBy(asc(b.scheduledAt), asc(b.createdAt), asc(b.id));
  return rows.filter((r) => !opts.region || r.region === opts.region);
}

/** Sends the team has accepted so far against its caps: today's UTC day, and the billing period on a monthly plan. */
export async function quotaUsage(
  db: Db,
  teamId: string,
  quota: TeamQuota,
  now: Date = new Date(),
): Promise<{ day: number; period: number }> {
  const c = schema.usageCounters;
  const [today] = await db
    .select({ accepted: c.accepted })
    .from(c)
    .where(and(eq(c.teamId, teamId), eq(c.day, utcDay(now))));
  const period =
    quota.kind === "month" ? (await readPeriodUsage(db, teamId, quota.periodStart)).accepted : 0;
  return { day: today?.accepted ?? 0, period };
}

const CANCEL_PAGE = 1000;

/**
 * Stops the rest of a broadcast: every row still waiting (parked, or queued
 * with a job) flips to canceled in pages, and the reservations the queued
 * rows held go back to the team's counter in one release. Rows already
 * claimed by a send lane are left alone; a job that finds a canceled row
 * skips it. Returns how many rows were stopped.
 */
export async function cancelBroadcastRows(
  db: Db,
  params: { broadcastId: string; teamId: string; now?: Date },
): Promise<number> {
  const now = params.now ?? new Date();
  const e = schema.emails;
  const flip = async (from: "queued_quota" | "queued"): Promise<number> => {
    let n = 0;
    for (;;) {
      const rows = await db
        .update(e)
        .set({ latestStatus: "canceled" })
        .where(
          inArray(
            e.id,
            db
              .select({ id: e.id })
              .from(e)
              .where(
                and(
                  eq(e.broadcastId, params.broadcastId),
                  eq(e.teamId, params.teamId),
                  eq(e.latestStatus, from),
                  isNull(e.sentAt),
                ),
              )
              .limit(CANCEL_PAGE),
          ),
        )
        .returning({ id: e.id });
      n += rows.length;
      if (rows.length < CANCEL_PAGE) return n;
    }
  };
  // Rows the send lane parks between the two flips are caught by the next
  // round; the sweep ends only when a full round moved nothing.
  let parked = 0;
  let queued = 0;
  for (;;) {
    const p = await flip("queued_quota");
    const q = await flip("queued");
    parked += p;
    queued += q;
    if (p === 0 && q === 0) break;
  }
  if (queued > 0) {
    // Against the counter accept charged, read the way parking reads it.
    const quota = await fetchTeamQuota(db, params.teamId, true);
    if (quota) {
      await releaseQuota(db, {
        teamId: params.teamId,
        count: queued,
        quota,
        day: utcDay(now),
        at: now,
      });
    }
  }
  return parked + queued;
}

/** The busiest UTC day of the last `days` in a region, transactional and bulk apart, for the reserve hint and the quota request. */
export async function regionDailyPeaks(
  db: Db,
  opts: { region: string; days?: number; now?: Date },
): Promise<{ txPeak: number; bulkPeak: number }> {
  const now = opts.now ?? new Date();
  const days = opts.days ?? 7;
  const e = schema.emails;
  const d = schema.domains;
  const rows = resultRows<{ tx: number; bulk: number }>(
    await db.execute(sql`
      select count(*) filter (where ${e.broadcastId} is null)::int as tx,
        count(*) filter (where ${e.broadcastId} is not null)::int as bulk
      from ${e} join ${d} on ${d.id} = ${e.domainId}
      where ${e.sentAt} >= ${new Date(now.getTime() - days * DAY_MS).toISOString()}::timestamptz
        and ${d.region} = ${opts.region}
      group by (${e.sentAt} at time zone 'UTC')::date
    `),
  );
  return {
    txPeak: Math.max(0, ...rows.map((r) => Number(r.tx))),
    bulkPeak: Math.max(0, ...rows.map((r) => Number(r.bulk))),
  };
}

/** The numbers GetAccount reports for a region, as the planner needs them. */
export interface RegionCapacity {
  max24h: number;
  sentLast24h: number;
  maxSendRate: number;
}

export interface RegionSendPlanInput {
  region: string;
  account: RegionCapacity;
  reservePercent: number;
  /** The instance's send-rate ceiling (SES_MAX_SEND_RATE or its override). */
  rateCeiling: number;
  horizonDays: number;
  now?: Date;
  /** The caps of a team's own broadcasts in flight, so a plan-held one is not promised a capacity-only finish. */
  capsFor?: (teamId: string) => PlanCap[] | undefined;
  /** A send about to be initiated, planned alongside the broadcasts already going out in the region. */
  newSend?: {
    key: string;
    count: number;
    at: Date;
    spacingMs?: number;
    caps?: PlanCap[];
  };
}

export interface RegionSendPlan {
  share: number;
  txPerDay: number;
  /** One estimate per sending broadcast (keyed by id), plus the new send under its key. */
  estimates: BroadcastEstimate[];
  sending: SendingBroadcast[];
}

/**
 * The planner over a region's live state: the account's numbers (from the
 * caller's GetAccount), the window of bulk sends, the broadcasts still going
 * out and, when given, the send being initiated. Every surface prints from
 * this one run, so the composer, the list, the API and the owner mail agree.
 */
export async function planRegionSend(db: Db, input: RegionSendPlanInput): Promise<RegionSendPlan> {
  const now = input.now ?? new Date();
  const [counts, sentBySlot, sending] = await Promise.all([
    regionBulkCounts(db, now),
    bulkSentBySlot(db, { region: input.region, now }),
    sendingBroadcasts(db, { region: input.region }),
  ]);
  const share = bulkShare(input.account.max24h, input.reservePercent);
  const txPerDay = transactionalSent24h({
    sesSentLast24h: input.account.sentLast24h,
    allSent24h: counts.get(input.region)?.allSent24h ?? 0,
    bulkSent24h: counts.get(input.region)?.sent24h ?? 0,
  });
  const broadcasts: PlannedBroadcast[] = sending.map((b) => {
    const caps = input.capsFor?.(b.teamId);
    return {
      key: b.id,
      queued: b.queued,
      parked: b.parked,
      // Its days count from when it was sent, as every surface prints them.
      ...(b.scheduledAt ? { at: Math.min(b.scheduledAt.getTime(), now.getTime()) } : {}),
      ...(caps ? { caps } : {}),
    };
  });
  if (input.newSend) {
    broadcasts.push({
      key: input.newSend.key,
      admit: input.newSend.count,
      at: input.newSend.at,
      ...(input.newSend.spacingMs ? { spacingMs: input.newSend.spacingMs } : {}),
      ...(input.newSend.caps ? { caps: input.newSend.caps } : {}),
    });
  }
  const estimates = planBulkWaves({
    share,
    rate: Math.min(input.account.maxSendRate || input.rateCeiling, input.rateCeiling),
    txPerDay,
    sentBySlot,
    start: now,
    broadcasts,
    horizonDays: input.horizonDays,
  });
  return { share, txPerDay, estimates, sending };
}

/**
 * The cheapest plan whose cap would let the whole send go out within the
 * horizon: the team's own monthly rung with overage on, else the next rungs
 * up. Null when none fits (or the team is not on the ladder). `plan` runs
 * the planner once per candidate cap set.
 */
export function rungThatFits(
  current: TeamQuota,
  used: { day: number; period: number },
  now: Date,
  plan: (caps: PlanCap[]) => BroadcastEstimate | undefined,
): { rung: PlanRung; overage: boolean } | null {
  if (current.kind === "none") return null;
  const fits = (caps: PlanCap[]) => {
    const estimate = plan(caps);
    return estimate !== undefined && !estimate.blocked && estimate.planHold === null;
  };
  // Nothing to name when the team's own cap already lets the send through.
  if (fits(planCaps(current, used, now))) return null;
  const here = teamRung(current.plan, current.kind === "month" ? current.included : null);
  if (current.kind === "month" && !current.overage) {
    if (fits(planCaps({ ...current, overage: true }, used, now))) {
      return { rung: here, overage: true };
    }
  }
  const period = quotaPeriod(
    current.kind === "month"
      ? { currentPeriodStart: current.periodStart, currentPeriodEnd: current.periodEnd }
      : { currentPeriodStart: null, currentPeriodEnd: null },
    now,
  );
  for (const rung of PAID_RUNGS) {
    if (
      PLAN_RUNGS.indexOf(rung as (typeof PLAN_RUNGS)[number]) <=
      PLAN_RUNGS.indexOf(here as (typeof PLAN_RUNGS)[number])
    )
      continue;
    const quota: TeamQuota =
      rung.period === "day"
        ? { kind: "day", plan: rung.plan as LadderPlan, limit: rung.included }
        : {
            kind: "month",
            plan: rung.plan as LadderPlan,
            included: rung.included,
            periodStart: period.start,
            periodEnd: period.end,
            overage: false,
            overageCentsPer1k: rung.overageCentsPer1k ?? 0,
          };
    if (fits(planCaps(quota, used, now))) return { rung, overage: false };
  }
  return null;
}
