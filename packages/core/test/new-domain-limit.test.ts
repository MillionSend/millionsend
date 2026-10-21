import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { heldByNewDomainLimit } from "../src/domain-warmup.js";
import {
  newDomainLimitEta,
  newDomainLimitEtas,
  newDomainLimitStatus,
} from "../src/new-domain-limit.js";
import { DAY_MS } from "../src/utc-day.js";

const NOW = new Date("2026-10-20T18:00:00Z");
const MIDNIGHT = new Date("2026-10-21T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY_MS);

let db: Db;
let close: () => Promise<void>;
let seq = 0;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await db.insert(schema.instanceSettings).values({ id: 1, warmupEnabled: true });
});
afterAll(() => close());

async function newTeam(): Promise<string> {
  seq += 1;
  return createTeam(db, `limit-${seq}`);
}

async function newDomain(
  teamId: string,
  name: string,
  registeredAt: Date | null,
  over: Partial<typeof schema.domains.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(schema.domains)
    .values({ teamId, name, region: "us-east-1", status: "verified", registeredAt, ...over })
    .returning({ id: schema.domains.id });
  if (!row) throw new Error("domain insert failed");
  return row.id;
}

async function used(registrableDomain: string, accepted: number, day = "2026-10-20") {
  await db.insert(schema.domainWarmupUsage).values({ registrableDomain, day, accepted });
}

async function park(
  teamId: string,
  domainId: string,
  over: Partial<typeof schema.emails.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(schema.emails)
    .values({
      teamId,
      domainId,
      from: "hi@example.com",
      to: ["r@example.com"],
      subject: "s",
      latestStatus: "queued_quota",
      parkReason: "warmup",
      ...over,
    })
    .returning({ id: schema.emails.id });
  if (!row) throw new Error("email insert failed");
  return row.id;
}

describe("newDomainLimitStatus", () => {
  it("gives a young domain's day: cap, use, waiting, reset and the steps ahead", async () => {
    const teamId = await newTeam();
    const registered = daysAgo(3);
    const domainId = await newDomain(teamId, "mail.nova-status.example", registered);
    await used("nova-status.example", 300);
    await park(teamId, domainId);
    await park(teamId, domainId);
    expect(await newDomainLimitStatus(db, { teamId, now: NOW })).toEqual([
      {
        domainId,
        name: "mail.nova-status.example",
        cap: 300,
        used: 300,
        pool: null,
        waiting: 2,
        resetsAt: MIDNIGHT,
        registeredAt: registered,
        steps: [
          { from: NOW, cap: 300 },
          { from: new Date(registered.getTime() + 7 * DAY_MS), cap: 2000 },
          { from: new Date(registered.getTime() + 30 * DAY_MS), cap: null },
        ],
        fullAt: new Date(registered.getTime() + 30 * DAY_MS),
      },
    ]);
  });

  it("leaves out old, trusted, unverified and other teams' domains, and filters by id", async () => {
    const teamId = await newTeam();
    const young = await newDomain(teamId, "young-filter.example", daysAgo(2));
    await newDomain(teamId, "old-filter.example", daysAgo(400));
    await newDomain(teamId, "trusted-filter.example", daysAgo(2), { warmupTrustedAt: NOW });
    await newDomain(teamId, "pending-filter.example", daysAgo(2), { status: "pending" });
    const other = await newDomain(await newTeam(), "stranger-filter.example", daysAgo(2));
    const names = async (domainIds?: string[]) =>
      (
        await newDomainLimitStatus(db, { teamId, now: NOW, ...(domainIds ? { domainIds } : {}) })
      ).map((l) => l.name);
    expect(await names()).toEqual(["young-filter.example"]);
    expect(await names([young, other])).toEqual(["young-filter.example"]);
    expect(await names([])).toEqual([]);
    await db.update(schema.teams).set({ warmupTrustedAt: NOW }).where(eq(schema.teams.id, teamId));
    expect(await names()).toEqual([]);
  });

  it("shows the pool only when it binds more than one domain", async () => {
    const teamId = await newTeam();
    await newDomain(teamId, "first-pool.example", daysAgo(0.1));
    await newDomain(teamId, "second-pool.example", daysAgo(10));
    await db.insert(schema.teamWarmupUsage).values({ teamId, day: "2026-10-20", accepted: 150 });
    const status = await newDomainLimitStatus(db, { teamId, now: NOW });
    expect(status.map((l) => [l.name, l.cap, l.pool])).toEqual([
      ["first-pool.example", 100, { cap: 2000, used: 150, domains: 2 }],
      ["second-pool.example", 2000, { cap: 2000, used: 150, domains: 2 }],
    ]);
  });

  it("knows only today's cap for an unknown age", async () => {
    const teamId = await newTeam();
    await newDomain(teamId, "ageless.example", null, { ageSource: "unknown" });
    expect(await newDomainLimitStatus(db, { teamId, now: NOW })).toMatchObject([
      { name: "ageless.example", cap: 300, steps: [], fullAt: null, registeredAt: null },
    ]);
  });

  it("counts only what the new domain limit holds", async () => {
    const teamId = await newTeam();
    const fresh = await newDomain(teamId, "fresh-held.example", daysAgo(2));
    const ramped = await newDomain(teamId, "ramped-held.example", daysAgo(2));
    await db.insert(schema.domainWarmups).values({
      domainId: ramped,
      teamId,
      volume: 1500,
      startVolume: 1500,
      dailyTarget: 10_000,
    });
    const [broadcast] = await db
      .insert(schema.broadcasts)
      .values({ teamId, from: "news@ramped-held.example", subject: "s", status: "sending" })
      .returning({ id: schema.broadcasts.id });
    const broadcastId = broadcast?.id ?? null;
    await park(teamId, fresh);
    await park(teamId, fresh, { broadcastId });
    // The plan's wait, a silent hold, mail on its way: never the limit's.
    await park(teamId, fresh, { parkReason: null });
    for (const parkReason of [
      "review",
      "screening",
      "destination",
      "media",
      "recipient",
    ] as const) {
      await park(teamId, fresh, { parkReason });
    }
    await park(teamId, fresh, { latestStatus: "queued", parkReason: null });
    // A reputation warm-up holds its own broadcast copies, not the transactional mail.
    await park(teamId, ramped);
    await park(teamId, ramped, { broadcastId });
    const waiting = async () =>
      (await newDomainLimitStatus(db, { teamId, now: NOW })).map((l) => [l.name, l.waiting]);
    expect(await waiting()).toEqual([
      ["fresh-held.example", 2],
      ["ramped-held.example", 1],
    ]);
    await db
      .update(schema.domainWarmups)
      .set({ status: "off" })
      .where(eq(schema.domainWarmups.domainId, ramped));
    expect(await waiting()).toEqual([
      ["fresh-held.example", 2],
      ["ramped-held.example", 2],
    ]);
  });

  it("works as a column and inside an update, one definition for every surface", async () => {
    const teamId = await newTeam();
    const domainId = await newDomain(teamId, "predicate.example", daysAgo(2));
    const held = await park(teamId, domainId);
    const silent = await park(teamId, domainId, { parkReason: "screening" });
    const e = schema.emails;
    const rows = await db
      .select({ id: e.id, held: sql<boolean>`${heldByNewDomainLimit()}` })
      .from(e)
      .where(eq(e.teamId, teamId));
    expect(Object.fromEntries(rows.map((r) => [r.id, r.held]))).toEqual({
      [held]: true,
      [silent]: false,
    });
    const touched = await db
      .update(e)
      .set({ subject: "touched" })
      .where(and(eq(e.teamId, teamId), heldByNewDomainLimit()))
      .returning({ id: e.id });
    expect(touched.map((r) => r.id)).toEqual([held]);
  });
});

describe("newDomainLimitEta", () => {
  it("puts transactional mail first, then the oldest, and sends after the next midnight", async () => {
    const teamId = await newTeam();
    const domainId = await newDomain(teamId, "eta-order.example", daysAgo(3));
    await used("eta-order.example", 300);
    const [broadcast] = await db
      .insert(schema.broadcasts)
      .values({ teamId, from: "news@eta-order.example", subject: "s", status: "sending" })
      .returning({ id: schema.broadcasts.id });
    const at = (minutes: number) => new Date(NOW.getTime() - 60 * 60_000 + minutes * 60_000);
    const first = await park(teamId, domainId, { createdAt: at(0) });
    const copy = await park(teamId, domainId, {
      createdAt: at(1),
      broadcastId: broadcast?.id ?? null,
    });
    const second = await park(teamId, domainId, { createdAt: at(2) });
    const eta = (emailId: string) => newDomainLimitEta(db, { teamId, emailId, now: NOW });
    expect(await eta(first)).toEqual({ ahead: 0, sendsAfter: MIDNIGHT });
    expect(await eta(second)).toEqual({ ahead: 1, sendsAfter: MIDNIGHT });
    expect(await eta(copy)).toEqual({ ahead: 2, sendsAfter: MIDNIGHT });
  });

  it("walks the schedule day by day, counting recipients", async () => {
    const teamId = await newTeam();
    // Registered at 17:00 UTC: tomorrow's 00:00 is still day zero (100),
    // the day after is day one (300).
    const domainId = await newDomain(
      teamId,
      "eta-walk.example",
      new Date(NOW.getTime() - 3600_000),
    );
    await used("eta-walk.example", 100);
    const many = Array.from({ length: 50 }, (_, i) => `r${i}@example.com`);
    for (let i = 0; i < 3; i += 1) {
      await park(teamId, domainId, {
        to: many,
        createdAt: new Date(NOW.getTime() - (10 - i) * 60_000),
      });
    }
    const last = await park(teamId, domainId, { createdAt: NOW });
    expect(await newDomainLimitEta(db, { teamId, emailId: last, now: NOW })).toEqual({
      ahead: 3,
      sendsAfter: new Date(MIDNIGHT.getTime() + DAY_MS),
    });
  });

  it("answers now while today's room covers it", async () => {
    const teamId = await newTeam();
    const domainId = await newDomain(teamId, "eta-room.example", daysAgo(3));
    await used("eta-room.example", 120);
    const emailId = await park(teamId, domainId);
    expect(await newDomainLimitEta(db, { teamId, emailId, now: NOW })).toEqual({
      ahead: 0,
      sendsAfter: NOW,
    });
  });

  it("has nothing to say about mail the limit does not hold", async () => {
    const teamId = await newTeam();
    const domainId = await newDomain(teamId, "eta-none.example", daysAgo(3));
    const silent = await park(teamId, domainId, { parkReason: "review" });
    const plan = await park(teamId, domainId, { parkReason: null });
    const held = await park(teamId, domainId);
    for (const emailId of [silent, plan]) {
      expect(await newDomainLimitEta(db, { teamId, emailId, now: NOW })).toBeNull();
    }
    expect(
      await newDomainLimitEta(db, { teamId: await newTeam(), emailId: held, now: NOW }),
    ).toBeNull();
    await db
      .update(schema.domains)
      .set({ warmupTrustedAt: NOW })
      .where(eq(schema.domains.id, domainId));
    expect(await newDomainLimitEta(db, { teamId, emailId: held, now: NOW })).toBeNull();
  });
});

describe("newDomainLimitEtas", () => {
  it("answers many emails at once as it answers each, never before its schedule", async () => {
    const teamId = await newTeam();
    const domainId = await newDomain(teamId, "etas-many.example", daysAgo(3));
    const roomy = await newDomain(teamId, "etas-roomy.example", daysAgo(3));
    await used("etas-many.example", 300);
    const at = (minutes: number) => new Date(NOW.getTime() - 60 * 60_000 + minutes * 60_000);
    const inThreeDays = new Date(MIDNIGHT.getTime() + 3 * DAY_MS);
    const first = await park(teamId, domainId, { createdAt: at(0) });
    const scheduled = await park(teamId, domainId, { createdAt: at(1), scheduledAt: inThreeDays });
    const elsewhere = await park(teamId, roomy, { createdAt: at(2) });
    const silent = await park(teamId, domainId, { parkReason: "review" });
    const etas = await newDomainLimitEtas(db, {
      teamId,
      emailIds: [first, scheduled, elsewhere, silent],
      now: NOW,
    });
    expect([...etas.keys()].sort()).toEqual([first, scheduled, elsewhere].sort());
    expect(etas.get(first)).toMatchObject({ ahead: 0, sendsAfter: MIDNIGHT });
    expect(etas.get(first)?.limit).toMatchObject({ name: "etas-many.example", cap: 300 });
    expect(etas.get(scheduled)).toMatchObject({ ahead: 1, sendsAfter: inThreeDays });
    expect(etas.get(elsewhere)).toMatchObject({ ahead: 0, sendsAfter: NOW });
    for (const emailId of [first, scheduled, elsewhere]) {
      const eta = etas.get(emailId);
      expect(await newDomainLimitEta(db, { teamId, emailId, now: NOW })).toEqual({
        ahead: eta?.ahead,
        sendsAfter: eta?.sendsAfter,
      });
    }
    expect(await newDomainLimitEtas(db, { teamId, emailIds: [], now: NOW })).toEqual(new Map());
  });
});
