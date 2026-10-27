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
  isNull,
  lt,
  notInArray,
  or,
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
import {
  NO_COMPLAINT_FEEDBACK_DOMAINS,
  SES_MAILBOX_SIMULATOR_DOMAIN,
  SES_UNATTEMPTED_SUBTYPES,
  sentWithoutComplaintFeedback,
} from "./mailbox-providers.js";
import { effectivePlan, type Plan, paidPlan } from "./plans.js";
import { effectivelyFree, fetchEffectivePlan } from "./team-plan.js";
import { DAY_MS, utcDay } from "./utc-day.js";

/**
 * SES enforces bounce/complaint rates on the whole account per region: one
 * team's bad week pauses every customer in that region. The breaker watches
 * the aggregate and holds broadcasts (never transactional mail) short of
 * SES's own lines, so the platform stops itself before AWS does: every
 * team's on a bounce trip, only those of the teams drawing the complaints
 * on a complaint trip.
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
 * BREAKER_SES_COMPLAINT_RATE judges both, and a team's own month on a
 * complaint trip.
 */
export const SES_COMPLAINT_REVIEW_RATE = 0.001;
export const SES_COMPLAINT_PAUSE_RATE = 0.005;
/**
 * The operator hears at this rate, a day apart while it stays there, paused
 * or not; a complaint trip resumes only once the rate is back under it, so a
 * rate hovering at the trip line cannot trip and resume every run.
 */
export const SES_COMPLAINT_ALERT_RATE = 0.0008;
export const BREAKER_SES_COMPLAINT_RATE = 0.001;
/** The days of sends, by when they went out, that a team's complaints and bounces are read over. */
export const BREAKER_TEAM_WINDOW_DAYS = 30;
/**
 * The Free fuse (Cloud): this many complaints on Free teams' mail sent over
 * the window trips it, and only an operator's release clears it.
 */
export const FREE_FUSE_COMPLAINTS = 3;
export const FREE_FUSE_WINDOW_DAYS = 7;
/** Unmatched SES feedback outlives the month the operator's mails count. */
const UNMATCHED_RETENTION_DAYS = 35;

export type RegionWindowCounts = WindowCounts;

const NO_COUNTS: RegionWindowCounts = { sent: 0, complaintSent: 0, hardBounced: 0, complained: 0 };

export interface RegionContributor {
  teamId: string;
  teamName: string;
  hardBounced: number;
  complained: number;
}

/** A team's mail sent in a region over BREAKER_TEAM_WINDOW_DAYS, and SES's feedback on it. */
export interface RegionTeamStats extends RegionContributor {
  plan: Plan;
  currentPeriodEnd: Date | null;
  sent: number;
  /** Sends that could draw a complaint: not every recipient at a provider that never reports one. */
  complaintSent: number;
  /** When the latest of its complaints arrived. */
  lastComplaintAt: Date | null;
}

export interface RegionDecision {
  region: string;
  trip: boolean;
  reason?: RegionBreakerReason;
  contributors: RegionContributor[];
  /**
   * The paid teams whose broadcasts a complaint trip holds, each at or over
   * BREAKER_SES_COMPLAINT_RATE on its own month; null (or absent) holds
   * every team's.
   */
  heldTeams?: RegionTeamStats[] | null;
  /** Free teams whose mail drew a complaint on a complaint trip (Cloud): held for review. */
  reviewTeams?: RegionTeamStats[];
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
/**
 * Whether every recipient a stored SES bounce or complaint names is at SES's
 * mailbox simulator, which SES leaves out of its own rates.
 * ponytail: the recipients live only in the payload, so an event whose
 * payload retention stripped reads as counted, the ceiling sesAttemptedSql
 * has too.
 */
const simulatorOnlySql = (recipients: SQL) => sql`coalesce((
  select bool_and(lower(rtrim(split_part(r->>'emailAddress', '@', -1), '>')) = ${SES_MAILBOX_SIMULATOR_DOMAIN})
  from jsonb_array_elements(case when jsonb_typeof(${recipients}) = 'array' then ${recipients} else '[]'::jsonb end) r
), false)`;
// Bounce class lives in the stored SES payload (process-ses-event writes the
// raw bounce object under data.bounce), so hard bounces are read back from it.
// The column is authoritative; the json path covers rows written before it
// existed (until retention strips their payload).
export const hardBounceFilter = sql`${ev.type} = 'bounced' and coalesce(${ev.bounceType}, ${ev.data}->'bounce'->>'bounceType') = 'Permanent' and ${sesAttemptedSql(sql`${ev.data}->'bounce'->>'bounceSubType'`)} and not ${simulatorOnlySql(sql`${ev.data}->'bounce'->'bouncedRecipients'`)}`;
export const complaintFilter = sql`${ev.type} = 'complained' and ${sesAttemptedSql(sql`${ev.data}->'complaint'->>'complaintSubType'`)} and not ${simulatorOnlySql(sql`${ev.data}->'complaint'->'complainedRecipients'`)}`;
/** SES's complaints and bounces, as email_events_feedback_created_idx reads them. */
const feedbackEvents = sql`${ev.type} in ('complained', 'bounced') and ${ev.snsMessageId} is not null`;
/**
 * A send's recipients in to, cc and bcc, one `domain` row each, read the way
 * sentWithoutComplaintFeedback reads them: what follows the last '@', less a
 * closing '>'.
 */
export const recipientDomains = sql`select lower(rtrim(split_part(r, '@', -1), '>')) as domain
  from jsonb_array_elements_text(${schema.emails.to} || coalesce(${schema.emails.cc}, '[]') || coalesce(${schema.emails.bcc}, '[]')) as r`;
// sentWithoutComplaintFeedback over the stored recipients. SES leaves its
// mailbox simulator out of its rates, so mail to it alone is left out too.
const noComplaintFeedback = sql`coalesce((
  select bool_and(d.domain in ${[...NO_COMPLAINT_FEEDBACK_DOMAINS, SES_MAILBOX_SIMULATOR_DOMAIN]}) from (${recipientDomains}) d
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

/**
 * The teams whose mail sent in the region over the last
 * BREAKER_TEAM_WINDOW_DAYS, by when it went out, drew a hard bounce or a
 * complaint, with what they sent there. Mail with no domain row (the shared
 * inbox domain's, the onboarding email, account mail) went out in
 * `defaultRegion`.
 */
export async function regionTeamStats(
  db: Db,
  opts: { region: string; defaultRegion: string; now: Date },
): Promise<RegionTeamStats[]> {
  const since = new Date(opts.now.getTime() - BREAKER_TEAM_WINDOW_DAYS * DAY_MS);
  const e = schema.emails;
  const d = schema.domains;
  const t = schema.teams;
  const inRegion = sql`coalesce(${d.region}, ${opts.defaultRegion}) = ${opts.region}`;
  const complained = sql<number>`count(*) filter (where ${complaintFilter})::int`;
  const hardBounced = sql<number>`count(*) filter (where ${hardBounceFilter})::int`;
  const feedback = await db
    .select({
      teamId: e.teamId,
      complained,
      hardBounced,
      lastComplaintAt:
        sql<Date | null>`max(${ev.createdAt}) filter (where ${complaintFilter})`.mapWith(
          ev.createdAt,
        ),
    })
    .from(ev)
    .innerJoin(e, eq(e.id, ev.emailId))
    .leftJoin(d, eq(d.id, e.domainId))
    // An event arrives after its send: the arrival bound changes nothing but
    // lets the scan use the feedback index.
    .where(and(feedbackEvents, gte(ev.createdAt, since), gte(e.sentAt, since), inRegion))
    .groupBy(e.teamId)
    .having(sql`${complained} + ${hardBounced} > 0`);
  if (feedback.length === 0) return [];
  const sends = await db
    .select({
      teamId: t.id,
      teamName: t.name,
      plan: t.plan,
      currentPeriodEnd: t.currentPeriodEnd,
      sent: sql<number>`count(*)::int`,
      complaintSent: sql<number>`count(*) filter (where not ${noComplaintFeedback})::int`,
    })
    .from(e)
    .innerJoin(t, eq(t.id, e.teamId))
    .leftJoin(d, eq(d.id, e.domainId))
    .where(
      and(
        inArray(
          e.teamId,
          feedback.map((row) => row.teamId),
        ),
        gte(e.sentAt, since),
        inRegion,
      ),
    )
    .groupBy(t.id, t.name, t.plan, t.currentPeriodEnd);
  const byTeam = new Map(feedback.map((row) => [row.teamId, row]));
  return sends.flatMap((row) => {
    const hits = byTeam.get(row.teamId);
    return hits ? [{ ...row, ...hits }] : [];
  });
}

/** The five teams behind the most events of the metric, worst first. */
function topContributors(
  stats: readonly RegionTeamStats[],
  metric: RegionBreakerReason["metric"],
): RegionContributor[] {
  const [first, second] =
    metric === "bounce"
      ? (["hardBounced", "complained"] as const)
      : (["complained", "hardBounced"] as const);
  return [...stats]
    .sort(
      (a, b) =>
        b[first] - a[first] || b[second] - a[second] || a.teamName.localeCompare(b.teamName),
    )
    .slice(0, 5)
    .map(({ teamId, teamName, hardBounced, complained }) => ({
      teamId,
      teamName,
      hardBounced,
      complained,
    }));
}

/**
 * Our own counts over a window, each line over its own sends; `complaintLine`
 * adds a complaint line, over the sends that can draw one, to the bounce one.
 */
function windowTrip(
  counts: RegionWindowCounts,
  windowHours: number,
  complaintLine: number | null,
): RegionBreakerReason | null {
  const checks = [
    {
      metric: "bounce" as const,
      sent: counts.sent,
      events: counts.hardBounced,
      limit: BREAKER_BOUNCE_RATE,
      min: MIN_PAUSE_HARD_BOUNCES,
    },
    ...(complaintLine !== null
      ? [
          {
            metric: "complaint" as const,
            sent: counts.complaintSent,
            events: counts.complained,
            limit: complaintLine,
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

/**
 * One decision per region with traffic or a current SES rate: trip when
 * either window is over a breaker line with enough sends and events behind
 * it, or SES's own complaint rate is over its line; clear only when all of
 * them are under, a complaint pause only once the complaint rate is under
 * SES_COMPLAINT_ALERT_RATE. Complaints count through SES's rate while it
 * can be read, through our own windows otherwise. A tripped region names
 * the teams behind its events, worst first, so the operator knows who to
 * talk to; a complaint trip holds only the broadcasts of the paid teams at
 * or over the line on their own month and, on Cloud, puts the Free teams
 * whose mail drew a complaint up for review.
 */
export async function evaluateRegionBreakers(
  db: Db,
  opts: { now?: Date; defaultRegion: string; isCloud: boolean },
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
      reason: b.reason,
      sesComplaintRate: b.sesComplaintRate,
      sesComplaintReadAt: b.sesComplaintReadAt,
    })
    .from(b);
  const byRegion = new Map(rows.map((r) => [r.region, r]));
  const sesRates = new Map(rows.map((r) => [r.region, sesReading(r, now).rate]));
  // Paused regions stay in the set even with no traffic in either window:
  // a decision with nothing tripping is what lets them resume.
  const regions = new Set([
    ...windows.flatMap((w) => [...w.counts.keys()]),
    ...rows.filter((r) => r.paused || sesRates.get(r.region) !== null).map((r) => r.region),
  ]);
  const free = (s: RegionTeamStats) =>
    !paidPlan(effectivePlan(s.plan, s.currentPeriodEnd, now), opts.isCloud);
  const decisions: RegionDecision[] = [];
  for (const region of regions) {
    const ses = sesRates.get(region) ?? null;
    const judge = (complaintLine: number): RegionBreakerReason | null => {
      for (const w of windows) {
        const counts = w.counts.get(region);
        const reason = counts
          ? windowTrip(counts, w.hours, ses === null ? complaintLine : null)
          : null;
        if (reason) return reason;
      }
      return ses !== null && ses >= complaintLine
        ? { metric: "complaint", source: "ses", rate: ses, limit: complaintLine }
        : null;
    };
    const stored = byRegion.get(region);
    // Still over the alert line, a complaint pause holds for the reason it tripped on.
    const reason =
      judge(BREAKER_SES_COMPLAINT_RATE) ??
      (stored?.paused && stored.reason?.metric === "complaint" && judge(SES_COMPLAINT_ALERT_RATE)
        ? stored.reason
        : null);
    if (!reason) {
      decisions.push({ region, trip: false, contributors: [] });
      continue;
    }
    const stats = await regionTeamStats(db, {
      region,
      defaultRegion: opts.defaultRegion,
      now,
    });
    const complaints = reason.metric === "complaint";
    decisions.push({
      region,
      trip: true,
      reason,
      contributors: topContributors(stats, reason.metric),
      heldTeams: complaints
        ? stats.filter(
            (s) =>
              !free(s) && s.complained / Math.max(s.complaintSent, 1) >= BREAKER_SES_COMPLAINT_RATE,
          )
        : null,
      reviewTeams: complaints ? stats.filter((s) => free(s) && s.complained > 0) : [],
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
 * alert line, paused or not, and not told in the last day. Those are marked
 * told, and name the teams behind the most complaints.
 */
export async function recordSesComplaintRates(
  db: Db,
  rates: ReadonlyMap<string, number | null>,
  opts: { now: Date; defaultRegion: string },
): Promise<SesComplaintAlert[]> {
  const { now } = opts;
  const b = schema.regionBreakers;
  const alerts: SesComplaintAlert[] = [];
  for (const [region, rate] of rates) {
    const reading = { sesComplaintRate: rate, sesComplaintReadAt: now };
    const [row] = await db
      .insert(b)
      .values({ region, ...reading })
      .onConflictDoUpdate({ target: b.region, set: reading })
      .returning({ alertedAt: b.sesComplaintAlertedAt });
    if (rate === null || rate < SES_COMPLAINT_ALERT_RATE) continue;
    if (row?.alertedAt && now.getTime() - row.alertedAt.getTime() < DAY_MS) continue;
    await db.update(b).set({ sesComplaintAlertedAt: now }).where(eq(b.region, region));
    const stats = await regionTeamStats(db, { region, defaultRegion: opts.defaultRegion, now });
    alerts.push({ region, rate, contributors: topContributors(stats, "complaint") });
  }
  return alerts;
}

/** SES complaints about mail SES attempted that arrived over the last month and matched no email row. */
export async function unmatchedComplaints(db: Db, now: Date): Promise<number> {
  const u = schema.sesUnmatchedEvents;
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(u)
    .where(
      and(
        eq(u.type, "complained"),
        gte(u.createdAt, new Date(now.getTime() - BREAKER_TEAM_WINDOW_DAYS * DAY_MS)),
        sesAttemptedSql(sql`${u.subType}`),
      ),
    );
  return row?.n ?? 0;
}

/** Deletes unmatched SES feedback past its retention; returns how many rows went. */
export async function purgeUnmatchedSesEvents(db: Db, now: Date = new Date()): Promise<number> {
  const u = schema.sesUnmatchedEvents;
  const gone = await db
    .delete(u)
    .where(lt(u.createdAt, new Date(now.getTime() - UNMATCHED_RETENTION_DAYS * DAY_MS)))
    .returning({ id: u.id });
  return gone.length;
}

export interface SesEnforcementChange {
  region: string;
  /** The status last stored; null the first time the region's is seen. */
  from: string | null;
  to: string;
}

/**
 * Stores SES's EnforcementStatus per region (a region left out of
 * `statuses` keeps its last one) and returns the changes the operator should
 * hear about: every change of a status seen before, and a first sighting
 * that is not HEALTHY.
 */
export async function recordSesEnforcementStatuses(
  db: Db,
  statuses: ReadonlyMap<string, string>,
): Promise<SesEnforcementChange[]> {
  const b = schema.regionBreakers;
  const changes: SesEnforcementChange[] = [];
  for (const [region, to] of statuses) {
    const [row] = await db
      .select({ from: b.sesEnforcementStatus })
      .from(b)
      .where(eq(b.region, region));
    const from = row?.from ?? null;
    if (from === to) continue;
    await db
      .insert(b)
      .values({ region, sesEnforcementStatus: to })
      .onConflictDoUpdate({ target: b.region, set: { sesEnforcementStatus: to } });
    if (from !== null || to !== "HEALTHY") changes.push({ region, from, to });
  }
  return changes;
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

/**
 * Persist decisions: a flip, or a paused region whose held teams changed
 * (keeping when it paused). Reports only the regions whose state flipped.
 */
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
    const heldTeams = d.trip && d.heldTeams ? d.heldTeams.map((s) => s.teamId).sort() : null;
    const rescoped =
      d.trip && paused && JSON.stringify(row?.heldTeams ?? null) !== JSON.stringify(heldTeams);
    if (d.trip === paused && !rescoped) continue;
    const values = {
      paused: d.trip,
      reason: d.reason ?? null,
      heldTeams,
      pausedAt: d.trip ? (paused ? (row?.pausedAt ?? now) : now) : null,
      updatedAt: now,
    };
    await db
      .insert(schema.regionBreakers)
      .values({ region: d.region, ...values })
      .onConflictDoUpdate({ target: schema.regionBreakers.region, set: values });
    if (d.trip !== paused) (d.trip ? tripped : resumed).push(d.region);
  }
  return { tripped, resumed };
}

export interface PausedRegion {
  region: string;
  reason: RegionBreakerReason | null;
  /** Set when an operator holds the region by hand rather than the rates. */
  manualReason: string | null;
  /** The teams whose broadcasts the pause holds; null holds every team's. */
  heldTeams: string[] | null;
  pausedAt: Date | null;
}

const PAUSED_COLUMNS = {
  region: schema.regionBreakers.region,
  reason: schema.regionBreakers.reason,
  manualReason: schema.regionBreakers.manualReason,
  heldTeams: schema.regionBreakers.heldTeams,
  pausedAt: schema.regionBreakers.pausedAt,
};

export async function pausedRegions(db: Db): Promise<PausedRegion[]> {
  return db
    .select(PAUSED_COLUMNS)
    .from(schema.regionBreakers)
    .where(eq(schema.regionBreakers.paused, true));
}

/** Whether a region's pause holds this team's broadcasts. */
export function pauseHolds(pause: Pick<PausedRegion, "heldTeams">, teamId: string): boolean {
  return pause.heldTeams === null || pause.heldTeams.includes(teamId);
}

/** The pause that holds the team's broadcasts in a region, or null when they flow there. */
export async function regionPause(
  db: Db,
  region: string,
  teamId: string,
): Promise<PausedRegion | null> {
  const b = schema.regionBreakers;
  const [row] = await db
    .select(PAUSED_COLUMNS)
    .from(b)
    .where(
      and(
        eq(b.region, region),
        eq(b.paused, true),
        or(isNull(b.heldTeams), sql`${b.heldTeams} ? ${teamId}`),
      ),
    );
  return row ?? null;
}

/** Hold a region's broadcasts by hand, every team's; the breaker cron leaves it alone until released. */
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
    heldTeams: null,
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
    .set({
      paused: false,
      reason: null,
      manualReason: null,
      heldTeams: null,
      pausedAt: null,
      updatedAt: now,
    })
    .where(eq(schema.regionBreakers.region, region));
}

/** Mail the Free fuse holds. */
const fuseParked = and(
  eq(schema.emails.latestStatus, "queued_quota"),
  eq(schema.emails.parkReason, "fuse"),
);

export interface FreeFuseTrip {
  complaints: number;
  /** The Free teams behind them, most first. */
  teams: { teamName: string; complaints: number }[];
}

/**
 * Trips the Free fuse once the complaints about mail effectively Free teams
 * sent over the last FREE_FUSE_WINDOW_DAYS, and since the operator's last
 * release, reach FREE_FUSE_COMPLAINTS. Returns the trip, or null while the
 * fuse stays as it was: a tripped fuse waits for the operator. Cloud only;
 * on a self-hosted instance every team reads as Free.
 */
export async function evaluateFreeFuse(db: Db, now: Date): Promise<FreeFuseTrip | null> {
  const s = schema.instanceSettings;
  const [state] = await db
    .select({ trippedAt: s.freeFuseTrippedAt, releasedAt: s.freeFuseReleasedAt })
    .from(s);
  if (state?.trippedAt) return null;
  const since = new Date(
    Math.max(now.getTime() - FREE_FUSE_WINDOW_DAYS * DAY_MS, state?.releasedAt?.getTime() ?? 0),
  );
  const e = schema.emails;
  const t = schema.teams;
  const complaints = sql<number>`count(*)::int`;
  const teams = await db
    .select({ teamName: t.name, complaints })
    .from(ev)
    .innerJoin(e, eq(e.id, ev.emailId))
    .innerJoin(t, eq(t.id, e.teamId))
    .where(
      and(
        feedbackEvents,
        complaintFilter,
        gte(ev.createdAt, since),
        gte(e.sentAt, since),
        effectivelyFree(now),
      ),
    )
    .groupBy(t.id, t.name)
    .orderBy(desc(complaints), asc(t.name));
  const total = teams.reduce((n, row) => n + row.complaints, 0);
  if (total < FREE_FUSE_COMPLAINTS) return null;
  const set = { freeFuseTrippedAt: now, freeFuseComplaints: total, updatedAt: now };
  const [tripped] = await db
    .insert(s)
    .values({ id: 1, ...set })
    .onConflictDoUpdate({ target: s.id, set, setWhere: isNull(s.freeFuseTrippedAt) })
    .returning({ id: s.id });
  return tripped ? { complaints: total, teams } : null;
}

/**
 * Whether the tripped Free fuse holds a send: a Free team's mail with a
 * recipient at a provider that reports complaints. The fuse is read only for
 * Free teams; the caller leaves out self-hosted instances, account mail and
 * the onboarding email.
 */
export async function freeFuseHolds(
  db: Db,
  email: { teamId: string; to: string[]; cc: string[] | null; bcc: string[] | null },
): Promise<boolean> {
  if (sentWithoutComplaintFeedback([...email.to, ...(email.cc ?? []), ...(email.bcc ?? [])])) {
    return false;
  }
  if ((await fetchEffectivePlan(db, email.teamId)) !== "free") return false;
  const [state] = await db
    .select({ trippedAt: schema.instanceSettings.freeFuseTrippedAt })
    .from(schema.instanceSettings);
  return Boolean(state?.trippedAt);
}

/** The tripped Free fuse and how much mail it holds; null while it is not tripped. */
export async function freeFuseState(
  db: Db,
): Promise<{ trippedAt: Date; complaints: number; parked: number } | null> {
  const s = schema.instanceSettings;
  const [state] = await db
    .select({ trippedAt: s.freeFuseTrippedAt, complaints: s.freeFuseComplaints })
    .from(s);
  if (!state?.trippedAt) return null;
  const [parked] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.emails)
    .where(fuseParked);
  return { trippedAt: state.trippedAt, complaints: state.complaints ?? 0, parked: parked?.n ?? 0 };
}

/**
 * The operator's release of a tripped Free fuse: its count starts over from
 * mail sent after now, and the mail it held loses its park reason, so
 * quota.drain releases it as any parked mail, charging the plan and the
 * warm-up. Null when the fuse was not tripped.
 */
export async function releaseFreeFuse(
  db: Db,
  now: Date = new Date(),
): Promise<{ complaints: number; emails: number } | null> {
  const s = schema.instanceSettings;
  return db.transaction(async (tx) => {
    const [released] = await tx
      .update(s)
      .set({ freeFuseTrippedAt: null, freeFuseReleasedAt: now, updatedAt: now })
      .where(isNotNull(s.freeFuseTrippedAt))
      .returning({ complaints: s.freeFuseComplaints });
    if (!released) return null;
    const freed = await tx
      .update(schema.emails)
      .set({ parkReason: null })
      .where(fuseParked)
      .returning({ id: schema.emails.id });
    return { complaints: released.complaints ?? 0, emails: freed.length };
  });
}
