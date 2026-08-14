import { utcDay as coreUtcDay, DAY_MS } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCaller } from "@/server/routers";

function utcDay(offsetDays: number): string {
  return coreUtcDay(Date.now() - offsetDays * DAY_MS);
}

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});

afterEach(async () => {
  await close();
});

function callerFor(teamId: string) {
  return createCaller({
    db,
    session: { user: { id: "u1", email: "u1@example.com", name: "u1" } },
    teamId,
    role: "owner",
  });
}

async function insertCounter(
  teamId: string,
  day: string,
  counts: Partial<{
    accepted: number;
    sent: number;
    delivered: number;
    bounced: number;
    complained: number;
  }>,
): Promise<void> {
  await db.insert(schema.usageCounters).values({ teamId, day, ...counts });
}

describe("metrics.window", () => {
  it("zero-fills the default 15-day window, sums totals, excludes older rows", async () => {
    const teamId = await createTeam(db, "acme");
    await insertCounter(teamId, utcDay(0), { accepted: 10, sent: 9, delivered: 8, bounced: 1 });
    await insertCounter(teamId, utcDay(3), { accepted: 5, sent: 5, delivered: 4, complained: 1 });
    await insertCounter(teamId, utcDay(16), { accepted: 99, sent: 99, delivered: 99 });

    const result = await callerFor(teamId).metrics.window();

    expect(result.days).toHaveLength(15);
    expect(result.days[0]?.day).toBe(utcDay(14));
    expect(result.days[14]).toEqual({
      day: utcDay(0),
      accepted: 10,
      sent: 9,
      delivered: 8,
      bounced: 1,
      complained: 0,
    });
    // Days without a counter row come back as zeros.
    expect(result.days[13]).toEqual({
      day: utcDay(1),
      accepted: 0,
      sent: 0,
      delivered: 0,
      bounced: 0,
      complained: 0,
    });
    expect(result.totals).toEqual({
      accepted: 15,
      sent: 14,
      delivered: 12,
      bounced: 1,
      complained: 1,
    });
  });

  it("honors a custom window size", async () => {
    const teamId = await createTeam(db, "acme");
    await insertCounter(teamId, utcDay(6), { sent: 3, delivered: 3 });
    await insertCounter(teamId, utcDay(7), { sent: 4, delivered: 4 });

    const result = await callerFor(teamId).metrics.window({ days: 7 });

    expect(result.days).toHaveLength(7);
    expect(result.days[0]?.day).toBe(utcDay(6));
    expect(result.totals.sent).toBe(3);
  });

  it("sums all-time delivered across rows outside the window", async () => {
    const teamId = await createTeam(db, "acme");
    await insertCounter(teamId, utcDay(0), { delivered: 100 });
    await insertCounter(teamId, utcDay(40), { delivered: 250 });

    const result = await callerFor(teamId).metrics.window();

    expect(result.totals.delivered).toBe(100);
    expect(result.allTimeDelivered).toBe(350);
  });

  it("sums all-time delivered past int4 range without overflowing", async () => {
    const teamId = await createTeam(db, "acme");
    // Two near-max int4 rows push the SUM past 2^31 - 1.
    await insertCounter(teamId, utcDay(0), { delivered: 2_000_000_000 });
    await insertCounter(teamId, utcDay(1), { delivered: 2_000_000_000 });

    const result = await callerFor(teamId).metrics.window();

    expect(result.allTimeDelivered).toBe(4_000_000_000);
  });

  it("scopes both the window and the all-time sum to the caller's team", async () => {
    const teamA = await createTeam(db, "team-a");
    const teamB = await createTeam(db, "team-b");
    await insertCounter(teamA, utcDay(0), { sent: 2, delivered: 2 });
    await insertCounter(teamB, utcDay(0), { sent: 7, delivered: 7 });
    await insertCounter(teamB, utcDay(40), { delivered: 9 });

    const result = await callerFor(teamA).metrics.window();

    expect(result.totals).toEqual({
      accepted: 0,
      sent: 2,
      delivered: 2,
      bounced: 0,
      complained: 0,
    });
    expect(result.allTimeDelivered).toBe(2);
  });
});
