import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import type { RegionBreakerReason } from "@millionsend/db/schema";
import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm";
import { MIN_PAUSE_COMPLAINTS, MIN_PAUSE_HARD_BOUNCES } from "./deliverability.js";

/**
 * SES enforces bounce/complaint rates on the whole account per region: one
 * team's bad week pauses every customer in that region. The breaker watches
 * the aggregate and holds broadcasts (never transactional mail) at a fraction
 * of SES's own review lines, so the platform stops itself before AWS does.
 */
// 80% of SES's review lines (5% / 0.1%), written as literals: 0.8 * 0.05 is
// 0.04000000000000001 in floating point, and 40 bounces in 1000 must trip.
export const BREAKER_BOUNCE_RATE = 0.04;
export const BREAKER_COMPLAINT_RATE = 0.0008;
/** Sends a region needs in a window before its aggregate rate means anything. */
export const BREAKER_MIN_SENT = 1000;
export const BREAKER_WINDOWS_HOURS = [24, 24 * 7] as const;

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

/** Sends and SES-reported hard bounces/complaints per region over the trailing window. */
export async function regionWindowCounts(
  db: Db,
  opts: { now: Date; hours: number },
): Promise<Map<string, RegionWindowCounts>> {
  const since = new Date(opts.now.getTime() - opts.hours * HOUR_MS);
  const out = new Map<string, RegionWindowCounts>();
  const sent = await db
    .select({ region: schema.domains.region, n: sql<number>`count(*)::int` })
    .from(schema.emails)
    .innerJoin(schema.domains, eq(schema.domains.id, schema.emails.domainId))
    .where(gte(schema.emails.sentAt, since))
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
      and(gte(schema.emailEvents.createdAt, since), isNotNull(schema.emailEvents.snsMessageId)),
    )
    .groupBy(schema.domains.region);
  for (const row of events) {
    const counts = out.get(row.region) ?? { sent: 0, hardBounced: 0, complained: 0 };
    out.set(row.region, { ...counts, hardBounced: row.hardBounced, complained: row.complained });
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

function tripReason(counts: RegionWindowCounts, windowHours: number): RegionBreakerReason | null {
  if (counts.sent < BREAKER_MIN_SENT) return null;
  const checks = [
    {
      metric: "bounce" as const,
      events: counts.hardBounced,
      limit: BREAKER_BOUNCE_RATE,
      min: MIN_PAUSE_HARD_BOUNCES,
    },
    {
      metric: "complaint" as const,
      events: counts.complained,
      limit: BREAKER_COMPLAINT_RATE,
      min: MIN_PAUSE_COMPLAINTS,
    },
  ];
  for (const c of checks) {
    const rate = c.events / counts.sent;
    if (rate >= c.limit && c.events >= c.min) {
      return {
        metric: c.metric,
        rate,
        limit: c.limit,
        windowHours,
        sent: counts.sent,
        events: c.events,
      };
    }
  }
  return null;
}

/**
 * One decision per region with traffic: trip when either window is over a
 * breaker line with enough sends and events behind it;
 * clear only when both windows are under. Contributors are listed for
 * tripped regions so the operator knows who to talk to.
 */
export async function evaluateRegionBreakers(
  db: Db,
  opts: { now?: Date } = {},
): Promise<RegionDecision[]> {
  const now = opts.now ?? new Date();
  const windows = await Promise.all(
    BREAKER_WINDOWS_HOURS.map(async (hours) => ({
      hours,
      counts: await regionWindowCounts(db, { now, hours }),
    })),
  );
  // Paused regions stay in the set even with no traffic in either window:
  // a decision with nothing tripping is what lets them resume.
  const paused = await db
    .select({ region: schema.regionBreakers.region })
    .from(schema.regionBreakers)
    .where(eq(schema.regionBreakers.paused, true));
  const regions = new Set([
    ...windows.flatMap((w) => [...w.counts.keys()]),
    ...paused.map((r) => r.region),
  ]);
  const decisions: RegionDecision[] = [];
  for (const region of regions) {
    let reason: RegionBreakerReason | null = null;
    for (const w of windows) {
      const counts = w.counts.get(region);
      reason = counts ? tripReason(counts, w.hours) : null;
      if (reason) break;
    }
    decisions.push({
      region,
      trip: reason !== null,
      ...(reason ? { reason } : {}),
      contributors: reason ? await contributors(db, region, now, reason.windowHours) : [],
    });
  }
  return decisions;
}

/** Persist decisions; reports only the regions whose state actually flipped. */
export async function applyRegionBreakers(
  db: Db,
  decisions: RegionDecision[],
  now = new Date(),
): Promise<{ tripped: string[]; resumed: string[] }> {
  const current = new Map(
    (await db.select().from(schema.regionBreakers)).map((r) => [r.region, r.paused]),
  );
  const tripped: string[] = [];
  const resumed: string[] = [];
  for (const d of decisions) {
    const paused = current.get(d.region) ?? false;
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
  pausedAt: Date | null;
}

export async function pausedRegions(db: Db): Promise<PausedRegion[]> {
  return db
    .select({
      region: schema.regionBreakers.region,
      reason: schema.regionBreakers.reason,
      pausedAt: schema.regionBreakers.pausedAt,
    })
    .from(schema.regionBreakers)
    .where(eq(schema.regionBreakers.paused, true));
}

/** The pause behind a region, or null when broadcasts flow there. */
export async function regionPause(db: Db, region: string): Promise<PausedRegion | null> {
  const [row] = await db
    .select({
      region: schema.regionBreakers.region,
      reason: schema.regionBreakers.reason,
      pausedAt: schema.regionBreakers.pausedAt,
    })
    .from(schema.regionBreakers)
    .where(and(eq(schema.regionBreakers.region, region), eq(schema.regionBreakers.paused, true)));
  return row ?? null;
}
