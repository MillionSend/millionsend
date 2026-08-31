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
    opened: number;
    clicked: number;
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
      opened: 0,
      clicked: 0,
    });
    // Days without a counter row come back as zeros.
    expect(result.days[13]).toEqual({
      day: utcDay(1),
      accepted: 0,
      sent: 0,
      delivered: 0,
      bounced: 0,
      complained: 0,
      opened: 0,
      clicked: 0,
    });
    expect(result.totals).toEqual({
      accepted: 15,
      sent: 14,
      delivered: 12,
      bounced: 1,
      complained: 1,
      opened: 0,
      clicked: 0,
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
      opened: 0,
      clicked: 0,
    });
    expect(result.allTimeDelivered).toBe(2);
  });

  it("returns opened and clicked per day and in the window totals", async () => {
    const teamId = await createTeam(db, "acme");
    await insertCounter(teamId, utcDay(0), { delivered: 10, opened: 6, clicked: 2 });
    await insertCounter(teamId, utcDay(2), { delivered: 4, opened: 1, clicked: 1 });

    const result = await callerFor(teamId).metrics.window();

    expect(result.days[14]).toMatchObject({ day: utcDay(0), opened: 6, clicked: 2 });
    expect(result.days[12]).toMatchObject({ day: utcDay(2), opened: 1, clicked: 1 });
    expect(result.totals.opened).toBe(7);
    expect(result.totals.clicked).toBe(3);
    // Engagement rate the page renders: opened / delivered, clicked / delivered.
    expect(result.totals.opened / result.totals.delivered).toBeCloseTo(0.5);
    expect(result.totals.clicked / result.totals.delivered).toBeCloseTo(3 / 14);
  });
});

describe("metrics.health", () => {
  it("pauses when the window bounce rate crosses the SES enforcement line", async () => {
    const teamId = await createTeam(db, "acme");
    // 120/2000 = 6% > 5% pause line, above the 1000 volume floor.
    await insertCounter(teamId, utcDay(0), { sent: 2000, bounced: 120 });

    const result = await callerFor(teamId).metrics.health();

    expect(result.status).toBe("paused");
    expect(result.bounceRate).toBeCloseTo(0.06);
    expect(result.reasons).toContainEqual({ metric: "bounce", rate: 0.06, tier: "paused" });
    expect(result.thresholds).toEqual({
      warnBounce: 0.04,
      warnComplaint: 0.0001,
      pauseBounce: 0.05,
      pauseComplaint: 0.001,
    });
  });

  it("stays ok below the volume floor regardless of rate", async () => {
    const teamId = await createTeam(db, "acme");
    await insertCounter(teamId, utcDay(0), { sent: 100, bounced: 50 });

    const result = await callerFor(teamId).metrics.health();

    expect(result.status).toBe("ok");
    expect(result.reasons).toEqual([]);
  });
});

describe("metrics.accountScore", () => {
  it("withholds the outcome sub-score under the sends floor and reports the shape", async () => {
    const teamId = await createTeam(db, "acme");
    await db
      .insert(schema.usageCounters)
      .values({ teamId, day: utcDay(0), sent: 40, complained: 1, hardBounced: 2 });

    const result = await callerFor(teamId).metrics.accountScore();

    expect(result).toMatchObject({
      windowDays: 30,
      scoreVersion: 1,
      sent: 40,
      contentRecipients: 0,
      insufficientOutcomeData: true,
      outcomeScoreTenths: null,
      contentScoreTenths: null,
      scoreTenths: null,
      band: null,
      guardrailStatus: "ok",
    });
    expect(result.complaintRate).toBeCloseTo(1 / 40);
    expect(result.hardBounceRate).toBeCloseTo(2 / 40);
  });

  it("blends content and outcome into a banded headline once data suffices", async () => {
    const teamId = await createTeam(db, "acme");
    await db.insert(schema.usageCounters).values({ teamId, day: utcDay(0), sent: 1000 });
    const [email] = await db
      .insert(schema.emails)
      .values({
        teamId,
        from: "sender@acme.test",
        to: ["ada@example.com"],
        subject: "hello",
        sentAt: new Date(),
      })
      .returning({ id: schema.emails.id });
    if (!email) throw new Error("email insert failed");
    await db.insert(schema.emailInsights).values({
      teamId,
      emailId: email.id,
      marketing: false,
      checks: [],
      scoreTenths: 80,
      scoreVersion: 1,
    });

    const result = await callerFor(teamId).metrics.accountScore();

    expect(result.contentScoreTenths).toBe(80);
    expect(result.outcomeScoreTenths).toBe(100);
    // min(0.4 × 80 + 0.6 × 100, 100 + 15) = 92
    expect(result.scoreTenths).toBe(92);
    expect(result.band).toBe("excellent");
    expect(result.insufficientOutcomeData).toBe(false);
  });
});
