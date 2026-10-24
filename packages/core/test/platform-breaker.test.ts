import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { sentWithoutComplaintFeedback, sesAttempted } from "../src/mailbox-providers.js";
import {
  applyRegionBreakers,
  evaluateRegionBreakers,
  holdRegion,
  pausedRegions,
  recordSesComplaintRates,
  regionCounterTotals,
  regionPause,
  regionWindowCounts,
  releaseRegion,
  sesComplaintReadings,
} from "../src/platform-breaker.js";
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
  const decisions = await evaluateRegionBreakers(db, { now: NOW });
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
  const decisions = await evaluateRegionBreakers(db, { now: NOW });
  expect(await applyRegionBreakers(db, decisions, NOW)).toEqual({
    tripped: ["sa-east-1"],
    resumed: [],
  });
  expect(await applyRegionBreakers(db, decisions, NOW)).toEqual({ tripped: [], resumed: [] });
  expect((await regionPause(db, "sa-east-1"))?.reason?.metric).toBe("bounce");
  expect(await regionPause(db, "us-east-1")).toBeNull();
  expect((await pausedRegions(db)).map((r) => r.region)).toEqual(["sa-east-1"]);
});

it("resumes once both windows are under the line, and transient bounces never count", async () => {
  await db.delete(schema.emailEvents).where(eq(schema.emailEvents.type, "bounced"));
  await db.update(schema.usageCounters).set({ hardBounced: 0 });
  const cleared = await evaluateRegionBreakers(db, { now: NOW });
  expect(cleared.find((d) => d.region === "sa-east-1")?.trip).toBe(false);
  expect(await applyRegionBreakers(db, cleared, NOW)).toEqual({
    tripped: [],
    resumed: ["sa-east-1"],
  });
  expect(await regionPause(db, "sa-east-1")).toBeNull();

  // 45 transient bounces on 1000 sends: 4.5% would trip if they counted.
  const [dom] = await db.select().from(schema.domains).where(eq(schema.domains.teamId, teamA));
  if (!dom) throw new Error("no domain");
  await seedTraffic(teamA, dom.id, 45, [{ type: "bounced", bounceType: "Transient", n: 45 }]);
  const transient = await evaluateRegionBreakers(db, { now: NOW });
  expect(transient.find((d) => d.region === "sa-east-1")?.trip).toBe(false);
  await seedTraffic(teamA, dom.id, 45, [{ type: "bounced", bounceType: "Permanent", n: 45 }]);
  const permanent = await evaluateRegionBreakers(db, { now: NOW });
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
  const decisions = await evaluateRegionBreakers(db, { now: NOW });
  const us = decisions.find((d) => d.region === "us-east-1");
  expect(us).toMatchObject({ trip: true, reason: { windowHours: 168 } });
  // Contributors follow the window that tripped, not a fixed 24h.
  expect(us?.contributors.map((c) => [c.teamId, c.hardBounced])).toEqual([[teamC, 45]]);
});

it("exactly 4.00% hard bounces (40 in 1000) trips the bounce line", async () => {
  await clearTraffic();
  const [dom] = await db.select().from(schema.domains).where(eq(schema.domains.teamId, teamA));
  if (!dom) throw new Error("no domain");
  await seedTraffic(teamA, dom.id, 1000, [{ type: "bounced", bounceType: "Permanent", n: 40 }]);
  const decisions = await evaluateRegionBreakers(db, { now: NOW });
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
  const decisions = await evaluateRegionBreakers(db, { now: NOW });
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
  const decisions = await evaluateRegionBreakers(db, { now: NOW });
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
  const sa = (await evaluateRegionBreakers(db, { now: NOW })).find((d) => d.region === "sa-east-1");
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
  const decisions = await evaluateRegionBreakers(db, { now: NOW });
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
  const decisions = await evaluateRegionBreakers(db, { now: NOW });
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
  const decisions = await evaluateRegionBreakers(db, { now: NOW });
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
  const decisions = await evaluateRegionBreakers(db, { now: NOW });
  const applied = await applyRegionBreakers(db, decisions, NOW);
  expect(applied.resumed).not.toContain("us-east-1");
  expect(await regionPause(db, "us-east-1")).toMatchObject({ manualReason: "incident" });
  await releaseRegion(db, "us-east-1");
  expect(await regionPause(db, "us-east-1")).toBeNull();
});

it("judges complaints on SES's own rate while it can be read: 0.4% trips, our own count does not", async () => {
  await clearTraffic();
  await db.delete(schema.regionBreakers);
  const [dom] = await db.select().from(schema.domains).where(eq(schema.domains.teamId, teamA));
  if (!dom) throw new Error("no domain");
  // 1% of our own count, past the 0.4% line.
  await seedTraffic(teamA, dom.id, 1000, [{ type: "complained", n: 10 }], hoursAgo(72));
  await recordSesComplaintRates(
    db,
    new Map([
      ["sa-east-1", 0.0039],
      ["us-east-1", 0.004],
      // No traffic of ours there: SES's rate alone puts it in the run.
      ["eu-west-1", 0.0051],
    ]),
    NOW,
  );
  let decisions = await evaluateRegionBreakers(db, { now: NOW });
  expect(decisions.find((d) => d.region === "sa-east-1")).toMatchObject({ trip: false });
  expect(decisions.find((d) => d.region === "us-east-1")).toMatchObject({
    trip: true,
    reason: { metric: "complaint", source: "ses", rate: 0.004, limit: 0.004 },
  });
  expect(decisions.find((d) => d.region === "eu-west-1")).toMatchObject({
    trip: true,
    contributors: [],
  });

  await recordSesComplaintRates(db, new Map([["sa-east-1", 0.0042]]), NOW);
  decisions = await evaluateRegionBreakers(db, { now: NOW });
  // SES's rate spans far more than a day: the week's teams are named.
  expect(decisions.find((d) => d.region === "sa-east-1")).toMatchObject({
    trip: true,
    reason: { source: "ses", rate: 0.0042 },
  });
  expect(
    decisions
      .find((d) => d.region === "sa-east-1")
      ?.contributors.map((c) => [c.teamId, c.complained]),
  ).toEqual([[teamA, 10]]);
});

it("falls back to our estimate of SES's rate, on the same 0.4% line over either window, while SES's rate can't be read", async () => {
  await clearTraffic();
  await db.delete(schema.regionBreakers);
  const [dom] = await db.select().from(schema.domains).where(eq(schema.domains.teamId, teamA));
  if (!dom) throw new Error("no domain");
  await seedTraffic(teamA, dom.id, 1000, [{ type: "complained", n: 10 }], hoursAgo(72));
  const sa = async (now: Date) =>
    (await evaluateRegionBreakers(db, { now })).find((d) => d.region === "sa-east-1");
  const own = {
    trip: true,
    reason: {
      metric: "complaint",
      source: "events",
      rate: 0.01,
      limit: 0.004,
      windowHours: 168,
      sent: 1000,
      events: 10,
    },
  };
  // Never read: the instance's IAM policy has no CloudWatch read.
  expect(await sa(NOW)).toMatchObject(own);
  expect((await sa(NOW))?.contributors.map((c) => [c.teamId, c.complained])).toEqual([[teamA, 10]]);
  // Read under a day ago, the reads since then failing: SES's rate still counts.
  await recordSesComplaintRates(db, new Map([["sa-east-1", 0.001]]), NOW);
  const later = (h: number) => new Date(NOW.getTime() + h * 3_600_000);
  expect(await sa(later(23))).toMatchObject({ trip: false });
  // Over a day of failed reads: our own count again.
  expect(await sa(later(25))).toMatchObject(own);
  // SES answering with no rate at all leaves our own count in charge too.
  await recordSesComplaintRates(db, new Map([["sa-east-1", null]]), later(25));
  expect(await sa(later(25))).toMatchObject(own);

  // The 24-hour window judges the same line: 3 in 1000 stay under it, 4 reach it.
  await clearTraffic();
  await seedTraffic(teamA, dom.id, 1000, [{ type: "complained", n: 3 }]);
  expect(await sa(NOW)).toMatchObject({ trip: false });
  await clearTraffic();
  await seedTraffic(teamA, dom.id, 1000, [{ type: "complained", n: 4 }]);
  expect(await sa(NOW)).toMatchObject({
    trip: true,
    reason: { metric: "complaint", windowHours: 24, rate: 0.004, limit: 0.004, events: 4 },
  });
});

it("leaves sends no recipient can report out of the estimate's denominator, in the rows and the counters alike", async () => {
  await clearTraffic();
  await db.delete(schema.regionBreakers);
  const [dom] = await db.select().from(schema.domains).where(eq(schema.domains.teamId, teamA));
  if (!dom) throw new Error("no domain");
  const sa = async () =>
    (await evaluateRegionBreakers(db, { now: NOW })).find((d) => d.region === "sa-east-1");
  // 4 complaints over 2000 sends is 0.2%, but half of them went to Gmail.
  await seedTraffic(teamA, dom.id, 1000, [{ type: "complained", n: 4 }]);
  await seedTraffic(teamA, dom.id, 1000, [], hoursAgo(6), gmail);
  expect((await regionWindowCounts(db, { now: NOW, hours: 24 })).get("sa-east-1")).toEqual({
    sent: 2000,
    complaintSent: 1000,
    hardBounced: 0,
    complained: 4,
  });
  expect(await sa()).toMatchObject({
    trip: true,
    reason: { metric: "complaint", windowHours: 24, rate: 0.004, sent: 1000, events: 4 },
  });

  // The same week read from the counters, out of the 24-hour window.
  await clearTraffic();
  await seedTraffic(teamA, dom.id, 1000, [{ type: "complained", n: 4 }], hoursAgo(72));
  await seedTraffic(teamA, dom.id, 1000, [], hoursAgo(72), gmail);
  expect((await regionCounterTotals(db, { now: NOW, days: 7 })).get("sa-east-1")).toEqual({
    sent: 2000,
    complaintSent: 1000,
    hardBounced: 0,
    complained: 4,
  });
  expect(await sa()).toMatchObject({
    trip: true,
    reason: { metric: "complaint", windowHours: 168, rate: 0.004, sent: 1000, events: 4 },
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
  let decisions = await evaluateRegionBreakers(db, { now: NOW });
  expect(decisions.find((d) => d.region === "sa-east-1")).toMatchObject({ trip: false });
  expect(decisions.find((d) => d.region === "us-east-1")).toMatchObject({ trip: false });

  // 80 hard bounces on the Gmail sends: 4% of all 2000.
  await clearTraffic();
  await seedTraffic(teamA, a.id, 999, [{ type: "complained", n: 10 }]);
  await seedTraffic(teamA, a.id, 1001, permanent(80), hoursAgo(6), gmail);
  decisions = await evaluateRegionBreakers(db, { now: NOW });
  expect(decisions.find((d) => d.region === "sa-east-1")).toMatchObject({
    trip: true,
    reason: { metric: "bounce", windowHours: 24, rate: 0.04, sent: 2000, events: 80 },
  });
});

it("stores SES's rate with its read time, keeps the last one when a read fails, and alerts at 0.3% once a day unless paused", async () => {
  await db.delete(schema.regionBreakers);
  const at = (h: number) => new Date(NOW.getTime() + h * 3_600_000);
  expect(await recordSesComplaintRates(db, new Map([["sa-east-1", 0.0025]]), at(0))).toEqual([]);
  const first = await recordSesComplaintRates(db, new Map([["sa-east-1", 0.003]]), at(1));
  expect(first).toMatchObject([{ region: "sa-east-1", rate: 0.003 }]);
  expect(await recordSesComplaintRates(db, new Map([["sa-east-1", 0.0035]]), at(2))).toEqual([]);
  // A failed read leaves the region out: the stored rate stands for a day.
  await recordSesComplaintRates(db, new Map(), at(3));
  expect((await sesComplaintReadings(db, at(3))).get("sa-east-1")).toEqual({
    rate: 0.0035,
    read: true,
  });
  expect((await sesComplaintReadings(db, at(27))).get("sa-east-1")).toEqual({
    rate: null,
    read: false,
  });
  expect(await recordSesComplaintRates(db, new Map([["sa-east-1", 0.0033]]), at(25))).toMatchObject(
    [{ region: "sa-east-1", rate: 0.0033 }],
  );
  // SES answering with no rate: read, but nothing to judge.
  await recordSesComplaintRates(db, new Map([["sa-east-1", null]]), at(26));
  expect((await sesComplaintReadings(db, at(26))).get("sa-east-1")).toEqual({
    rate: null,
    read: true,
  });
  // A paused region has its pause notice; no daily alert on top.
  await holdRegion(db, "sa-east-1", "incident");
  expect(await recordSesComplaintRates(db, new Map([["sa-east-1", 0.0045]]), at(60))).toEqual([]);
  await releaseRegion(db, "sa-east-1");
  // The hold and its release leave the reading alone.
  expect((await sesComplaintReadings(db, at(60))).get("sa-east-1")).toEqual({
    rate: 0.0045,
    read: true,
  });
});
