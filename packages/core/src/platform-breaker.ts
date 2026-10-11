import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import type { RegionBreakerReason } from "@millionsend/db/schema";
import { and, asc, desc, eq, gte, inArray, isNotNull, notInArray, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { MIN_PAUSE_HARD_BOUNCES } from "./deliverability.js";
import { DAY_MS, utcDay } from "./utc-day.js";

/**
 * SES enforces bounce/complaint rates on the whole account per region: one
 * team's bad week pauses every customer in that region. The breaker watches
 * the aggregate and holds broadcasts (never transactional mail) short of
 * SES's own lines, so the platform stops itself before AWS does.
 */
// 80% of SES's bounce review line (5%), written as a literal: 0.8 * 0.05 is
// 0.04000000000000001 in floating point, and 40 bounces in 1000 must trip.
export const BREAKER_BOUNCE_RATE = 0.04;
/** Sends a region needs in a window before its aggregate rate means anything. */
export const BREAKER_MIN_SENT = 1000;
export const BREAKER_WINDOWS_HOURS = [24, 24 * 7] as const;
/**
 * Complaints are judged on SES's own rate (Reputation.ComplaintRate), the one
 * its review and pause lines apply to. It counts only the mailbox providers
 * that report complaints, so it runs well above our own count over all mail.
 */
export const SES_COMPLAINT_REVIEW_RATE = 0.001;
export const SES_COMPLAINT_PAUSE_RATE = 0.005;
/** The operator hears at this rate, a day apart while it stays there. */
export const SES_COMPLAINT_ALERT_RATE = 0.003;
export const BREAKER_SES_COMPLAINT_RATE = 0.004;

export interface RegionWindowCounts {
  sent: number;
  hardBounced: number;
  complained: number;
}

export interface RegionContributor {
  teamId: string;
  teamName: string;
  hardBounced: number;
  complained: number;
}

export interface RegionDecision {
  region: string;
  trip: boolean;
  reason?: RegionBreakerReason;
  contributors: RegionContributor[];
}

const HOUR_MS = 60 * 60 * 1000;
// Bounce class lives in the stored SES payload (process-ses-event writes the
// raw bounce object under data.bounce), so hard bounces are read back from it.
// The column is authoritative; the json path covers rows written before it
// existed (until retention strips their payload).
const hardBounceFilter = sql`${schema.emailEvents.type} = 'bounced' and coalesce(${schema.emailEvents.bounceType}, ${schema.emailEvents.data}->'bounce'->>'bounceType') = 'Permanent'`;
const complaintFilter = sql`${schema.emailEvents.type} = 'complained'`;

/**
 * Sends and SES-reported hard bounces/complaints per region over the trailing
 * window, from the rows themselves; `teamIds` narrows the scan to those teams.
 */
export async function regionWindowCounts(
  db: Db,
  opts: { now: Date; hours: number; teamIds?: string[]; since?: Date },
): Promise<Map<string, RegionWindowCounts>> {
  const since = opts.since ?? new Date(opts.now.getTime() - opts.hours * HOUR_MS);
  const teamFilter = opts.teamIds ? inArray(schema.emails.teamId, opts.teamIds) : undefined;
  const out = new Map<string, RegionWindowCounts>();
  const sent = await db
    .select({ region: schema.domains.region, n: sql<number>`count(*)::int` })
    .from(schema.emails)
    .innerJoin(schema.domains, eq(schema.domains.id, schema.emails.domainId))
    .where(and(gte(schema.emails.sentAt, since), teamFilter))
    .groupBy(schema.domains.region);
  for (const row of sent) out.set(row.region, { sent: row.n, hardBounced: 0, complained: 0 });
  const events = await db
    .select({
      region: schema.domains.region,
      hardBounced: sql<number>`count(*) filter (where ${hardBounceFilter})::int`,
      complained: sql<number>`count(*) filter (where ${complaintFilter})::int`,
    })
    .from(schema.emailEvents)
    .innerJoin(schema.emails, eq(schema.emails.id, schema.emailEvents.emailId))
    .innerJoin(schema.domains, eq(schema.domains.id, schema.emails.domainId))
    .where(
      and(
        gte(schema.emailEvents.createdAt, since),
        isNotNull(schema.emailEvents.snsMessageId),
        teamFilter,
      ),
    )
    .groupBy(schema.domains.region);
  for (const row of events) {
    const counts = out.get(row.region) ?? { sent: 0, hardBounced: 0, complained: 0 };
    out.set(row.region, { ...counts, hardBounced: row.hardBounced, complained: row.complained });
  }
  return out;
}

/**
 * The same totals over the trailing `days` UTC days (today included) from
 * usage_counters, which the send and SES-event paths bump alongside the
 * rows the raw scan reads: `sent` per accepted send, `hard_bounced` per
 * Permanent bounce, `complained` per complaint. Counters carry no domain,
 * so a team's traffic goes to the region of its most recently verified
 * domain. A team whose verified domains span more than one region cannot
 * be attributed that way: it is left out of the counters and its window is
 * read from the rows over the same span (bounded: only those teams' rows).
 */
export async function regionCounterTotals(
  db: Db,
  opts: { now: Date; days: number },
): Promise<Map<string, RegionWindowCounts>> {
  const since = utcDay(opts.now.getTime() - (opts.days - 1) * DAY_MS);
  const c = schema.usageCounters;
  const d = schema.domains;
  const multiRegion = (
    await db
      .select({ teamId: d.teamId })
      .from(d)
      .where(eq(d.status, "verified"))
      .groupBy(d.teamId)
      .having(sql`count(distinct ${d.region}) > 1`)
  ).map((r) => r.teamId);
  const teamRegion = db
    .selectDistinctOn([d.teamId], { teamId: d.teamId, region: d.region })
    .from(d)
    .orderBy(asc(d.teamId), sql`${d.verifiedAt} desc nulls last`, desc(d.createdAt))
    .as("team_region");
  // ::bigint — a region's weekly sum can overflow int4; the driver returns
  // bigint as a string, exact through Number() up to 2^53.
  const total = (col: AnyPgColumn) => sql<string>`coalesce(sum(${col}), 0)::bigint`;
  const rows = await db
    .select({
      region: teamRegion.region,
      sent: total(c.sent),
      hardBounced: total(c.hardBounced),
      complained: total(c.complained),
    })
    .from(c)
    .innerJoin(teamRegion, eq(teamRegion.teamId, c.teamId))
    .where(
      and(
        gte(c.day, since),
        multiRegion.length > 0 ? notInArray(c.teamId, multiRegion) : undefined,
      ),
    )
    .groupBy(teamRegion.region);
  const out = new Map<string, RegionWindowCounts>();
  for (const row of rows) {
    const counts = {
      sent: Number(row.sent),
      hardBounced: Number(row.hardBounced),
      complained: Number(row.complained),
    };
    if (counts.sent > 0 || counts.hardBounced > 0 || counts.complained > 0) {
      out.set(row.region, counts);
    }
  }
  if (multiRegion.length > 0) {
    const raw = await regionWindowCounts(db, {
      now: opts.now,
      hours: opts.days * 24,
      // Same span as the counters: whole UTC days, not a trailing window.
      since: new Date(`${since}T00:00:00Z`),
      teamIds: multiRegion,
    });
    for (const [region, counts] of raw) {
      const base = out.get(region) ?? { sent: 0, hardBounced: 0, complained: 0 };
      out.set(region, {
        sent: base.sent + counts.sent,
        hardBounced: base.hardBounced + counts.hardBounced,
        complained: base.complained + counts.complained,
      });
    }
  }
  return out;
}

/** Teams behind a region's events over the tripping window, worst first. */
async function contributors(
  db: Db,
  region: string,
  now: Date,
  hours: number,
): Promise<RegionContributor[]> {
  const since = new Date(now.getTime() - hours * HOUR_MS);
  const hardBounced = sql<number>`count(*) filter (where ${hardBounceFilter})::int`;
  const complained = sql<number>`count(*) filter (where ${complaintFilter})::int`;
  return db
    .select({
      teamId: schema.teams.id,
      teamName: schema.teams.name,
      hardBounced,
      complained,
    })
    .from(schema.emailEvents)
    .innerJoin(schema.emails, eq(schema.emails.id, schema.emailEvents.emailId))
    .innerJoin(schema.domains, eq(schema.domains.id, schema.emails.domainId))
    .innerJoin(schema.teams, eq(schema.teams.id, schema.emails.teamId))
    .where(
      and(
        eq(schema.domains.region, region),
        gte(schema.emailEvents.createdAt, since),
        isNotNull(schema.emailEvents.snsMessageId),
      ),
    )
    .groupBy(schema.teams.id, schema.teams.name)
    .orderBy(desc(sql`${hardBounced} + ${complained}`))
    .limit(5);
}

function bounceTrip(counts: RegionWindowCounts, windowHours: number): RegionBreakerReason | null {
  if (counts.sent < BREAKER_MIN_SENT || counts.hardBounced < MIN_PAUSE_HARD_BOUNCES) return null;
  const rate = counts.hardBounced / counts.sent;
  if (rate < BREAKER_BOUNCE_RATE) return null;
  return {
    metric: "bounce",
    rate,
    limit: BREAKER_BOUNCE_RATE,
    windowHours,
    sent: counts.sent,
    events: counts.hardBounced,
  };
}

/** The window whose teams a reason names: SES's rate spans far more than a day. */
function contributorHours(reason: RegionBreakerReason): number {
  return "windowHours" in reason ? reason.windowHours : BREAKER_WINDOWS_HOURS[1];
}

/**
 * One decision per region with traffic or a stored SES rate: trip when
 * either window's hard bounces are over the line with enough sends and
 * bounces behind them, or when SES's own complaint rate is; clear only when
 * all of them are under. Contributors are listed for tripped regions so the
 * operator knows who to talk to.
 */
export async function evaluateRegionBreakers(
  db: Db,
  opts: { now?: Date } = {},
): Promise<RegionDecision[]> {
  const now = opts.now ?? new Date();
  // The day window reads raw rows to the minute; the week window reads the
  // daily counters (seven UTC days including today, the guardrail's own
  // convention; reported as 168 hours) so a week of email_events is never
  // re-scanned per run, except for the few multi-region teams the counters
  // cannot place, whose rows are read over the trailing 168 hours.
  const [dayHours, weekHours] = BREAKER_WINDOWS_HOURS;
  const windows = [
    { hours: dayHours, counts: await regionWindowCounts(db, { now, hours: dayHours }) },
    { hours: weekHours, counts: await regionCounterTotals(db, { now, days: weekHours / 24 }) },
  ];
  const rows = await db
    .select({
      region: schema.regionBreakers.region,
      paused: schema.regionBreakers.paused,
      sesComplaintRate: schema.regionBreakers.sesComplaintRate,
    })
    .from(schema.regionBreakers);
  const sesRates = new Map(rows.map((r) => [r.region, r.sesComplaintRate]));
  // Paused regions stay in the set even with no traffic in either window:
  // a decision with nothing tripping is what lets them resume.
  const regions = new Set([
    ...windows.flatMap((w) => [...w.counts.keys()]),
    ...rows.filter((r) => r.paused || r.sesComplaintRate !== null).map((r) => r.region),
  ]);
  const decisions: RegionDecision[] = [];
  for (const region of regions) {
    let reason: RegionBreakerReason | null = null;
    for (const w of windows) {
      const counts = w.counts.get(region);
      reason = counts ? bounceTrip(counts, w.hours) : null;
      if (reason) break;
    }
    const ses = sesRates.get(region) ?? null;
    if (!reason && ses !== null && ses >= BREAKER_SES_COMPLAINT_RATE) {
      reason = { metric: "complaint", source: "ses", rate: ses, limit: BREAKER_SES_COMPLAINT_RATE };
    }
    decisions.push({
      region,
      trip: reason !== null,
      ...(reason ? { reason } : {}),
      contributors: reason ? await contributors(db, region, now, contributorHours(reason)) : [],
    });
  }
  return decisions;
}

export interface SesComplaintAlert {
  region: string;
  rate: number;
  contributors: RegionContributor[];
}

/**
 * Stores SES's own complaint rate per region (a region left out of `rates`,
 * its read having failed, keeps its last one) and returns the regions the
 * operator should hear about: at or over the alert line, not paused (the
 * pause has its own notice), and not told in the last day. Those are marked
 * told.
 */
export async function recordSesComplaintRates(
  db: Db,
  rates: ReadonlyMap<string, number | null>,
  now: Date = new Date(),
): Promise<SesComplaintAlert[]> {
  const b = schema.regionBreakers;
  const alerts: SesComplaintAlert[] = [];
  for (const [region, rate] of rates) {
    const [row] = await db
      .insert(b)
      .values({ region, sesComplaintRate: rate })
      .onConflictDoUpdate({ target: b.region, set: { sesComplaintRate: rate } })
      .returning({ paused: b.paused, alertedAt: b.sesComplaintAlertedAt });
    if (rate === null || rate < SES_COMPLAINT_ALERT_RATE || row?.paused) continue;
    if (row?.alertedAt && now.getTime() - row.alertedAt.getTime() < DAY_MS) continue;
    await db.update(b).set({ sesComplaintAlertedAt: now }).where(eq(b.region, region));
    alerts.push({
      region,
      rate,
      contributors: await contributors(db, region, now, BREAKER_WINDOWS_HOURS[1]),
    });
  }
  return alerts;
}

/** SES's own complaint rate per region, as the breaker last read it. */
export async function sesComplaintRates(db: Db): Promise<Map<string, number>> {
  const b = schema.regionBreakers;
  const rows = await db
    .select({ region: b.region, rate: b.sesComplaintRate })
    .from(b)
    .where(isNotNull(b.sesComplaintRate));
  return new Map(rows.flatMap((r) => (r.rate === null ? [] : [[r.region, r.rate] as const])));
}

/** Persist decisions; reports only the regions whose state actually flipped. */
export async function applyRegionBreakers(
  db: Db,
  decisions: RegionDecision[],
  now = new Date(),
): Promise<{ tripped: string[]; resumed: string[] }> {
  const current = new Map(
    (await db.select().from(schema.regionBreakers)).map((r) => [r.region, r]),
  );
  const tripped: string[] = [];
  const resumed: string[] = [];
  for (const d of decisions) {
    const row = current.get(d.region);
    // An operator's hold outlives the rates: only the operator releases it.
    if (row?.manualReason) continue;
    const paused = row?.paused ?? false;
    if (d.trip === paused) continue;
    await db
      .insert(schema.regionBreakers)
      .values({
        region: d.region,
        paused: d.trip,
        reason: d.reason ?? null,
        pausedAt: d.trip ? now : null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.regionBreakers.region,
        set: {
          paused: d.trip,
          reason: d.reason ?? null,
          pausedAt: d.trip ? now : null,
          updatedAt: now,
        },
      });
    (d.trip ? tripped : resumed).push(d.region);
  }
  return { tripped, resumed };
}

export interface PausedRegion {
  region: string;
  reason: RegionBreakerReason | null;
  /** Set when an operator holds the region by hand rather than the rates. */
  manualReason: string | null;
  pausedAt: Date | null;
}

const PAUSED_COLUMNS = {
  region: schema.regionBreakers.region,
  reason: schema.regionBreakers.reason,
  manualReason: schema.regionBreakers.manualReason,
  pausedAt: schema.regionBreakers.pausedAt,
};

export async function pausedRegions(db: Db): Promise<PausedRegion[]> {
  return db
    .select(PAUSED_COLUMNS)
    .from(schema.regionBreakers)
    .where(eq(schema.regionBreakers.paused, true));
}

/** The pause behind a region, or null when broadcasts flow there. */
export async function regionPause(db: Db, region: string): Promise<PausedRegion | null> {
  const [row] = await db
    .select(PAUSED_COLUMNS)
    .from(schema.regionBreakers)
    .where(and(eq(schema.regionBreakers.region, region), eq(schema.regionBreakers.paused, true)));
  return row ?? null;
}

/** Hold a region's broadcasts by hand; the breaker cron leaves it alone until released. */
export async function holdRegion(
  db: Db,
  region: string,
  reason: string,
  now = new Date(),
): Promise<void> {
  const values = {
    paused: true,
    reason: null,
    manualReason: reason,
    pausedAt: now,
    updatedAt: now,
  };
  await db
    .insert(schema.regionBreakers)
    .values({ region, ...values })
    .onConflictDoUpdate({ target: schema.regionBreakers.region, set: values });
}

/** Release an operator's hold; the next breaker run judges the region on its rates again. */
export async function releaseRegion(db: Db, region: string, now = new Date()): Promise<void> {
  await db
    .update(schema.regionBreakers)
    .set({ paused: false, reason: null, manualReason: null, pausedAt: null, updatedAt: now })
    .where(eq(schema.regionBreakers.region, region));
}
