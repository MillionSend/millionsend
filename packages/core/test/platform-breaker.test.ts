import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  applyRegionBreakers,
  evaluateRegionBreakers,
  pausedRegions,
  regionPause,
} from "../src/platform-breaker.js";

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

/** `sent` emails on the domain, the first `events` of them carrying one SES event each. */
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
  await db.delete(schema.emailEvents);
  await db.delete(schema.emails);
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
  await db.delete(schema.emailEvents);
  await db.delete(schema.emails);
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
  await db.delete(schema.emailEvents);
  await db.delete(schema.emails);
  const decisions = await evaluateRegionBreakers(db, { now: NOW });
  expect(decisions.find((d) => d.region === "eu-west-1")).toMatchObject({ trip: false });
  expect(await applyRegionBreakers(db, decisions, NOW)).toMatchObject({ resumed: ["eu-west-1"] });
  expect((await pausedRegions(db)).map((r) => r.region)).not.toContain("eu-west-1");
});

it("hard bounces still count after the retention purge strips event payloads", async () => {
  await db.delete(schema.emailEvents);
  await db.delete(schema.emails);
  await db.delete(schema.regionBreakers);
  const [dom] = await db.select().from(schema.domains).where(eq(schema.domains.teamId, teamC));
  if (!dom) throw new Error("no domain");
  await seedTraffic(
    teamC,
    dom.id,
    1000,
    [{ type: "bounced", bounceType: "Permanent", n: 45 }],
    hoursAgo(72),
  );
  await db.update(schema.emailEvents).set({ data: null });
  const decisions = await evaluateRegionBreakers(db, { now: NOW });
  expect(decisions.find((d) => d.region === "us-east-1")).toMatchObject({
    trip: true,
    reason: { metric: "bounce", windowHours: 168 },
  });
});
