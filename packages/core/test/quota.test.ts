import type { Db } from "@millionsend/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reserveDailyQuota } from "../src/quota.js";
import { createTeam, createTestDb } from "./helpers/test-db.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db);
});
afterAll(() => close());

const DAY = "2026-08-14";

describe("reserveDailyQuota", () => {
  it("accumulates reservations up to exactly the limit", async () => {
    const first = await reserveDailyQuota(db, { teamId, count: 60, limit: 100, day: DAY });
    expect(first).toEqual({ reserved: true, acceptedToday: 60 });
    const second = await reserveDailyQuota(db, { teamId, count: 40, limit: 100, day: DAY });
    expect(second).toEqual({ reserved: true, acceptedToday: 100 });
  });

  it("rejects the reservation that would cross the limit, leaving the counter intact", async () => {
    const over = await reserveDailyQuota(db, { teamId, count: 1, limit: 100, day: DAY });
    expect(over).toEqual({ reserved: false, acceptedToday: 100 });
  });

  it("rejects a first-of-day reservation larger than the limit without creating drift", async () => {
    const team2 = await createTeam(db, "acme-2");
    const result = await reserveDailyQuota(db, { teamId: team2, count: 500, limit: 100, day: DAY });
    expect(result).toEqual({ reserved: false, acceptedToday: 0 });
    const after = await reserveDailyQuota(db, { teamId: team2, count: 100, limit: 100, day: DAY });
    expect(after).toEqual({ reserved: true, acceptedToday: 100 });
  });

  it("records but never rejects when limit is null (unlimited)", async () => {
    const team3 = await createTeam(db, "acme-3");
    const big = await reserveDailyQuota(db, {
      teamId: team3,
      count: 10_000,
      limit: null,
      day: DAY,
    });
    expect(big).toEqual({ reserved: true, acceptedToday: 10_000 });
  });

  it("keys counters by day", async () => {
    const nextDay = await reserveDailyQuota(db, {
      teamId,
      count: 5,
      limit: 100,
      day: "2026-08-15",
    });
    expect(nextDay).toEqual({ reserved: true, acceptedToday: 5 });
  });
});
