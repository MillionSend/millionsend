import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import type { RegionBreakerReason } from "@millionsend/db/schema";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  notInArray,
  type SQL,
  sql,
} from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  counterComplaintSent,
  MIN_PAUSE_COMPLAINTS,
  MIN_PAUSE_HARD_BOUNCES,
  type WindowCounts,
} from "./deliverability.js";
import { NO_COMPLAINT_FEEDBACK_DOMAINS, SES_UNATTEMPTED_SUBTYPES } from "./mailbox-providers.js";
import { DAY_MS, utcDay } from "./utc-day.js";

/**
 * SES enforces bounce/complaint rates on the whole account per region: one
 * team's bad week pauses every customer in that region. The breaker watches
 * the aggregate and holds broadcasts (never transactional mail) short of
 * SES's own lines, so the platform stops itself before AWS does.
 */
// 80% of SES's 5% bounce review line, written as a literal: 0.8 * 0.05 is
// 0.04000000000000001 in floating point, and 40 bounces in 1000 must trip.
export const BREAKER_BOUNCE_RATE = 0.04;
/** Sends a region needs in a window before its aggregate rate means anything. */
export const BREAKER_MIN_SENT = 1000;
export const BREAKER_WINDOWS_HOURS = [24, 24 * 7] as const;
/**
 * Complaints are judged on SES's own rate (Reputation.ComplaintRate) when it
 * can be read, the one its review and pause lines apply to. It counts only
 * mail to the providers that report complaints. While it can't be read (an
 * instance whose IAM policy predates the CloudWatch read), our own count
 * estimates it the same way, leaving out sends no recipient can report.
 * BREAKER_SES_COMPLAINT_RATE judges both.
 */
export const SES_COMPLAINT_REVIEW_RATE = 0.001;
export const SES_COMPLAINT_PAUSE_RATE = 0.005;
/** The operator hears at this rate, a day apart while it stays there. */
export const SES_COMPLAINT_ALERT_RATE = 0.003;
export const BREAKER_SES_COMPLAINT_RATE = 0.004;

export type RegionWindowCounts = WindowCounts;

const NO_COUNTS: RegionWindowCounts = { sent: 0, complaintSent: 0, hardBounced: 0, complained: 0 };

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
const ev = schema.emailEvents;
/**
 * sesAttempted() over a subtype in the stored SES payload.
 * ponytail: the subtype has no column of its own, so an event whose payload
 * retention stripped reads as attempted; give it a column like bounce_type
 * if a window ever reaches past the strip.
 */
const sesAttemptedSql = (subType: SQL) =>
  sql`coalesce(${subType}, '') not in ${[...SES_UNATTEMPTED_SUBTYPES]}`;
// Bounce class lives in the stored SES payload (process-ses-event writes the
// raw bounce object under data.bounce), so hard bounces are read back from it.
// The column is authoritative; the json path covers rows written before it
// existed (until retention strips their payload).
export const hardBounceFilter = sql`${ev.type} = 'bounced' and coalesce(${ev.bounceType}, ${ev.data}->'bounce'->>'bounceType') = 'Permanent' and ${sesAttemptedSql(sql`${ev.data}->'bounce'->>'bounceSubType'`)}`;
export const complaintFilter = sql`${ev.type} = 'complained' and ${sesAttemptedSql(sql`${ev.data}->'complaint'->>'complaintSubType'`)}`;
/**
 * A send's recipients in to, cc and bcc, one `domain` row each, read the way
 * sentWithoutComplaintFeedback reads them: what follows the last '@', less a
 * closing '>'.
 */
export const recipientDomains = sql`select lower(rtrim(split_part(r, '@', -1), '>')) as domain
  from jsonb_array_elements_text(${schema.emails.to} || coalesce(${schema.emails.cc}, '[]') || coalesce(${schema.emails.bcc}, '[]')) as r`;
// sentWithoutComplaintFeedback over the stored recipients.
const noComplaintFeedback = sql`coalesce((
  select bool_and(d.domain in ${[...NO_COMPLAINT_FEEDBACK_DOMAINS]}) from (${recipientDomains}) d
), false)`;

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
    .select({
      region: schema.domains.region,
      n: sql<number>`count(*)::int`,
      complaintSent: sql<number>`count(*) filter (where not ${noComplaintFeedback})::int`,
    })
    .from(schema.emails)
    .innerJoin(schema.domains, eq(schema.domains.id, schema.emails.domainId))
    .where(and(gte(schema.emails.sentAt, since), teamFilter))
    .groupBy(schema.domains.region);
  for (const row of sent) {
    out.set(row.region, { ...NO_COUNTS, sent: row.n, complaintSent: row.complaintSent });
  }
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
    const counts = out.get(row.region) ?? NO_COUNTS;
    out.set(row.region, { ...counts, hardBounced: row.hardBounced, complained: row.complained });
  }
  return out;
}

/**
 * The same totals over the trailing `days` UTC days (today included) from
 * usage_counters, which the send and SES-event paths bump alongside the
 * rows the raw scan reads: `sent` per accepted send, `sent_no_feedback` per
 * send no recipient can report as a complaint, `hard_bounced` per Permanent
 * bounce and `complained` per complaint, each about mail SES attempted
 * (sesAttempted). Counters carry no domain,
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
  const total = (col: AnyPgColumn | SQL) => sql<string>`coalesce(sum(${col}), 0)::bigint`;
  const rows = await db
    .select({
      region: teamRegion.region,
      sent: total(c.sent),
      complaintSent: total(counterComplaintSent),
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
      complaintSent: Number(row.complaintSent),
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
      const base = out.get(region) ?? NO_COUNTS;
      out.set(region, {
        sent: base.sent + counts.sent,
        complaintSent: base.complaintSent + counts.complaintSent,
        hardBounced: base.hardBounced + counts.hardBounced,
        complained: base.complained + counts.complained,
      });
    }
  }
  return out;
}

/** Teams behind a region's hard bounces and complaints over the tripping window, worst first. */
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
    .having(sql`${hardBounced} + ${complained} > 0`)
    .orderBy(desc(sql`${hardBounced} + ${complained}`))
    .limit(5);
}

/**
 * Our own counts over a window, each line over its own sends; `complaints`
 * adds the complaint line, over the sends that can draw one, to the bounce one.
 */
function windowTrip(
  counts: RegionWindowCounts,
  windowHours: number,
  complaints: boolean,
): RegionBreakerReason | null {
  const checks = [
    {
      metric: "bounce" as const,
      sent: counts.sent,
      events: counts.hardBounced,
      limit: BREAKER_BOUNCE_RATE,
      min: MIN_PAUSE_HARD_BOUNCES,
    },
    ...(complaints
      ? [
          {
            metric: "complaint" as const,
            sent: counts.complaintSent,
            events: counts.complained,
            limit: BREAKER_SES_COMPLAINT_RATE,
            min: MIN_PAUSE_COMPLAINTS,
          },
        ]
      : []),
  ];
  for (const c of checks) {
    if (c.sent < BREAKER_MIN_SENT) continue;
    const rate = c.events / c.sent;
    if (rate >= c.limit && c.events >= c.min) {
      return {
        metric: c.metric,
        source: "events",
        rate,
        limit: c.limit,
        windowHours,
        sent: c.sent,
        events: c.events,
      };
    }
  }
  return null;
}

export interface SesComplaintReading {
  /** SES's rate while it counts; null while the breaker judges our own complaint count. */
  rate: number | null;
  /** SES answered within the day: a null rate then means it published none. */
  read: boolean;
}

/**
 * A stored SES reading as the breaker judges it: a read counts for a day, so
 * a failed read keeps the last one that long. Never read, a day of failed
 * reads, or SES publishing no rate all leave no rate, and the breaker judges
 * our own complaint count instead.
 */
function sesReading(
  row: { sesComplaintRate: number | null; sesComplaintReadAt: Date | null },
  now: Date,
): SesComplaintReading {
  const read =
    row.sesComplaintReadAt !== null && now.getTime() - row.sesComplaintReadAt.getTime() <= DAY_MS;
  return { rate: read ? row.sesComplaintRate : null, read };
}

/** The window whose teams a reason names: SES's rate spans far more than a day. */
function contributorHours(reason: RegionBreakerReason): number {
  return "windowHours" in reason ? reason.windowHours : BREAKER_WINDOWS_HOURS[1];
}

/**
 * One decision per region with traffic or a current SES rate: trip when
 * either window is over a breaker line with enough sends and events behind
 * it, or SES's own complaint rate is over its line; clear only when all of
 * them are under. Complaints count through SES's rate while it can be read,
 * through our own windows otherwise. Contributors are listed for tripped
 * regions so the operator knows who to talk to.
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
  const b = schema.regionBreakers;
  const rows = await db
    .select({
      region: b.region,
      paused: b.paused,
      sesComplaintRate: b.sesComplaintRate,
      sesComplaintReadAt: b.sesComplaintReadAt,
    })
    .from(b);
  const sesRates = new Map(rows.map((r) => [r.region, sesReading(r, now).rate]));
  // Paused regions stay in the set even with no traffic in either window:
  // a decision with nothing tripping is what lets them resume.
  const regions = new Set([
    ...windows.flatMap((w) => [...w.counts.keys()]),
    ...rows.filter((r) => r.paused || sesRates.get(r.region) !== null).map((r) => r.region),
  ]);
  const decisions: RegionDecision[] = [];
  for (const region of regions) {
    const ses = sesRates.get(region) ?? null;
    let reason: RegionBreakerReason | null = null;
    for (const w of windows) {
      const counts = w.counts.get(region);
      reason = counts ? windowTrip(counts, w.hours, ses === null) : null;
      if (reason) break;
    }
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
 * Stores SES's own complaint rate per region with the time of the read (a
 * region left out of `rates`, its read having failed, keeps its last one)
 * and returns the regions the operator should hear about: at or over the
 * alert line, not paused (the pause has its own notice), and not told in the
 * last day. Those are marked told.
 */
export async function recordSesComplaintRates(
  db: Db,
  rates: ReadonlyMap<string, number | null>,
  now: Date = new Date(),
): Promise<SesComplaintAlert[]> {
  const b = schema.regionBreakers;
  const alerts: SesComplaintAlert[] = [];
  for (const [region, rate] of rates) {
    const reading = { sesComplaintRate: rate, sesComplaintReadAt: now };
    const [row] = await db
      .insert(b)
      .values({ region, ...reading })
      .onConflictDoUpdate({ target: b.region, set: reading })
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

/** Each region's SES complaint reading, as the breaker judges it. */
export async function sesComplaintReadings(
  db: Db,
  now: Date = new Date(),
): Promise<Map<string, SesComplaintReading>> {
  const b = schema.regionBreakers;
  const rows = await db
    .select({
      region: b.region,
      sesComplaintRate: b.sesComplaintRate,
      sesComplaintReadAt: b.sesComplaintReadAt,
    })
    .from(b);
  return new Map(rows.map((r) => [r.region, sesReading(r, now)]));
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
