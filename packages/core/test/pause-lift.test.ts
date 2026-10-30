import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { asc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchDeliverabilityHealth } from "../src/deliverability.js";
import { MONITOR_SETTING_DEFAULTS } from "../src/monitor-settings.js";
import { liftDeliverabilityPause, pauseLiftStanding } from "../src/pause-lift.js";
import { DAY_MS, utcDay } from "../src/utc-day.js";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

const uc = schema.usageCounters;
const now = new Date("2026-08-14T12:00:00.000Z");
const monitorFlagRisk = MONITOR_SETTING_DEFAULTS.flagRisk;
const day = (daysAgo: number) => utcDay(now.getTime() - daysAgo * DAY_MS);
const lift = (teamId: string, flagRisk = monitorFlagRisk) =>
  liftDeliverabilityPause(db, {
    teamId,
    operatorUserId: "op-1",
    reference: "Ticket 1042",
    note: "A sign-up form let fake addresses through. It checks them now.",
    notified: true,
    monitorFlagRisk: flagRisk,
    now,
  });

/** A team paused on bounces: 20 of today's 200 sends hard bounced. */
async function pausedTeam(slug: string, opts: { poolOwnerId?: string } = {}): Promise<string> {
  const teamId = await createTeam(db, slug, opts);
  await db.insert(uc).values({ teamId, day: day(0), sent: 200, hardBounced: 20 });
  return teamId;
}

const countersOf = (teamId: string) =>
  db
    .select({
      day: uc.day,
      sent: uc.sent,
      hardBounced: uc.hardBounced,
      excludedSent: uc.excludedSent,
      excludedHardBounced: uc.excludedHardBounced,
    })
    .from(uc)
    .where(eq(uc.teamId, teamId))
    .orderBy(asc(uc.day));

describe("liftDeliverabilityPause", () => {
  it("leaves the pause window out of the bounce rate, audited, with a fresh notice episode", async () => {
    const teamId = await createTeam(db, "acme");
    await db.insert(uc).values([
      { teamId, day: day(0), sent: 200, hardBounced: 20 },
      { teamId, day: day(1), sent: 100, hardBounced: 0 },
      { teamId, day: day(3), sent: 100, hardBounced: 2 },
    ]);
    await db.insert(schema.teamFlags).values({
      teamId,
      reason: "guardrail",
      detail: { guardrail: "paused", metric: "hard_bounce", rate: 0.07 },
    });
    await db.insert(schema.teamNotifications).values([
      { teamId, kind: "deliverability", periodKey: "paused" },
      { teamId, kind: "quota", periodKey: day(0) },
    ]);
    const parked = { teamId, from: "hi@acme.example", subject: "Welcome" } as const;
    await db.insert(schema.emails).values([
      { ...parked, to: ["a@example.com"], latestStatus: "queued_quota" },
      { ...parked, to: ["b@example.com"], latestStatus: "queued_quota", parkReason: "warmup" },
    ]);
    expect((await fetchDeliverabilityHealth(db, teamId, { now })).status).toBe("paused");

    expect(await lift(teamId)).toEqual({ sent: 300, hardBounces: 20, parked: 1 });

    expect(await countersOf(teamId)).toEqual([
      { day: day(3), sent: 100, hardBounced: 2, excludedSent: 0, excludedHardBounced: 0 },
      { day: day(1), sent: 100, hardBounced: 0, excludedSent: 100, excludedHardBounced: 0 },
      { day: day(0), sent: 200, hardBounced: 20, excludedSent: 200, excludedHardBounced: 20 },
    ]);
    const health = await fetchDeliverabilityHealth(db, teamId, { now });
    expect(health.status).toBe("ok");
    expect(health.sent).toBe(400);
    expect(health.lifted).toEqual({ sent: 300, hardBounced: 20 });
    const audit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.teamId, teamId));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorId: "user:op-1",
      action: "team.sending_pause_lifted",
      target: `team:${teamId}`,
      createdAt: now,
    });
    expect(audit[0]?.data).toEqual({
      name: "acme",
      reference: "Ticket 1042",
      note: "A sign-up form let fake addresses through. It checks them now.",
      since: day(1),
      sent: 300,
      hardBounces: 20,
      notified: true,
    });
    const notices = await db
      .select({ kind: schema.teamNotifications.kind })
      .from(schema.teamNotifications)
      .where(eq(schema.teamNotifications.teamId, teamId));
    expect(notices).toEqual([{ kind: "quota" }]);
    // The cron's flag is the cron's to clear.
    const [flag] = await db
      .select({ status: schema.teamFlags.status })
      .from(schema.teamFlags)
      .where(eq(schema.teamFlags.teamId, teamId));
    expect(flag?.status).toBe("open");
  });

  it("refuses a second lift, and holds the cooldown once new bounces pause the team again", async () => {
    const teamId = await pausedTeam("acme-again");
    await lift(teamId);
    const counters = await countersOf(teamId);
    expect(await lift(teamId)).toEqual({ refusal: "not_paused" });
    expect(await countersOf(teamId)).toEqual(counters);

    // 12 hard bounces in the 150 sends after the lift: 8%, past the pause line.
    await db.update(uc).set({ sent: 350, hardBounced: 32 }).where(eq(uc.teamId, teamId));
    const standing = await pauseLiftStanding(db, teamId, { now, monitorFlagRisk });
    expect(standing.health.status).toBe("paused");
    expect(standing.refusal).toBe("cooldown");
    expect(standing.lastLiftAt).toEqual(now);
    expect(standing.nextLiftAt).toEqual(new Date("2026-09-14T00:00:00.000Z"));
  });

  it("refuses a suspended team, a Free pool's team, another open flag and the monitor's risk", async () => {
    const suspended = await pausedTeam("acme-suspended");
    await db
      .update(schema.teams)
      .set({ suspendedAt: now, suspensionReason: "manual" })
      .where(eq(schema.teams.id, suspended));
    const pooled = await pausedTeam("acme-pooled", { poolOwnerId: "u-1" });
    const branded = await pausedTeam("acme-branded");
    await db
      .insert(schema.teamFlags)
      .values({ teamId: branded, reason: "brand", detail: { brand: "Example" } });
    const monitored = await pausedTeam("acme-monitored");
    // Settled verdicts over the flag line: the risk reads about 0.73.
    await db.insert(schema.teamMonitor).values({
      teamId: monitored,
      firstSendAt: new Date(now.getTime() - 90 * DAY_MS),
      riskNum: 9,
      riskDen: 10,
      riskUpdatedAt: now,
    });

    expect(await lift(suspended)).toEqual({ refusal: "suspended" });
    expect(await lift(pooled)).toEqual({ refusal: "free" });
    expect(await lift(branded)).toEqual({ refusal: "flagged" });
    expect(await lift(monitored)).toEqual({ refusal: "monitor" });
    const audit = await db
      .select()
      .from(schema.auditLog)
      .where(inArray(schema.auditLog.teamId, [suspended, pooled, branded, monitored]));
    expect(audit).toEqual([]);
    // With the judge off there is no flag line to be over.
    expect(await lift(monitored, Number.POSITIVE_INFINITY)).toMatchObject({ hardBounces: 20 });
  });
});
