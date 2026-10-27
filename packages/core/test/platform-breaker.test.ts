import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { sentWithoutComplaintFeedback, sesAttempted } from "../src/mailbox-providers.js";
import {
  applyRegionBreakers,
  evaluateFreeFuse,
  evaluateRegionBreakers,
  freeFuseHolds,
  freeFuseState,
  holdRegion,
  pausedRegions,
  pauseHolds,
  purgeUnmatchedSesEvents,
  recordSesComplaintRates,
  recordSesEnforcementStatuses,
  regionCounterTotals,
  regionPause,
  regionTeamStats,
  regionWindowCounts,
  releaseFreeFuse,
  releaseRegion,
  sesComplaintReadings,
  unmatchedComplaints,
} from "../src/platform-breaker.js";
import { broadcastProviderBreakdown } from "../src/provider-breakdown.js";
import { complainedEmail, deliveredEmail } from "../src/status.js";
import { holdComplaintTeams } from "../src/team-standing.js";
import { DAY_MS, utcDay } from "../src/utc-day.js";

let db: Db;
let close: () => Promise<void>;
let teamA: string;
let teamB: string;
let teamC: string;

const NOW = new Date("2026-09-03T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

async function domainIn(teamId: string, name: string, region: string): Promise<string> {
  const [row] = await db
    .insert(schema.domains)
    .values({ teamId, name, region, status: "verified" })
    .returning({ id: schema.domains.id });
  if (!row) throw new Error("seed failed");
  return row.id;
}

/** The daily counters the send and SES-event paths bump, added to the team's day. */
async function bumpCounters(
  teamId: string,
  day: string,
  counts: { sent?: number; sentNoFeedback?: number; hardBounced?: number; complained?: number },
): Promise<void> {
  const c = schema.usageCounters;
  const row = { sent: 0, sentNoFeedback: 0, hardBounced: 0, complained: 0, ...counts };
  await db
    .insert(c)
    .values({ teamId, day, ...row })
    .onConflictDoUpdate({
      target: [c.teamId, c.day],
      set: {
        sent: sql`${c.sent} + ${row.sent}`,
        sentNoFeedback: sql`${c.sentNoFeedback} + ${row.sentNoFeedback}`,
        hardBounced: sql`${c.hardBounced} + ${row.hardBounced}`,
        complained: sql`${c.complained} + ${row.complained}`,
      },
    });
}

async function clearTraffic(): Promise<void> {
  await db.delete(schema.emailEvents);
  await db.delete(schema.emails);
  await db.delete(schema.usageCounters);
}

/**
 * `sent` emails on the domain, the first `events` of them carrying one SES
 * event each, with the day's counters bumped the way production does.
 */
async function seedTraffic(
  teamId: string,
  domainId: string,
  sent: number,
  events: {
    type: "complained" | "bounced" | "delivered" | "delivery_delayed";
    bounceType?: string;
    /** The bounce's or complaint's SES subtype. */
    subType?: string;
    n: number;
  }[],
  sentAt = hoursAgo(6),
  to = (i: number) => [`r${i}@b.com`],
): Promise<void> {
  const rows = await db
    .insert(schema.emails)
    .values(
      Array.from({ length: sent }, (_, i) => ({
        teamId,
        domainId,
        from: "f@a.com",
        to: to(i),
        subject: "s",
        sentAt,
      })),
    )
    .returning({ id: schema.emails.id, to: schema.emails.to });
  let cursor = 0;
  for (const spec of events) {
    for (let i = 0; i < spec.n; i++) {
      const email = rows[cursor++];
      if (!email) throw new Error("more events than emails");
      await db.insert(schema.emailEvents).values({
        emailId: email.id,
        type: spec.type,
        occurredAt: sentAt,
        createdAt: sentAt,
        snsMessageId: `sns-${email.id}`,
        bounceType: spec.type === "bounced" ? (spec.bounceType ?? null) : null,
        data:
          spec.type === "bounced"
            ? { bounce: { bounceType: spec.bounceType, bounceSubType: spec.subType } }
            : spec.type === "complained"
              ? { complaint: { complaintSubType: spec.subType } }
              : {},
      });
    }
  }
  const n = (pred: (e: (typeof events)[number]) => boolean) =>
    events.filter(pred).reduce((sum, e) => sum + e.n, 0);
  await bumpCounters(teamId, utcDay(sentAt), {
    sent,
    sentNoFeedback: rows.filter((r) => sentWithoutComplaintFeedback(r.to)).length,
    hardBounced: n(
      (e) => e.type === "bounced" && e.bounceType === "Permanent" && sesAttempted(e.subType),
    ),
    complained: n((e) => e.type === "complained" && sesAttempted(e.subType)),
  });
}

/** Recipients at a provider that never reports complaints to SES. */
const gmail = (i: number) => [`g${i}@gmail.com`];

/** Where mail with no domain row goes out. */
const DEFAULT_REGION = "sa-east-1";
const evaluate = (now = NOW, isCloud = false) =>
  evaluateRegionBreakers(db, { now, defaultRegion: DEFAULT_REGION, isCloud });
const record = (rates: ReadonlyMap<string, number | null>, now: Date) =>
  recordSesComplaintRates(db, rates, { now, defaultRegion: DEFAULT_REGION });

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamA = await createTeam(db, "breaker-a");
  teamB = await createTeam(db, "breaker-b");
  teamC = await createTeam(db, "breaker-c");
  const a = await domainIn(teamA, "a.dev", "sa-east-1");
  const b = await domainIn(teamB, "b.dev", "sa-east-1");
  const c = await domainIn(teamC, "c.dev", "us-east-1");
  // sa-east-1: 1000 sends, 45 hard bounces (4.5% ≥ 80% of the 5% line).
  await seedTraffic(teamA, a, 700, [{ type: "bounced", bounceType: "Permanent", n: 30 }]);
  await seedTraffic(teamB, b, 300, [{ type: "bounced", bounceType: "Permanent", n: 15 }]);
  // us-east-1: a worse rate, but under the 1000-send floor.
  await seedTraffic(teamC, c, 500, [{ type: "bounced", bounceType: "Permanent", n: 45 }]);
});

const permanent = (n: number) => [{ type: "bounced" as const, bounceType: "Permanent", n }];
afterAll(() => close());

it("trips a region on the 24h hard-bounce rate, names contributors worst first, and skips under the floor", async () => {
  const decisions = await evaluate();
  const sa = decisions.find((d) => d.region === "sa-east-1");
  const us = decisions.find((d) => d.region === "us-east-1");
  expect(sa).toMatchObject({
    trip: true,
    reason: { metric: "bounce", windowHours: 24, sent: 1000, events: 45, rate: 0.045 },
  });
  expect(sa?.contributors.map((c) => [c.teamId, c.hardBounced])).toEqual([
    [teamA, 30],
    [teamB, 15],
  ]);
  expect(us).toMatchObject({ trip: false, contributors: [] });
});

it("applies only state changes, and answers regionPause/pausedRegions", async () => {
  const decisions = await evaluate();
  expect(await applyRegionBreakers(db, decisions, NOW)).toEqual({
    tripped: ["sa-east-1"],
    resumed: [],
  });
  expect(await applyRegionBreakers(db, decisions, NOW)).toEqual({ tripped: [], resumed: [] });
  expect((await regionPause(db, "sa-east-1", teamA))?.reason?.metric).toBe("bounce");
  expect(await regionPause(db, "us-east-1", teamC)).toBeNull();
  // A bounce trip holds every team's broadcasts in the region.
  expect(await pausedRegions(db)).toMatchObject([{ region: "sa-east-1", heldTeams: null }]);
  expect(await regionPause(db, "sa-east-1", teamC)).not.toBeNull();
});

it("resumes once both windows are under the line, and transient bounces never count", async () => {
  await db.delete(schema.emailEvents).where(eq(schema.emailEvents.type, "bounced"));
  await db.update(schema.usageCounters).set({ hardBounced: 0 });
  const cleared = await evaluate();
  expect(cleared.find((d) => d.region === "sa-east-1")?.trip).toBe(false);
  expect(await applyRegionBreakers(db, cleared, NOW)).toEqual({
    tripped: [],
    resumed: ["sa-east-1"],
  });
  expect(await regionPause(db, "sa-east-1", teamA)).toBeNull();

  // 45 transient bounces on 1000 sends: 4.5% would trip if they counted.
  const [dom] = await db.select().from(schema.domains).where(eq(schema.domains.teamId, teamA));
  if (!dom) throw new Error("no domain");
  await seedTraffic(teamA, dom.id, 45, [{ type: "bounced", bounceType: "Transient", n: 45 }]);
  const transient = await evaluate();
  expect(transient.find((d) => d.region === "sa-east-1")?.trip).toBe(false);
  await seedTraffic(teamA, dom.id, 45, [{ type: "bounced", bounceType: "Permanent", n: 45 }]);
  const permanent = await evaluate();
  expect(permanent.find((d) => d.region === "sa-east-1")).toMatchObject({
    trip: true,
    reason: { metric: "bounce", events: 45 },
  });
});

it("judges the 7-day window too: old events still trip it when the 24h window is clean", async () => {
  await clearTraffic();
  const [dom] = await db.select().from(schema.domains).where(eq(schema.domains.teamId, teamC));
  if (!dom) throw new Error("no domain");
  await seedTraffic(teamC, dom.id, 1000, permanent(45), hoursAgo(72));
  const decisions = await evaluate();
  const us = decisions.find((d) => d.region === "us-east-1");
  expect(us).toMatchObject({ trip: true, reason: { windowHours: 168 } });
  // Contributors cover the month's sends, not the 24h window.
  expect(us?.contributors.map((c) => [c.teamId, c.hardBounced])).toEqual([[teamC, 45]]);
});

it("exactly 4.00% hard bounces (40 in 1000) trips the bounce line", async () => {
  await clearTraffic();
  const [dom] = await db.select().from(schema.domains).where(eq(schema.domains.teamId, teamA));
  if (!dom) throw new Error("no domain");
  await seedTraffic(teamA, dom.id, 1000, [{ type: "bounced", bounceType: "Permanent", n: 40 }]);
  const decisions = await evaluate();
  expect(decisions.find((d) => d.region === "sa-east-1")).toMatchObject({
    trip: true,
    reason: { metric: "bounce", events: 40, rate: 0.04, limit: 0.04 },
  });
});

it("a paused region with no traffic left in either window still gets a resume decision", async () => {
  await applyRegionBreakers(
    db,
    [
      {
        region: "eu-west-1",
        trip: true,
        reason: {
          metric: "complaint",
          rate: 0.01,
          limit: 0.004,
          windowHours: 24,
          sent: 1000,
          events: 10,
        },
        contributors: [],
      },
    ],
    NOW,
  );
  await clearTraffic();
  const decisions = await evaluate();
  expect(decisions.find((d) => d.region === "eu-west-1")).toMatchObject({ trip: false });
  expect(await applyRegionBreakers(db, decisions, NOW)).toMatchObject({ resumed: ["eu-west-1"] });
  expect((await pausedRegions(db)).map((r) => r.region)).not.toContain("eu-west-1");
});

it("hard bounces still count after the retention purge strips event payloads", async () => {
  await clearTraffic();
  await db.delete(schema.regionBreakers);
  const [dom] = await db.select().from(schema.domains).where(eq(schema.domains.teamId, teamC));
  if (!dom) throw new Error("no domain");
  await seedTraffic(teamC, dom.id, 1000, [{ type: "bounced", bounceType: "Permanent", n: 45 }]);
  await db.update(schema.emailEvents).set({ data: null });
  const decisions = await evaluate();
  expect(decisions.find((d) => d.region === "us-east-1")).toMatchObject({
    trip: true,
    reason: { metric: "bounce", windowHours: 24 },
    contributors: [{ teamId: teamC, hardBounced: 45 }],
  });
});

it("leaves bounces and complaints about mail SES never attempted out of the counts and the contributors", async () => {
  await clearTraffic();
  await db.delete(schema.regionBreakers);
  const [a] = await db.select().from(schema.domains).where(eq(schema.domains.teamId, teamA));
  if (!a) throw new Error("no domain");
  const listed = await createTeam(db, "breaker-listed");
  await seedTraffic(teamA, a.id, 1000, permanent(45));
  // Every one stopped by SES's own suppression list.
  await seedTraffic(listed, await domainIn(listed, "listed.example", "sa-east-1"), 40, [
    { type: "bounced", bounceType: "Permanent", subType: "OnAccountSuppressionList", n: 30 },
    { type: "complained", subType: "OnAccountSuppressionList", n: 10 },
  ]);
  expect((await regionWindowCounts(db, { now: NOW, hours: 24 })).get("sa-east-1")).toMatchObject({
    sent: 1040,
    hardBounced: 45,
    complained: 0,
  });
  const sa = (await evaluate()).find((d) => d.region === "sa-east-1");
  expect(sa).toMatchObject({ trip: true, reason: { metric: "bounce", windowHours: 24 } });
  expect(sa?.contributors.map((c) => c.teamId)).toEqual([teamA]);
});

it("names only teams with hard bounces or complaints, not those with only deliveries, delays or transient bounces", async () => {
  await clearTraffic();
  await db.delete(schema.regionBreakers);
  const [a] = await db.select().from(schema.domains).where(eq(schema.domains.teamId, teamA));
  const [b] = await db.select().from(schema.domains).where(eq(schema.domains.teamId, teamB));
  if (!a || !b) throw new Error("no domain");
  const delayed = await createTeam(db, "breaker-delayed");
  const delivered = await createTeam(db, "breaker-delivered");
  await seedTraffic(teamA, a.id, 1000, permanent(45));
  await seedTraffic(teamB, b.id, 10, permanent(1));
  await seedTraffic(delayed, await domainIn(delayed, "delayed.example", "sa-east-1"), 4, [
    { type: "delivery_delayed", n: 2 },
    { type: "bounced", bounceType: "Transient", n: 2 },
  ]);
  await seedTraffic(delivered, await domainIn(delivered, "delivered.example", "sa-east-1"), 2, [
    { type: "delivered", n: 2 },
  ]);
  const decisions = await evaluate();
  const sa = decisions.find((d) => d.region === "sa-east-1");
  expect(sa).toMatchObject({ trip: true, reason: { metric: "bounce", windowHours: 24 } });
  expect(sa?.contributors.map((c) => [c.teamId, c.hardBounced])).toEqual([
    [teamA, 45],
    [teamB, 1],
  ]);
});

it("the week window reads the daily counters: seven UTC days including today (reported as 168h), attributed to the team's verified domain, never a pending one", async () => {
  await clearTraffic();
  await db.delete(schema.regionBreakers);
  const teamD = await createTeam(db, "breaker-d");
  const [dom] = await db
    .insert(schema.domains)
    .values([
      {
        teamId: teamD,
        name: "d.dev",
        region: "ap-south-1",
        status: "verified",
        verifiedAt: hoursAgo(24),
      },
      { teamId: teamD, name: "never.dev", region: "us-east-1", status: "pending" },
    ])
    .returning({ id: schema.domains.id });
  if (!dom) throw new Error("seed failed");
  const day = (n: number) => utcDay(NOW.getTime() - n * DAY_MS);
  // Six days ago is the oldest day inside the window; seven days ago is out —
  // with it in, 45 hard bounces over 10000 sends would sit under the line.
  await bumpCounters(teamD, day(7), { sent: 9000 });
  // The tripping day's rows exist too (seedTraffic bumps its counters).
  await seedTraffic(teamD, dom.id, 600, permanent(45), hoursAgo(6 * 24));
  await bumpCounters(teamD, day(0), { sent: 400 });
  expect(await regionCounterTotals(db, { now: NOW, days: 7 })).toEqual(
    new Map([["ap-south-1", { sent: 1000, complaintSent: 1000, hardBounced: 45, complained: 0 }]]),
  );
  const decisions = await evaluate();
  expect(decisions.map((d) => d.region)).toEqual(["ap-south-1"]);
  expect(decisions[0]).toMatchObject({
    trip: true,
    reason: { metric: "bounce", windowHours: 168, sent: 1000, events: 45 },
  });
  expect(decisions[0]?.contributors.map((c) => [c.teamId, c.hardBounced])).toEqual([[teamD, 45]]);
});

it("a team whose verified domains span regions is read from its rows, not the counters, so its week lands in the right region", async () => {
  await clearTraffic();
  await db.delete(schema.regionBreakers);
  const teamE = await createTeam(db, "breaker-e");
  const [eu] = await db
    .insert(schema.domains)
    .values([
      {
        teamId: teamE,
        name: "old.dev",
        region: "eu-west-1",
        status: "verified",
        verifiedAt: hoursAgo(48),
      },
      {
        teamId: teamE,
        name: "new.dev",
        region: "ap-south-1",
        status: "verified",
        verifiedAt: hoursAgo(24),
      },
    ])
    .returning({ id: schema.domains.id });
  if (!eu) throw new Error("seed failed");
  // The bad week went out through the OLDER domain's region. Counters alone
  // would credit the newer domain's region with it.
  await seedTraffic(teamE, eu.id, 1000, permanent(45), hoursAgo(72));
  await seedTraffic(teamE, eu.id, 100, [], hoursAgo(72), gmail);
  // Counter-only volume (no rows) is ignored for this team: through the
  // counters it would dilute the rate far under the line.
  await bumpCounters(teamE, utcDay(NOW), { sent: 100_000 });
  // A single-region team's counters in the same region add to its rows.
  const teamF = await createTeam(db, "breaker-f");
  await domainIn(teamF, "f.dev", "eu-west-1");
  await bumpCounters(teamF, utcDay(NOW), { sent: 100, sentNoFeedback: 40, hardBounced: 5 });
  expect(await regionCounterTotals(db, { now: NOW, days: 7 })).toEqual(
    new Map([["eu-west-1", { sent: 1200, complaintSent: 1060, hardBounced: 50, complained: 0 }]]),
  );
  const decisions = await evaluate();
  expect(decisions.map((d) => d.region)).toEqual(["eu-west-1"]);
  expect(decisions[0]).toMatchObject({
    trip: true,
    reason: { metric: "bounce", windowHours: 168, sent: 1200, events: 50 },
  });
  expect(decisions[0]?.contributors.map((c) => [c.teamId, c.hardBounced])).toEqual([[teamE, 45]]);
});

it("a region held by hand stays paused through the cron's resume decisions until released", async () => {
  await holdRegion(db, "us-east-1", "incident");
  expect((await pausedRegions(db)).find((r) => r.region === "us-east-1")).toMatchObject({
    manualReason: "incident",
  });
  // us-east-1 never trips (under the floor), so the cron would resume it.
  const decisions = await evaluate();
  const applied = await applyRegionBreakers(db, decisions, NOW);
  expect(applied.resumed).not.toContain("us-east-1");
  expect(await regionPause(db, "us-east-1", teamC)).toMatchObject({ manualReason: "incident" });
  await releaseRegion(db, "us-east-1");
  expect(await regionPause(db, "us-east-1", teamC)).toBeNull();
});

it("judges complaints on SES's own rate while it can be read: 0.1% trips, our own count does not", async () => {
  await clearTraffic();
  await db.delete(schema.regionBreakers);
  const [dom] = await db.select().from(schema.domains).where(eq(schema.domains.teamId, teamA));
  if (!dom) throw new Error("no domain");
  // 1% of our own count, past the 0.1% line.
  await seedTraffic(teamA, dom.id, 1000, [{ type: "complained", n: 10 }], hoursAgo(72));
  await record(
    new Map([
      ["sa-east-1", 0.00099],
      ["us-east-1", 0.001],
      // No traffic of ours there: SES's rate alone puts it in the run.
      ["eu-west-1", 0.0051],
    ]),
    NOW,
  );
  let decisions = await evaluate();
  expect(decisions.find((d) => d.region === "sa-east-1")).toMatchObject({ trip: false });
  expect(decisions.find((d) => d.region === "us-east-1")).toMatchObject({
    trip: true,
    reason: { metric: "complaint", source: "ses", rate: 0.001, limit: 0.001 },
  });
  expect(decisions.find((d) => d.region === "eu-west-1")).toMatchObject({
    trip: true,
    contributors: [],
  });

  await record(new Map([["sa-east-1", 0.0012]]), NOW);
  decisions = await evaluate();
  // SES's rate spans far more than a day: the month's teams are named.
  expect(decisions.find((d) => d.region === "sa-east-1")).toMatchObject({
    trip: true,
    reason: { source: "ses", rate: 0.0012 },
  });
  expect(
    decisions
      .find((d) => d.region === "sa-east-1")
      ?.contributors.map((c) => [c.teamId, c.complained]),
  ).toEqual([[teamA, 10]]);
});

it("falls back to our estimate of SES's rate, on the same 0.1% line over either window, while SES's rate can't be read", async () => {
  await clearTraffic();
  await db.delete(schema.regionBreakers);
  const [dom] = await db.select().from(schema.domains).where(eq(schema.domains.teamId, teamA));
  if (!dom) throw new Error("no domain");
  await seedTraffic(teamA, dom.id, 1000, [{ type: "complained", n: 10 }], hoursAgo(72));
  const sa = async (now: Date) => (await evaluate(now)).find((d) => d.region === "sa-east-1");
  const own = {
    trip: true,
    reason: {
      metric: "complaint",
      source: "events",
      rate: 0.01,
      limit: 0.001,
      windowHours: 168,
      sent: 1000,
      events: 10,
    },
  };
  // Never read: the instance's IAM policy has no CloudWatch read.
  expect(await sa(NOW)).toMatchObject(own);
  expect((await sa(NOW))?.contributors.map((c) => [c.teamId, c.complained])).toEqual([[teamA, 10]]);
  // Read under a day ago, the reads since then failing: SES's rate still counts.
  await record(new Map([["sa-east-1", 0.0005]]), NOW);
  const later = (h: number) => new Date(NOW.getTime() + h * 3_600_000);
  expect(await sa(later(23))).toMatchObject({ trip: false });
  // Over a day of failed reads: our own count again.
  expect(await sa(later(25))).toMatchObject(own);
  // SES answering with no rate at all leaves our own count in charge too.
  await record(new Map([["sa-east-1", null]]), later(25));
  expect(await sa(later(25))).toMatchObject(own);

  // The 24-hour window judges the same line: 2 in 3000 stay under it, 3 reach it.
  await clearTraffic();
  await seedTraffic(teamA, dom.id, 3000, [{ type: "complained", n: 2 }]);
  expect(await sa(NOW)).toMatchObject({ trip: false });
  await clearTraffic();
  await seedTraffic(teamA, dom.id, 3000, [{ type: "complained", n: 3 }]);
  expect(await sa(NOW)).toMatchObject({
    trip: true,
    reason: { metric: "complaint", windowHours: 24, rate: 0.001, limit: 0.001, events: 3 },
  });
});

it("leaves sends no recipient can report out of the estimate's denominator, in the rows and the counters alike", async () => {
  await clearTraffic();
  await db.delete(schema.regionBreakers);
  const [dom] = await db.select().from(schema.domains).where(eq(schema.domains.teamId, teamA));
  if (!dom) throw new Error("no domain");
  const sa = async () => (await evaluate()).find((d) => d.region === "sa-east-1");
  // 3 complaints over 4000 sends is 0.075%, but three quarters of them went to Gmail.
  await seedTraffic(teamA, dom.id, 1000, [{ type: "complained", n: 3 }]);
  await seedTraffic(teamA, dom.id, 3000, [], hoursAgo(6), gmail);
  expect((await regionWindowCounts(db, { now: NOW, hours: 24 })).get("sa-east-1")).toEqual({
    sent: 4000,
    complaintSent: 1000,
    hardBounced: 0,
    complained: 3,
  });
  expect(await sa()).toMatchObject({
    trip: true,
    reason: { metric: "complaint", windowHours: 24, rate: 0.003, sent: 1000, events: 3 },
  });

  // The same week read from the counters, out of the 24-hour window.
  await clearTraffic();
  await seedTraffic(teamA, dom.id, 1000, [{ type: "complained", n: 3 }], hoursAgo(72));
  await seedTraffic(teamA, dom.id, 3000, [], hoursAgo(72), gmail);
  expect((await regionCounterTotals(db, { now: NOW, days: 7 })).get("sa-east-1")).toEqual({
    sent: 4000,
    complaintSent: 1000,
    hardBounced: 0,
    complained: 3,
  });
  expect(await sa()).toMatchObject({
    trip: true,
    reason: { metric: "complaint", windowHours: 168, rate: 0.003, sent: 1000, events: 3 },
  });
});

it("reads each stored recipient's domain the way the send path does", async () => {
  await clearTraffic();
  const [dom] = await db.select().from(schema.domains).where(eq(schema.domains.teamId, teamC));
  if (!dom) throw new Error("no domain");
  const sends: { to: string[]; cc?: string[]; bcc?: string[]; silent: boolean }[] = [
    { to: ["a@gmail.com"], silent: true },
    { to: ["Ana <ana@GMail.COM>"], silent: true },
    { to: ['"Bia, Silva" <bia@googlemail.com>'], cc: ["c@icloud.com"], silent: true },
    { to: ["d@me.com"], bcc: ["e@t-online.de", "f@magenta.de"], silent: true },
    { to: ['"g@x"@mac.com'], silent: true },
    { to: ["h@gmail.com", "i@example.com"], silent: false },
    { to: ["j@gmail.com"], cc: ["Kay <k@example.org>"], silent: false },
    { to: ["l@gmail.com"], bcc: ["m@example.net"], silent: false },
    { to: ["n@gmail.com.example"], silent: false },
    { to: ["o@example.com"], silent: false },
    { to: [], silent: false },
  ];
  let complaintSent = 0;
  for (const r of sends) {
    const label = JSON.stringify(r);
    expect(sentWithoutComplaintFeedback([...r.to, ...(r.cc ?? []), ...(r.bcc ?? [])]), label).toBe(
      r.silent,
    );
    await db.insert(schema.emails).values({
      teamId: teamC,
      domainId: dom.id,
      from: "f@c.dev",
      to: r.to,
      cc: r.cc ?? null,
      bcc: r.bcc ?? null,
      subject: "s",
      sentAt: hoursAgo(1),
    });
    if (!r.silent) complaintSent++;
    const counts = await regionWindowCounts(db, { now: NOW, hours: 24, teamIds: [teamC] });
    expect(counts.get("us-east-1")?.complaintSent, label).toBe(complaintSent);
  }
});

it("judges complaints only past their own 1000-send floor, while bounces count every send", async () => {
  await clearTraffic();
  await db.delete(schema.regionBreakers);
  const [a] = await db.select().from(schema.domains).where(eq(schema.domains.teamId, teamA));
  const [c] = await db.select().from(schema.domains).where(eq(schema.domains.teamId, teamC));
  if (!a || !c) throw new Error("no domain");
  // sa-east-1: 1% complaints, but over 999 sends that can draw one.
  await seedTraffic(teamA, a.id, 999, [{ type: "complained", n: 10 }]);
  await seedTraffic(teamA, a.id, 1001, [], hoursAgo(6), gmail);
  // us-east-1: Gmail alone, a complaint arriving anyway (a forward).
  await seedTraffic(teamC, c.id, 2000, [{ type: "complained", n: 5 }], hoursAgo(6), gmail);
  let decisions = await evaluate();
  expect(decisions.find((d) => d.region === "sa-east-1")).toMatchObject({ trip: false });
  expect(decisions.find((d) => d.region === "us-east-1")).toMatchObject({ trip: false });

  // 80 hard bounces on the Gmail sends: 4% of all 2000.
  await clearTraffic();
  await seedTraffic(teamA, a.id, 999, [{ type: "complained", n: 10 }]);
  await seedTraffic(teamA, a.id, 1001, permanent(80), hoursAgo(6), gmail);
  decisions = await evaluate();
  expect(decisions.find((d) => d.region === "sa-east-1")).toMatchObject({
    trip: true,
    reason: { metric: "bounce", windowHours: 24, rate: 0.04, sent: 2000, events: 80 },
  });
});

it("stores SES's rate with its read time, keeps the last one when a read fails, and alerts at 0.08% once a day, paused or not", async () => {
  await db.delete(schema.regionBreakers);
  const at = (h: number) => new Date(NOW.getTime() + h * 3_600_000);
  expect(await record(new Map([["sa-east-1", 0.0007]]), at(0))).toEqual([]);
  const first = await record(new Map([["sa-east-1", 0.0008]]), at(1));
  expect(first).toMatchObject([{ region: "sa-east-1", rate: 0.0008 }]);
  expect(await record(new Map([["sa-east-1", 0.0035]]), at(2))).toEqual([]);
  // A failed read leaves the region out: the stored rate stands for a day.
  await record(new Map(), at(3));
  expect((await sesComplaintReadings(db, at(3))).get("sa-east-1")).toEqual({
    rate: 0.0035,
    read: true,
  });
  expect((await sesComplaintReadings(db, at(27))).get("sa-east-1")).toEqual({
    rate: null,
    read: false,
  });
  expect(await record(new Map([["sa-east-1", 0.0009]]), at(25))).toMatchObject([
    { region: "sa-east-1", rate: 0.0009 },
  ]);
  // SES answering with no rate: read, but nothing to judge.
  await record(new Map([["sa-east-1", null]]), at(26));
  expect((await sesComplaintReadings(db, at(26))).get("sa-east-1")).toEqual({
    rate: null,
    read: true,
  });
  // A paused region still hears, a day apart: the pause's notice says nothing more after it.
  await holdRegion(db, "sa-east-1", "incident");
  expect(await record(new Map([["sa-east-1", 0.0045]]), at(60))).toMatchObject([
    { region: "sa-east-1", rate: 0.0045 },
  ]);
  expect(await record(new Map([["sa-east-1", 0.0045]]), at(61))).toEqual([]);
  await releaseRegion(db, "sa-east-1");
  // The hold and its release leave the reading alone.
  expect((await sesComplaintReadings(db, at(61))).get("sa-east-1")).toEqual({
    rate: 0.0045,
    read: true,
  });
});

/** One email sent at `sentAt`, and SES's complaint about it arriving at `complainedAt`. */
async function complainedSend(
  teamId: string,
  domainId: string | null,
  sentAt: Date,
  complainedAt = sentAt,
  to = ["r@example.com"],
): Promise<string> {
  const [email] = await db
    .insert(schema.emails)
    .values({ teamId, domainId, from: "f@example.com", to, subject: "s", sentAt })
    .returning({ id: schema.emails.id });
  if (!email) throw new Error("seed failed");
  await db.insert(schema.emailEvents).values({
    emailId: email.id,
    type: "complained",
    occurredAt: complainedAt,
    createdAt: complainedAt,
    snsMessageId: `sns-${email.id}`,
    data: { complaint: { complainedRecipients: to.map((emailAddress) => ({ emailAddress })) } },
  });
  return email.id;
}

async function teamOn(slug: string, plan: "free" | "pro", region: string) {
  const teamId = await createTeam(db, slug);
  await db.update(schema.teams).set({ plan }).where(eq(schema.teams.id, teamId));
  return { teamId, domainId: await domainIn(teamId, `${slug}.example`, region) };
}

it("leaves complaints and hard bounces naming only SES's mailbox simulator out, and mail to it alone out of the complaint base", async () => {
  await clearTraffic();
  const [dom] = await db.select().from(schema.domains).where(eq(schema.domains.teamId, teamC));
  if (!dom) throw new Error("no domain");
  const sim = ["complaint@simulator.amazonses.com"];
  const sent = hoursAgo(2);
  await complainedSend(teamC, dom.id, sent, sent, sim);
  // Every named recipient must be the simulator's for the event to stay out.
  await complainedSend(teamC, dom.id, sent, sent, [...sim, "r@example.com"]);
  await complainedSend(teamC, dom.id, sent, sent);
  const [bounced] = await db
    .insert(schema.emails)
    .values({
      teamId: teamC,
      domainId: dom.id,
      from: "f@example.com",
      to: ["bounce@simulator.amazonses.com"],
      subject: "s",
      sentAt: sent,
    })
    .returning({ id: schema.emails.id });
  if (!bounced) throw new Error("seed failed");
  await db.insert(schema.emailEvents).values({
    emailId: bounced.id,
    type: "bounced",
    occurredAt: sent,
    createdAt: sent,
    snsMessageId: `sns-${bounced.id}`,
    bounceType: "Permanent",
    data: {
      bounce: {
        bounceType: "Permanent",
        bounceSubType: "General",
        bouncedRecipients: [{ emailAddress: "bounce@simulator.amazonses.com" }],
      },
    },
  });
  expect(
    (await regionWindowCounts(db, { now: NOW, hours: 24, teamIds: [teamC] })).get("us-east-1"),
  ).toEqual({ sent: 4, complaintSent: 2, hardBounced: 0, complained: 2 });
  // A stripped payload names no one, and reads as counted.
  await db.update(schema.emailEvents).set({ data: null });
  expect(
    (await regionWindowCounts(db, { now: NOW, hours: 24, teamIds: [teamC] })).get("us-east-1"),
  ).toMatchObject({ hardBounced: 1, complained: 3 });
});

it("counts a copy to the mailbox simulator in the team's own stats, delivered and complained, while the breaker leaves it out", async () => {
  await clearTraffic();
  const [dom] = await db.select().from(schema.domains).where(eq(schema.domains.teamId, teamC));
  if (!dom) throw new Error("no domain");
  const [broadcast] = await db
    .insert(schema.broadcasts)
    .values({ teamId: teamC, from: "f@example.com", subject: "s" })
    .returning({ id: schema.broadcasts.id });
  if (!broadcast) throw new Error("seed failed");
  const id = await complainedSend(teamC, dom.id, hoursAgo(2), hoursAgo(2), [
    "complaint@simulator.amazonses.com",
  ]);
  await db
    .update(schema.emails)
    .set({ latestStatus: "complained", broadcastId: broadcast.id })
    .where(eq(schema.emails.id, id));
  const [stats] = await db
    .select({
      delivered: sql<number>`count(*) filter (where ${deliveredEmail})::int`,
      complained: sql<number>`count(*) filter (where ${complainedEmail})::int`,
    })
    .from(schema.emails);
  expect(stats).toEqual({ delivered: 1, complained: 1 });
  expect(
    await broadcastProviderBreakdown(db, { teamId: teamC, broadcastId: broadcast.id }),
  ).toMatchObject([{ sent: 1, complained: 1 }]);
  expect(
    (await regionWindowCounts(db, { now: NOW, hours: 24, teamIds: [teamC] })).get("us-east-1"),
  ).toEqual({ sent: 1, complaintSent: 0, hardBounced: 0, complained: 0 });
});

it("reads a team's month by when its mail was sent, mail with no domain row in the default region", async () => {
  await clearTraffic();
  const [a] = await db.select().from(schema.domains).where(eq(schema.domains.teamId, teamA));
  if (!a) throw new Error("no domain");
  const day = (n: number) => new Date(NOW.getTime() - n * DAY_MS);
  // Shared inbox or onboarding mail: no domain row, so the default region.
  await complainedSend(teamB, null, day(10), day(9));
  await complainedSend(teamB, null, day(5), day(1));
  await seedTraffic(teamB, a.id, 2, [], day(3), gmail);
  // Sent before the month: its complaint, however recent, is not the month's.
  await complainedSend(teamA, a.id, day(31), day(1));
  await seedTraffic(teamA, a.id, 5, [], day(2));
  const stats = await regionTeamStats(db, {
    region: "sa-east-1",
    defaultRegion: DEFAULT_REGION,
    now: NOW,
  });
  expect(stats).toEqual([
    {
      teamId: teamB,
      teamName: "breaker-b",
      plan: "free",
      currentPeriodEnd: null,
      sent: 4,
      complaintSent: 2,
      complained: 2,
      hardBounced: 0,
      lastComplaintAt: day(1),
    },
  ]);
  expect(
    await regionTeamStats(db, { region: "us-east-1", defaultRegion: DEFAULT_REGION, now: NOW }),
  ).toEqual([]);
});

it("trips at SES's 0.1% and holds a complaint pause until the rate is under 0.08%; a bounce pause resumes at once", async () => {
  await clearTraffic();
  await db.delete(schema.regionBreakers);
  const at = (h: number) => new Date(NOW.getTime() + h * 3_600_000);
  const step = async (rate: number, h: number) => {
    await record(new Map([["eu-west-1", rate]]), at(h));
    return applyRegionBreakers(db, await evaluate(at(h)), at(h));
  };
  expect(await step(0.00099, 0)).toEqual({ tripped: [], resumed: [] });
  expect(await step(0.001, 1)).toEqual({ tripped: ["eu-west-1"], resumed: [] });
  expect(await step(0.0009, 2)).toEqual({ tripped: [], resumed: [] });
  expect(await pausedRegions(db)).toMatchObject([
    { region: "eu-west-1", reason: { source: "ses", rate: 0.001 }, pausedAt: at(1) },
  ]);
  expect(await step(0.0007, 3)).toEqual({ tripped: [], resumed: ["eu-west-1"] });

  await applyRegionBreakers(
    db,
    [
      {
        region: "eu-west-1",
        trip: true,
        reason: {
          metric: "bounce",
          rate: 0.05,
          limit: 0.04,
          windowHours: 24,
          sent: 1000,
          events: 50,
        },
        contributors: [],
      },
    ],
    at(4),
  );
  expect(await step(0.0009, 5)).toEqual({ tripped: [], resumed: ["eu-west-1"] });
});

it("on a complaint trip holds only the broadcasts of the paid teams at 0.1% on their month, and puts Free teams with a complaint up for review on Cloud", async () => {
  await clearTraffic();
  await db.delete(schema.regionBreakers);
  const R = "ca-central-1";
  const hot = await teamOn("scope-hot", "pro", R);
  const cool = await teamOn("scope-cool", "pro", R);
  const free = await teamOn("scope-free", "free", R);
  // 2 in 1000: 0.2%. 1 in 2998: under the line. 1 in 10 on Free.
  await seedTraffic(hot.teamId, hot.domainId, 1000, [{ type: "complained", n: 2 }], hoursAgo(48));
  await seedTraffic(cool.teamId, cool.domainId, 2998, [{ type: "complained", n: 1 }], hoursAgo(48));
  await seedTraffic(free.teamId, free.domainId, 10, [{ type: "complained", n: 1 }], hoursAgo(48));
  await record(new Map([[R, 0.0012]]), NOW);
  const cloud = (await evaluate(NOW, true)).find((d) => d.region === R);
  expect(cloud?.heldTeams?.map((s) => s.teamId)).toEqual([hot.teamId]);
  expect(cloud?.reviewTeams?.map((s) => s.teamId)).toEqual([free.teamId]);
  expect(await applyRegionBreakers(db, cloud ? [cloud] : [], NOW)).toEqual({
    tripped: [R],
    resumed: [],
  });
  expect(await pausedRegions(db)).toMatchObject([{ region: R, heldTeams: [hot.teamId] }]);
  expect(await regionPause(db, R, hot.teamId)).toMatchObject({ heldTeams: [hot.teamId] });
  expect(await regionPause(db, R, cool.teamId)).toBeNull();
  expect(await regionPause(db, R, free.teamId)).toBeNull();
  expect(pauseHolds({ heldTeams: [hot.teamId] }, cool.teamId)).toBe(false);
  expect(pauseHolds({ heldTeams: null }, cool.teamId)).toBe(true);

  // Two more complaints bring the second paid team to the line, 3 in 3000:
  // the scope widens, the pause keeps its start.
  await complainedSend(cool.teamId, cool.domainId, hoursAgo(24));
  await complainedSend(cool.teamId, cool.domainId, hoursAgo(24));
  const later = new Date(NOW.getTime() + 15 * 60_000);
  expect(await applyRegionBreakers(db, await evaluate(later, true), later)).toEqual({
    tripped: [],
    resumed: [],
  });
  expect(await pausedRegions(db)).toMatchObject([
    { region: R, heldTeams: [hot.teamId, cool.teamId].sort(), pausedAt: NOW },
  ]);

  // Self-hosted, every team counts as paid and nobody is held for review.
  const selfHosted = (await evaluate(later, false)).find((d) => d.region === R);
  expect(selfHosted?.heldTeams?.map((s) => s.teamId).sort()).toEqual(
    [hot.teamId, cool.teamId, free.teamId].sort(),
  );
  expect(selfHosted?.reviewTeams).toEqual([]);

  // An operator's hold covers every team.
  await holdRegion(db, R, "incident");
  expect(await regionPause(db, R, free.teamId)).toMatchObject({ heldTeams: null });
  await releaseRegion(db, R);
  expect(await regionPause(db, R, hot.teamId)).toBeNull();
});

it("holds a Free team with a complaint for review once, and after its release only for a newer complaint", async () => {
  await clearTraffic();
  await db.delete(schema.regionBreakers);
  const R = "ap-northeast-1";
  const free = await teamOn("review-free", "free", R);
  await seedTraffic(free.teamId, free.domainId, 5, []);
  await complainedSend(free.teamId, free.domainId, hoursAgo(3), hoursAgo(2));
  await record(new Map([[R, 0.002]]), NOW);
  const reviewTeams = async (now: Date) =>
    (await evaluate(now, true)).find((d) => d.region === R)?.reviewTeams ?? [];
  expect(await holdComplaintTeams(db, await reviewTeams(NOW), NOW)).toEqual([free.teamId]);
  const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, free.teamId));
  expect(team).toMatchObject({ suspensionReason: "review", suspendedAt: NOW });
  expect(
    await db.select().from(schema.teamFlags).where(eq(schema.teamFlags.teamId, free.teamId)),
  ).toMatchObject([
    { reason: "complaints", status: "open", detail: { metric: "complaint", suspension: true } },
  ]);
  const audit = await db
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.teamId, free.teamId));
  expect(audit).toMatchObject([{ action: "team.held_for_review", actorId: "system", data: null }]);
  // The content monitor's own hold stays possible.
  expect(
    await db.select().from(schema.teamMonitor).where(eq(schema.teamMonitor.teamId, free.teamId)),
  ).toEqual([]);
  // Already held: nothing again.
  expect(await holdComplaintTeams(db, await reviewTeams(NOW), NOW)).toEqual([]);

  // The operator releases it: the same complaint never holds it again.
  await db
    .update(schema.teams)
    .set({ suspendedAt: null, suspensionReason: null })
    .where(eq(schema.teams.id, free.teamId));
  await db
    .update(schema.teamFlags)
    .set({ status: "cleared" })
    .where(eq(schema.teamFlags.teamId, free.teamId));
  await db.insert(schema.auditLog).values({
    teamId: free.teamId,
    actorId: "user:op",
    action: "team.reinstated",
    createdAt: hoursAgo(1),
  });
  expect(await holdComplaintTeams(db, await reviewTeams(NOW), NOW)).toEqual([]);
  // A complaint that arrived after the release does.
  await complainedSend(free.teamId, free.domainId, hoursAgo(1), NOW);
  const later = new Date(NOW.getTime() + 60_000);
  expect(await holdComplaintTeams(db, await reviewTeams(later), later)).toEqual([free.teamId]);
});

it("trips the Free fuse at 3 complaints on Free teams' mail in 7 days, counts nothing sent before a release, and parks only Free mail a provider can report", async () => {
  await clearTraffic();
  await db.delete(schema.regionBreakers);
  const R = "eu-central-1";
  const freeA = await teamOn("fuse-a", "free", R);
  const freeB = await teamOn("fuse-b", "free", R);
  const paid = await teamOn("fuse-paid", "pro", R);
  // A paid plan past its grace window is limited as Free.
  const lapsed = await teamOn("fuse-lapsed", "pro", R);
  await db
    .update(schema.teams)
    .set({ currentPeriodEnd: new Date(NOW.getTime() - 30 * DAY_MS) })
    .where(eq(schema.teams.id, lapsed.teamId));
  const fuse = async () =>
    (await db.select().from(schema.instanceSettings))[0] ?? {
      freeFuseTrippedAt: null,
      freeFuseComplaints: null,
    };

  await complainedSend(freeA.teamId, freeA.domainId, hoursAgo(30));
  await complainedSend(freeB.teamId, freeB.domainId, hoursAgo(20));
  // Mail sent before the window never counts, whenever its complaint came.
  await complainedSend(freeB.teamId, freeB.domainId, hoursAgo(8 * 24), hoursAgo(1));
  for (let i = 0; i < 5; i++) await complainedSend(paid.teamId, paid.domainId, hoursAgo(10));
  expect(await evaluateFreeFuse(db, NOW)).toBeNull();
  expect((await fuse()).freeFuseTrippedAt).toBeNull();

  await complainedSend(lapsed.teamId, lapsed.domainId, hoursAgo(5));
  expect(await evaluateFreeFuse(db, NOW)).toEqual({
    complaints: 3,
    teams: [
      { teamName: "fuse-a", complaints: 1 },
      { teamName: "fuse-b", complaints: 1 },
      { teamName: "fuse-lapsed", complaints: 1 },
    ],
  });
  expect(await fuse()).toMatchObject({ freeFuseTrippedAt: NOW, freeFuseComplaints: 3 });
  // Tripped, it waits for the operator.
  expect(await evaluateFreeFuse(db, new Date(NOW.getTime() + 60_000))).toBeNull();

  const mail = (teamId: string, to: string[]) => ({ teamId, to, cc: null, bcc: null });
  expect(await freeFuseHolds(db, mail(freeA.teamId, ["r@outlook.com"]))).toBe(true);
  expect(await freeFuseHolds(db, mail(freeA.teamId, ["r@gmail.com", "s@icloud.com"]))).toBe(false);
  expect(
    await freeFuseHolds(db, { ...mail(freeA.teamId, ["r@gmail.com"]), bcc: ["s@yahoo.com"] }),
  ).toBe(true);
  expect(await freeFuseHolds(db, mail(paid.teamId, ["r@outlook.com"]))).toBe(false);

  const [parked] = await db
    .insert(schema.emails)
    .values({
      teamId: freeA.teamId,
      from: "f@example.com",
      to: ["r@outlook.com"],
      subject: "s",
      latestStatus: "queued_quota",
      parkReason: "fuse",
    })
    .returning({ id: schema.emails.id });
  if (!parked) throw new Error("seed failed");
  expect(await freeFuseState(db)).toEqual({ trippedAt: NOW, complaints: 3, parked: 1 });

  const released = new Date(NOW.getTime() + DAY_MS);
  expect(await releaseFreeFuse(db, released)).toEqual({ complaints: 3, emails: 1 });
  expect(await releaseFreeFuse(db, released)).toBeNull();
  expect(await freeFuseState(db)).toBeNull();
  const [row] = await db.select().from(schema.emails).where(eq(schema.emails.id, parked.id));
  expect(row).toMatchObject({ latestStatus: "queued_quota", parkReason: null });
  expect(await freeFuseHolds(db, mail(freeA.teamId, ["r@outlook.com"]))).toBe(false);

  // The window starts over at the release: the week's three complaints are spent.
  const after = (h: number) => new Date(released.getTime() + h * 3_600_000);
  expect(await evaluateFreeFuse(db, after(1))).toBeNull();
  await complainedSend(freeA.teamId, freeA.domainId, after(1), after(2));
  await complainedSend(freeA.teamId, freeA.domainId, after(1), after(2));
  expect(await evaluateFreeFuse(db, after(3))).toBeNull();
  await complainedSend(freeB.teamId, freeB.domainId, after(1), after(3));
  expect(await evaluateFreeFuse(db, after(4))).toMatchObject({ complaints: 3 });
  await releaseFreeFuse(db, after(5));
});

it("counts complaints SES attempted on mail with no email row over the month, and purges them after 35 days", async () => {
  const u = schema.sesUnmatchedEvents;
  await db.delete(u);
  const day = (n: number) => new Date(NOW.getTime() - n * DAY_MS);
  await db.insert(u).values([
    { sesMessageId: "m1", type: "complained", occurredAt: day(2), createdAt: day(1) },
    {
      sesMessageId: "m2",
      type: "complained",
      subType: "OnAccountSuppressionList",
      occurredAt: day(1),
      createdAt: day(1),
    },
    {
      sesMessageId: "m3",
      type: "bounced",
      bounceType: "Permanent",
      occurredAt: day(1),
      createdAt: day(1),
    },
    { sesMessageId: "m4", type: "complained", occurredAt: day(31), createdAt: day(31) },
    { sesMessageId: "m5", type: "complained", occurredAt: day(36), createdAt: day(36) },
  ]);
  expect(await unmatchedComplaints(db, NOW)).toBe(1);
  expect(await purgeUnmatchedSesEvents(db, NOW)).toBe(1);
  expect((await db.select({ id: u.sesMessageId }).from(u)).map((r) => r.id).sort()).toEqual([
    "m1",
    "m2",
    "m3",
    "m4",
  ]);
});

it("reports a change of SES's enforcement status once, and a first sighting only off HEALTHY", async () => {
  await db.delete(schema.regionBreakers);
  const statuses = (entries: [string, string][]) =>
    recordSesEnforcementStatuses(db, new Map(entries));
  expect(await statuses([["sa-east-1", "HEALTHY"]])).toEqual([]);
  expect(await statuses([["sa-east-1", "HEALTHY"]])).toEqual([]);
  expect(await statuses([["sa-east-1", "PROBATION"]])).toEqual([
    { region: "sa-east-1", from: "HEALTHY", to: "PROBATION" },
  ]);
  expect(await statuses([["sa-east-1", "PROBATION"]])).toEqual([]);
  expect(
    await statuses([
      ["sa-east-1", "HEALTHY"],
      ["us-east-1", "SHUTDOWN"],
    ]),
  ).toEqual([
    { region: "sa-east-1", from: "PROBATION", to: "HEALTHY" },
    { region: "us-east-1", from: null, to: "SHUTDOWN" },
  ]);
  // A failed read leaves the region out: its last status stands.
  expect(await statuses([])).toEqual([]);
  expect(
    (await db.select().from(schema.regionBreakers)).map((r) => [r.region, r.sesEnforcementStatus]),
  ).toEqual(
    expect.arrayContaining([
      ["sa-east-1", "HEALTHY"],
      ["us-east-1", "SHUTDOWN"],
    ]),
  );
});
