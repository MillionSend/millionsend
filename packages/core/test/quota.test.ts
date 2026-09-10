import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  quotaRoom,
  readPeriodUsage,
  releasePeriodQuota,
  reserveDailyQuota,
  reservePeriodQuota,
  reserveQuota,
} from "../src/quota.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db);
});
afterAll(() => close());

const DAY = "2026-08-14";

const acceptedOn = async (team: string, day: string) => {
  const [row] = await db
    .select({ accepted: schema.usageCounters.accepted })
    .from(schema.usageCounters)
    .where(and(eq(schema.usageCounters.teamId, team), eq(schema.usageCounters.day, day)));
  return row?.accepted ?? 0;
};

describe("reserveDailyQuota", () => {
  it("accumulates reservations up to exactly the limit", async () => {
    const first = await reserveDailyQuota(db, { teamId, count: 60, limit: 100, day: DAY });
    expect(first).toEqual({ reserved: true, accepted: 60, ceiling: 150 });
    const second = await reserveDailyQuota(db, { teamId, count: 40, limit: 100, day: DAY });
    expect(second).toEqual({ reserved: true, accepted: 100, ceiling: 150 });
    // The hourly mirror for the Metrics chart: a day-only reservation lands at that day's noon.
    const hours = await db
      .select({
        hour: schema.usageCountersHourly.hour,
        accepted: schema.usageCountersHourly.accepted,
      })
      .from(schema.usageCountersHourly)
      .where(eq(schema.usageCountersHourly.teamId, teamId));
    expect(hours).toEqual([{ hour: new Date(`${DAY}T12:00:00Z`), accepted: 100 }]);
  });

  it("rejects the reservation that would cross the tolerant ceiling, leaving the counter intact", async () => {
    // 50% past the nominal limit still passes; the request that would cross
    // the ceiling is refused without touching the counter.
    const over = await reserveDailyQuota(db, { teamId, count: 51, limit: 100, day: DAY });
    expect(over).toEqual({ reserved: false, accepted: 100, ceiling: 150 });
    const within = await reserveDailyQuota(db, { teamId, count: 50, limit: 100, day: DAY });
    expect(within).toEqual({ reserved: true, accepted: 150, ceiling: 150 });
    const past = await reserveDailyQuota(db, { teamId, count: 1, limit: 100, day: DAY });
    expect(past).toEqual({ reserved: false, accepted: 150, ceiling: 150 });
  });

  it("rejects a first-of-day reservation larger than the limit without creating drift", async () => {
    const team2 = await createTeam(db, "acme-2");
    const result = await reserveDailyQuota(db, { teamId: team2, count: 500, limit: 100, day: DAY });
    expect(result).toEqual({ reserved: false, accepted: 0, ceiling: 150 });
    const after = await reserveDailyQuota(db, { teamId: team2, count: 100, limit: 100, day: DAY });
    expect(after).toEqual({ reserved: true, accepted: 100, ceiling: 150 });
  });

  it("records but never rejects when limit is null (unlimited)", async () => {
    const team3 = await createTeam(db, "acme-3");
    const big = await reserveDailyQuota(db, {
      teamId: team3,
      count: 10_000,
      limit: null,
      day: DAY,
    });
    expect(big).toEqual({ reserved: true, accepted: 10_000, ceiling: null });
  });

  it("keys counters by day", async () => {
    const nextDay = await reserveDailyQuota(db, {
      teamId,
      count: 5,
      limit: 100,
      day: "2026-08-15",
    });
    expect(nextDay).toEqual({ reserved: true, accepted: 5, ceiling: 150 });
  });
});

const PERIOD = new Date("2026-08-01T00:00:00Z");
const NEXT_PERIOD = new Date("2026-09-01T00:00:00Z");

describe("reservePeriodQuota", () => {
  let team: string;
  beforeAll(async () => {
    team = await createTeam(db, "monthly");
  });
  const reserve = (count: number, overage = false, periodStart = PERIOD) =>
    reservePeriodQuota(db, { teamId: team, count, included: 100, periodStart, overage, day: DAY });

  it("accumulates to exactly the included volume and bumps the daily counters alongside", async () => {
    expect(await reserve(60)).toEqual({ reserved: true, accepted: 60, ceiling: 100 });
    expect(await reserve(40)).toEqual({ reserved: true, accepted: 100, ceiling: 100 });
    expect(await acceptedOn(team, DAY)).toBe(100);
  });

  it("refuses the reservation crossing the included volume with overage off, leaving the counter intact", async () => {
    expect(await reserve(1)).toEqual({ reserved: false, accepted: 100, ceiling: 100 });
    expect(await readPeriodUsage(db, team, PERIOD)).toEqual({ accepted: 100, reportedOverage: 0 });
    expect(await acceptedOn(team, DAY)).toBe(100);
  });

  it("refuses a first reservation larger than the included volume without creating a row", async () => {
    const fresh = await createTeam(db, "monthly-fresh");
    const result = await reservePeriodQuota(db, {
      teamId: fresh,
      count: 500,
      included: 100,
      periodStart: PERIOD,
      overage: false,
    });
    expect(result).toEqual({ reserved: false, accepted: 0, ceiling: 100 });
    expect(await readPeriodUsage(db, fresh, PERIOD)).toEqual({ accepted: 0, reportedOverage: 0 });
  });

  it("records past the included volume with overage on, under the hard cap", async () => {
    expect(await reserve(50, true)).toEqual({ reserved: true, accepted: 150, ceiling: 500 });
    expect(await acceptedOn(team, DAY)).toBe(150);
  });

  it("accepts up to exactly the hard cap with overage on, then refuses, leaving the counter intact", async () => {
    const capped = await createTeam(db, "monthly-capped");
    const reserveCapped = (count: number) =>
      reservePeriodQuota(db, {
        teamId: capped,
        count,
        included: 100,
        periodStart: PERIOD,
        overage: true,
        day: DAY,
      });
    expect(await reserveCapped(500)).toEqual({ reserved: true, accepted: 500, ceiling: 500 });
    expect(await reserveCapped(1)).toEqual({ reserved: false, accepted: 500, ceiling: 500 });
    expect(await readPeriodUsage(db, capped, PERIOD)).toEqual({
      accepted: 500,
      reportedOverage: 0,
    });
    expect(await acceptedOn(capped, DAY)).toBe(500);
  });

  it("keys rows by period start", async () => {
    expect(await reserve(5, false, NEXT_PERIOD)).toEqual({
      reserved: true,
      accepted: 5,
      ceiling: 100,
    });
    expect(await readPeriodUsage(db, team, PERIOD)).toEqual({ accepted: 150, reportedOverage: 0 });
  });

  it("releases floor at zero on both the period and the day", async () => {
    const t = await createTeam(db, "monthly-release");
    await reservePeriodQuota(db, {
      teamId: t,
      count: 50,
      included: 100,
      periodStart: PERIOD,
      overage: false,
      day: DAY,
    });
    await releasePeriodQuota(db, { teamId: t, count: 500, periodStart: PERIOD, day: DAY });
    expect(await readPeriodUsage(db, t, PERIOD)).toEqual({ accepted: 0, reportedOverage: 0 });
    expect(await acceptedOn(t, DAY)).toBe(0);
  });
});

describe("reserveQuota", () => {
  it("routes a daily quota to the day counter, a monthly one to the period row, and none to an uncapped day", async () => {
    const t = await createTeam(db, "routed");
    expect(
      await reserveQuota(db, {
        teamId: t,
        count: 100,
        quota: { kind: "day", plan: "free", limit: 100 },
        day: DAY,
      }),
    ).toEqual({ reserved: true, accepted: 100, ceiling: 150 });
    expect(
      await reserveQuota(db, {
        teamId: t,
        count: 7,
        quota: {
          kind: "month",
          plan: "pro",
          included: 100,
          periodStart: PERIOD,
          periodEnd: NEXT_PERIOD,
          overage: false,
          overageCentsPer1k: 30,
        },
        day: DAY,
      }),
    ).toEqual({ reserved: true, accepted: 7, ceiling: 100 });
    expect(await readPeriodUsage(db, t, PERIOD)).toEqual({ accepted: 7, reportedOverage: 0 });
    expect(
      await reserveQuota(db, { teamId: t, count: 1_000, quota: { kind: "none" }, day: DAY }),
    ).toEqual({ reserved: true, accepted: 1_107, ceiling: null });
  });
});

describe("quotaRoom", () => {
  it("is what is left under the ceiling, never negative, null without a ceiling", () => {
    expect(quotaRoom({ reserved: true, accepted: 40, ceiling: 100 })).toBe(60);
    expect(quotaRoom({ reserved: false, accepted: 150, ceiling: 100 })).toBe(0);
    expect(quotaRoom({ reserved: true, accepted: 5_000, ceiling: null })).toBeNull();
  });
});
