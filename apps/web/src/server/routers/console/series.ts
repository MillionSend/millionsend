import { utcDay } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, asc, desc, eq, gte, lte, type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { dayKeys, hourKeys, type ResolvedPeriod } from "../../console/periods";

export interface CounterPoint {
  /** The UTC day ("YYYY-MM-DD") or the hour's ISO instant. */
  t: string;
  sent: number;
  delivered: number;
  bounced: number;
  hardBounced: number;
  complained: number;
}

const ZERO = { sent: 0, delivered: 0, bounced: 0, hardBounced: 0, complained: 0 };

// ::bigint — an instance-wide sum of int columns overflows int4 for a large
// sender; the driver returns bigint as a string, exact through Number().
const total = (col: AnyPgColumn | SQL) => sql<string>`coalesce(sum(${col}), 0)::bigint`;

/**
 * The counter rows a period covers: hourly rows over a day, daily rows (by
 * UTC day) for anything longer. The KPI series and its per-team breakdowns
 * read this one window, so the teams add up to the chart beside them.
 */
function windowRows(period: ResolvedPeriod) {
  if (period.grain === "hour") {
    const h = schema.usageCountersHourly;
    return { table: h, at: h.hour, where: and(gte(h.hour, period.from), lte(h.hour, period.to)) };
  }
  const c = schema.usageCounters;
  return {
    table: c,
    at: c.day,
    where: and(gte(c.day, utcDay(period.from)), lte(c.day, utcDay(period.to))),
  };
}

/** A point's key as instanceCounterSeries prints it: the hour's ISO instant, or the UTC day. */
function pointKey(period: ResolvedPeriod, at: string): string {
  return period.grain === "hour" ? new Date(at).toISOString() : at;
}

/**
 * Instance-wide counters summed across every team, one point per hour
 * (usage_counters_hourly) or per UTC day (usage_counters), zero-filled so a
 * chart always spans the window.
 */
export async function instanceCounterSeries(
  db: Db,
  period: ResolvedPeriod,
): Promise<CounterPoint[]> {
  const { table: c, at, where } = windowRows(period);
  const rows = await db
    .select({
      t: period.grain === "hour" ? sql<string>`${at}` : sql<string>`${at}::text`,
      sent: total(c.sent),
      delivered: total(c.delivered),
      bounced: total(c.bounced),
      hardBounced: total(c.hardBounced),
      complained: total(c.complained),
    })
    .from(c)
    .where(where)
    .groupBy(at)
    .orderBy(at);
  const byKey = new Map(rows.map((r) => [pointKey(period, r.t), r]));
  const keys =
    period.grain === "hour" ? hourKeys(period.from, period.to) : dayKeys(period.from, period.to);
  return keys.map((t) => toPoint(t, byKey.get(t)));
}

function toPoint(
  t: string,
  row:
    | { sent: string; delivered: string; bounced: string; hardBounced: string; complained: string }
    | undefined,
): CounterPoint {
  if (!row) return { t, ...ZERO };
  return {
    t,
    sent: Number(row.sent),
    delivered: Number(row.delivered),
    bounced: Number(row.bounced),
    hardBounced: Number(row.hardBounced),
    complained: Number(row.complained),
  };
}

export function sumPoints(points: readonly CounterPoint[]): Omit<CounterPoint, "t"> {
  return points.reduce(
    (acc, p) => ({
      sent: acc.sent + p.sent,
      delivered: acc.delivered + p.delivered,
      bounced: acc.bounced + p.bounced,
      hardBounced: acc.hardBounced + p.hardBounced,
      complained: acc.complained + p.complained,
    }),
    { ...ZERO },
  );
}

export type FeedbackKind = "hardBounced" | "complained";

/**
 * The teams behind a feedback KPI over a period, most first: per-team sums
 * of the rows instanceCounterSeries sums, so they add up to the card. The
 * rate divides by the team's own sends in the window, as the card does; it
 * is null when the team sent nothing there or drew more than it sent, both
 * feedback about earlier mail (counters take the day it arrives).
 */
export async function teamFeedbackTotals(
  db: Db,
  period: ResolvedPeriod,
  kind: FeedbackKind,
  limit = 100,
) {
  const { table: c, at, where } = windowRows(period);
  const lastAt = sql<string>`max(${at}) filter (where ${c[kind]} > 0)`;
  const byTeam = db
    .select({
      teamId: c.teamId,
      sent: total(c.sent).as("sent"),
      n: total(c[kind]).as("n"),
      lastAt: (period.grain === "hour" ? lastAt : sql<string>`${lastAt}::text`).as("last_at"),
    })
    .from(c)
    .where(where)
    .groupBy(c.teamId)
    .as("by_team");
  const t = schema.teams;
  const st = schema.teamStandings;
  const rate = sql<
    number | null
  >`case when ${byTeam.sent} >= ${byTeam.n} then ${byTeam.n}::float8 / ${byTeam.sent} end`;
  const rows = await db
    .select({
      id: t.id,
      name: t.name,
      logoUrl: t.logoUrl,
      plan: sql<string>`${t.plan}::text`,
      planQuota: t.planQuota,
      createdAt: t.createdAt,
      suspendedAt: t.suspendedAt,
      suspensionReason: t.suspensionReason,
      broadcastsPausedByOperatorAt: t.broadcastsPausedByOperatorAt,
      guardrail: st.guardrail,
      guardrailMetric: st.guardrailMetric,
      complaintRate7d: st.complaintRate7d,
      hardBounceRate7d: st.hardBounceRate7d,
      sent: byTeam.sent,
      count: byTeam.n,
      rate,
      lastAt: byTeam.lastAt,
      // Window functions run before the limit: every team with one, and all of them summed.
      teams: sql<number>`(count(*) over ())::int`,
      total: sql<string>`(sum(${byTeam.n}) over ())::bigint`,
    })
    .from(byTeam)
    .innerJoin(t, eq(t.id, byTeam.teamId))
    .leftJoin(st, eq(st.teamId, t.id))
    .where(sql`${byTeam.n} > 0`)
    .orderBy(desc(byTeam.n), sql`${rate} desc nulls last`, asc(t.name), asc(t.id))
    .limit(limit);
  return {
    teams: rows[0]?.teams ?? 0,
    total: Number(rows[0]?.total ?? 0),
    rows: rows.map(({ teams: _teams, total: _total, ...row }) => ({
      ...row,
      sent: Number(row.sent),
      count: Number(row.count),
      lastAt: pointKey(period, row.lastAt),
    })),
  };
}

/** How many teams a feedback chart's hover tip names per point. */
const TIP_TEAMS = 5;

/**
 * Each point's teams for a feedback chart's hover tip, keyed as the chart's
 * points: for every bucket with one, the teams with the most (ties by
 * name), and how many teams and events the rest add up to.
 */
export async function bucketFeedbackTeams(db: Db, period: ResolvedPeriod, kind: FeedbackKind) {
  const { table: c, at, where } = windowRows(period);
  const t = schema.teams;
  const ranked = db
    .select({
      at: (period.grain === "hour" ? sql<string>`${at}` : sql<string>`${at}::text`).as("at"),
      name: t.name,
      n: sql<number>`${c[kind]}`.as("n"),
      rank: sql<number>`row_number() over (partition by ${at} order by ${c[kind]} desc, ${t.name}, ${t.id})`.as(
        "rank",
      ),
      teams: sql<number>`(count(*) over (partition by ${at}))::int`.as("teams"),
      total: sql<string>`(sum(${c[kind]}) over (partition by ${at}))::bigint`.as("total"),
    })
    .from(c)
    .innerJoin(t, eq(t.id, c.teamId))
    .where(and(where, sql`${c[kind]} > 0`))
    .as("ranked");
  const rows = await db
    .select()
    .from(ranked)
    .where(lte(ranked.rank, TIP_TEAMS))
    .orderBy(asc(ranked.at), asc(ranked.rank));
  const buckets: {
    t: string;
    top: { name: string; count: number }[];
    moreTeams: number;
    moreCount: number;
  }[] = [];
  for (const row of rows) {
    const key = pointKey(period, row.at);
    let bucket = buckets.at(-1);
    if (bucket?.t !== key) {
      bucket = { t: key, top: [], moreTeams: row.teams, moreCount: Number(row.total) };
      buckets.push(bucket);
    }
    bucket.top.push({ name: row.name, count: row.n });
    bucket.moreTeams -= 1;
    bucket.moreCount -= row.n;
  }
  return buckets;
}

/**
 * A team's traffic is attributed to the region of its most recently
 * verified domain, the convention the platform breaker's weekly window
 * uses (usage counters carry no domain).
 * ponytail: a team with verified domains in two regions has all of its
 * series drawn in one of them, while the headline counts beside them split
 * its rows by the sending domain; split the series by joining emails to
 * domains when such teams matter.
 */
export function teamRegionSubquery(db: Db) {
  const d = schema.domains;
  return db
    .selectDistinctOn([d.teamId], { teamId: d.teamId, region: d.region })
    .from(d)
    .orderBy(d.teamId, sql`${d.verifiedAt} desc nulls last`, sql`${d.createdAt} desc`)
    .as("team_region");
}

/** Sends per region over the trailing whole UTC days (today included). */
export async function regionDailySends(
  db: Db,
  opts: { now: Date; days: number },
): Promise<Map<string, { t: string; sent: number }[]>> {
  const c = schema.usageCounters;
  const teamRegion = teamRegionSubquery(db);
  const from = new Date(`${utcDay(opts.now.getTime() - (opts.days - 1) * 86_400_000)}T00:00:00Z`);
  const rows = await db
    .select({ region: teamRegion.region, t: sql<string>`${c.day}::text`, sent: total(c.sent) })
    .from(c)
    .innerJoin(teamRegion, sql`${teamRegion.teamId} = ${c.teamId}`)
    .where(gte(c.day, utcDay(from)))
    .groupBy(teamRegion.region, c.day);
  const keys = dayKeys(from, opts.now);
  const out = new Map<string, { t: string; sent: number }[]>();
  for (const row of rows) {
    const series = out.get(row.region) ?? keys.map((t) => ({ t, sent: 0 }));
    const point = series.find((p) => p.t === row.t);
    if (point) point.sent = Number(row.sent);
    out.set(row.region, series);
  }
  return out;
}

/** The empty series a region with no traffic shows, on the same axis as the others. */
export function emptyDaily(now: Date, days: number): { t: string; sent: number }[] {
  const from = new Date(`${utcDay(now.getTime() - (days - 1) * 86_400_000)}T00:00:00Z`);
  return dayKeys(from, now).map((t) => ({ t, sent: 0 }));
}
