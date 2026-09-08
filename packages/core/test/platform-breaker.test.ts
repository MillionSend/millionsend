import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  applyRegionBreakers,
  evaluateRegionBreakers,
  pausedRegions,
  regionCounterTotals,
  regionPause,
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
  counts: { sent?: number; hardBounced?: number; complained?: number },
): Promise<void> {
  const c = schema.usageCounters;
  const row = { sent: 0, hardBounced: 0, complained: 0, ...counts };
  await db
    .insert(c)
    .values({ teamId, day, ...row })
    .onConflictDoUpdate({
      target: [c.teamId, c.day],
      set: {
        sent: sql`${c.sent} + ${row.sent}`,
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
  events: { type: "complained" | "bounced"; bounceType?: string; n: number }[],
  sentAt = hoursAgo(6),
): Promise<void> {
  const rows = await db
    .insert(schema.emails)
    .values(
      Array.from({ length: sent }, (_, i) => ({
        teamId,
        domainId,
        from: "f@a.com",
        to: [`r${i}@b.com`],
        subject: "s",
        sentAt,
      })),
    )
    .returning({ id: schema.emails.id });
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
        data: spec.type === "bounced" ? { bounce: { bounceType: spec.bounceType } } : {},
      });
    }
  }
  const n = (pred: (e: (typeof events)[number]) => boolean) =>
    events.filter(pred).reduce((sum, e) => sum + e.n, 0);
  await bumpCounters(teamId, utcDay(sentAt), {
    sent,
    hardBounced: n((e) => e.type === "bounced" && e.bounceType === "Permanent"),
    complained: n((e) => e.type === "complained"),
  });
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamA = await createTeam(db, "breaker-a");
  teamB = await createTeam(db, "breaker-b");
  teamC = await createTeam(db, "breaker-c");
  const a = await domainIn(teamA, "a.dev", "sa-east-1");
  const b = await domainIn(teamB, "b.dev", "sa-east-1");
  const c = await domainIn(teamC, "c.dev", "us-east-1");
  // sa-east-1: 1000 sends, 5 complaints (0.5% ≥ 80% of the 0.1% line).
  await seedTraffic(teamA, a, 700, [{ type: "complained", n: 3 }]);
  await seedTraffic(teamB, b, 300, [{ type: "complained", n: 2 }]);
  // us-east-1: a worse rate, but under the 1000-send floor.
  await seedTraffic(teamC, c, 500, [{ type: "complained", n: 5 }]);
});
afterAll(() => close());

it("trips a region on the 24h complaint rate, names contributors worst first, and skips under the floor", async () => {
  const decisions = await evaluateRegionBreakers(db, { now: NOW });
  const sa = decisions.find((d) => d.region === "sa-east-1");
  const us = decisions.find((d) => d.region === "us-east-1");
  expect(sa).toMatchObject({
    trip: true,
    reason: { metric: "complaint", windowHours: 24, sent: 1000, events: 5, rate: 0.005 },
  });
  expect(sa?.contributors.map((c) => [c.teamId, c.complained])).toEqual([
    [teamA, 3],
    [teamB, 2],
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
  expect((await regionPause(db, "sa-east-1"))?.reason?.metric).toBe("complaint");
  expect(await regionPause(db, "us-east-1")).toBeNull();
  expect((await pausedRegions(db)).map((r) => r.region)).toEqual(["sa-east-1"]);
});

it("resumes once both windows are under the line, and transient bounces never count", async () => {
  await db.delete(schema.emailEvents).where(eq(schema.emailEvents.type, "complained"));
  await db.update(schema.usageCounters).set({ complained: 0 });
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
  await seedTraffic(teamC, dom.id, 1000, [{ type: "complained", n: 5 }], hoursAgo(72));
  const decisions = await evaluateRegionBreakers(db, { now: NOW });
  const us = decisions.find((d) => d.region === "us-east-1");
  expect(us).toMatchObject({ trip: true, reason: { windowHours: 168 } });
  // Contributors follow the window that tripped, not a fixed 24h.
  expect(us?.contributors.map((c) => [c.teamId, c.complained])).toEqual([[teamC, 5]]);
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
          limit: 0.0008,
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
  // with it in, 5 complaints over 10000 sends would sit under the line.
  await bumpCounters(teamD, day(7), { sent: 9000 });
  // The tripping day's rows exist too (seedTraffic bumps its counters).
  await seedTraffic(teamD, dom.id, 600, [{ type: "complained", n: 5 }], hoursAgo(6 * 24));
  await bumpCounters(teamD, day(0), { sent: 400 });
  expect(await regionCounterTotals(db, { now: NOW, days: 7 })).toEqual(
    new Map([["ap-south-1", { sent: 1000, hardBounced: 0, complained: 5 }]]),
  );
  const decisions = await evaluateRegionBreakers(db, { now: NOW });
  expect(decisions.map((d) => d.region)).toEqual(["ap-south-1"]);
  expect(decisions[0]).toMatchObject({
    trip: true,
    reason: { metric: "complaint", windowHours: 168, sent: 1000, events: 5 },
  });
  expect(decisions[0]?.contributors.map((c) => [c.teamId, c.complained])).toEqual([[teamD, 5]]);
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
  await seedTraffic(teamE, eu.id, 1000, [{ type: "complained", n: 5 }], hoursAgo(72));
  // Counter-only volume (no rows) is ignored for this team: through the
  // counters it would dilute the rate far under the line.
  await bumpCounters(teamE, utcDay(NOW), { sent: 100_000 });
  expect(await regionCounterTotals(db, { now: NOW, days: 7 })).toEqual(
    new Map([["eu-west-1", { sent: 1000, hardBounced: 0, complained: 5 }]]),
  );
  const decisions = await evaluateRegionBreakers(db, { now: NOW });
  expect(decisions.map((d) => d.region)).toEqual(["eu-west-1"]);
  expect(decisions[0]).toMatchObject({
    trip: true,
    reason: { metric: "complaint", windowHours: 168, sent: 1000, events: 5 },
  });
  expect(decisions[0]?.contributors.map((c) => [c.teamId, c.complained])).toEqual([[teamE, 5]]);
});
