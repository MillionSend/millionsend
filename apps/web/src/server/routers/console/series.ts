import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, gte, lte, sql } from "drizzle-orm";
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
const total = (col: AnyPgColumn) => sql<string>`coalesce(sum(${col}), 0)::bigint`;

/**
 * Instance-wide counters summed across every team, one point per hour
 * (usage_counters_hourly) or per UTC day (usage_counters), zero-filled so a
 * chart always spans the window.
 */
export async function instanceCounterSeries(
  db: Db,
  period: ResolvedPeriod,
): Promise<CounterPoint[]> {
  if (period.grain === "hour") {
    const h = schema.usageCountersHourly;
    const rows = await db
      .select({
        t: sql<string>`${h.hour}`,
        sent: total(h.sent),
        delivered: total(h.delivered),
        bounced: total(h.bounced),
        hardBounced: total(h.hardBounced),
        complained: total(h.complained),
      })
      .from(h)
      .where(and(gte(h.hour, period.from), lte(h.hour, period.to)))
      .groupBy(h.hour)
      .orderBy(h.hour);
    const byHour = new Map(rows.map((r) => [new Date(r.t).toISOString(), r]));
    return hourKeys(period.from, period.to).map((t) => toPoint(t, byHour.get(t)));
  }
  const c = schema.usageCounters;
  const rows = await db
    .select({
      t: sql<string>`${c.day}::text`,
      sent: total(c.sent),
      delivered: total(c.delivered),
      bounced: total(c.bounced),
      hardBounced: total(c.hardBounced),
      complained: total(c.complained),
    })
    .from(c)
    .where(and(gte(c.day, isoDay(period.from)), lte(c.day, isoDay(period.to))))
    .groupBy(c.day)
    .orderBy(c.day);
  const byDay = new Map(rows.map((r) => [r.t, r]));
  return dayKeys(period.from, period.to).map((t) => toPoint(t, byDay.get(t)));
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
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

/** Sends per UTC hour per region over the trailing `hours`, zero-filled. */
export async function regionHourlySends(
  db: Db,
  opts: { now: Date; hours: number },
): Promise<Map<string, { t: string; sent: number }[]>> {
  const h = schema.usageCountersHourly;
  const teamRegion = teamRegionSubquery(db);
  const from = new Date(opts.now.getTime() - opts.hours * 3_600_000);
  const rows = await db
    .select({ region: teamRegion.region, t: sql<string>`${h.hour}`, sent: total(h.sent) })
    .from(h)
    .innerJoin(teamRegion, sql`${teamRegion.teamId} = ${h.teamId}`)
    .where(gte(h.hour, from))
    .groupBy(teamRegion.region, h.hour);
  const keys = hourKeys(from, opts.now);
  const out = new Map<string, { t: string; sent: number }[]>();
  for (const row of rows) {
    const series = out.get(row.region) ?? keys.map((t) => ({ t, sent: 0 }));
    const point = series.find((p) => p.t === new Date(row.t).toISOString());
    if (point) point.sent = Number(row.sent);
    out.set(row.region, series);
  }
  return out;
}

/** Sends per region over the trailing whole UTC days (today included). */
export async function regionDailySends(
  db: Db,
  opts: { now: Date; days: number },
): Promise<Map<string, { t: string; sent: number }[]>> {
  const c = schema.usageCounters;
  const teamRegion = teamRegionSubquery(db);
  const from = new Date(
    `${isoDay(new Date(opts.now.getTime() - (opts.days - 1) * 86_400_000))}T00:00:00Z`,
  );
  const rows = await db
    .select({ region: teamRegion.region, t: sql<string>`${c.day}::text`, sent: total(c.sent) })
    .from(c)
    .innerJoin(teamRegion, sql`${teamRegion.teamId} = ${c.teamId}`)
    .where(gte(c.day, isoDay(from)))
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
export function emptyHourly(now: Date, hours: number): { t: string; sent: number }[] {
  return hourKeys(new Date(now.getTime() - hours * 3_600_000), now).map((t) => ({ t, sent: 0 }));
}

export function emptyDaily(now: Date, days: number): { t: string; sent: number }[] {
  const from = new Date(`${isoDay(new Date(now.getTime() - (days - 1) * 86_400_000))}T00:00:00Z`);
  return dayKeys(from, now).map((t) => ({ t, sent: 0 }));
}
