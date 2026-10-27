import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  broadcastSendSpacingMs,
  evaluateDeliverability,
  fetchDeliverabilityHealth,
  GUARDRAIL_WINDOW_DAYS,
  MIN_GUARDRAIL_VOLUME,
  MIN_PAUSE_COMPLAINTS,
  MIN_PAUSE_HARD_BOUNCES,
  PAUSE_WINDOW_DAYS,
  THROTTLED_BROADCAST_RATE_PER_SECOND,
  type WindowCounts,
} from "../src/deliverability.js";
import { DAY_MS, utcDay } from "../src/utc-day.js";

/** Every send could draw a complaint unless `complaintSent` says otherwise. */
const counts = (
  sent: number,
  hardBounced = 0,
  complained = 0,
  complaintSent = sent,
): WindowCounts => ({ sent, complaintSent, hardBounced, complained });
/** The same counts in both windows: everything happened today. */
const today = (sent: number, hardBounced = 0, complained = 0, complaintSent = sent) => ({
  warn: counts(sent, hardBounced, complained, complaintSent),
  pause: counts(sent, hardBounced, complained, complaintSent),
});

describe("evaluateDeliverability", () => {
  it("computes rates and stays ok when both metrics are clean", () => {
    const r = evaluateDeliverability(today(10_000, 100));
    expect(r.bounceRate).toBeCloseTo(0.01);
    expect(r.complaintRate).toBe(0);
    expect(r.status).toBe("ok");
    expect(r.reasons).toEqual([]);
  });

  it("stays ok just under the warning line", () => {
    // 399/10000 = 3.99% < 4% WARN
    expect(evaluateDeliverability(today(10_000, 399)).status).toBe("ok");
  });

  it("warns at exactly the warning line, naming the warning window", () => {
    // 400/10000 = 4.00% == WARN_BOUNCE_RATE
    const r = evaluateDeliverability(today(10_000, 400));
    expect(r.status).toBe("warning");
    expect(r.reasons).toEqual([
      { metric: "bounce", rate: 0.04, tier: "warning", windowDays: GUARDRAIL_WINDOW_DAYS },
    ]);
  });

  it("pauses at exactly the pause line, naming the pause window", () => {
    // 500/10000 = 5.00% == PAUSE_BOUNCE_RATE, 500 >= MIN_PAUSE_HARD_BOUNCES
    const r = evaluateDeliverability(today(10_000, 500));
    expect(r.status).toBe("paused");
    expect(r.reasons).toEqual([
      { metric: "bounce", rate: 0.05, tier: "paused", windowDays: PAUSE_WINDOW_DAYS },
    ]);
  });

  it("reports two reasons and pauses when both metrics are over PAUSE", () => {
    const r = evaluateDeliverability(today(10_000, 600, 20));
    expect(r.status).toBe("paused");
    expect(r.reasons).toEqual([
      { metric: "bounce", rate: 0.06, tier: "paused", windowDays: PAUSE_WINDOW_DAYS },
      { metric: "complaint", rate: 0.002, tier: "paused", windowDays: PAUSE_WINDOW_DAYS },
    ]);
  });

  it("a single complaint never warns, however small the week", () => {
    // 1 in 1,000 is 0.1%, twice the warning line, but one event is not a pattern.
    expect(evaluateDeliverability(today(1_000, 0, 1)).status).toBe("ok");
    // Two complaints in 4,000 (0.05%) are.
    expect(evaluateDeliverability(today(4_000, 0, 2)).status).toBe("warning");
  });

  it("mixes a paused bounce with a warning complaint, overall paused", () => {
    // bounce 6% (paused), complaint 0.05% (>= 0.05% WARN with 5 complaints, < 0.1% PAUSE)
    const r = evaluateDeliverability(today(10_000, 600, 5));
    expect(r.status).toBe("paused");
    expect(r.reasons).toEqual([
      { metric: "bounce", rate: 0.06, tier: "paused", windowDays: PAUSE_WINDOW_DAYS },
      { metric: "complaint", rate: 0.0005, tier: "warning", windowDays: GUARDRAIL_WINDOW_DAYS },
    ]);
  });

  it("never fires a tier below the volume floor even at 100% bounce", () => {
    const r = evaluateDeliverability(today(MIN_GUARDRAIL_VOLUME - 1, MIN_GUARDRAIL_VOLUME - 1));
    expect(r.bounceRate).toBe(1);
    expect(r.status).toBe("ok");
    expect(r.reasons).toEqual([]);
  });

  it("crosses into a decision exactly at the volume floor", () => {
    const r = evaluateDeliverability(today(MIN_GUARDRAIL_VOLUME, MIN_GUARDRAIL_VOLUME));
    expect(r.status).toBe("paused");
    expect(r.reasons).toEqual([
      { metric: "bounce", rate: 1, tier: "paused", windowDays: PAUSE_WINDOW_DAYS },
    ]);
  });

  it("two complaints at 150 sends is a warning, not a pause; one alone is nothing", () => {
    expect(evaluateDeliverability(today(150, 0, 1)).status).toBe("ok");
    // 1.33% is far over the 0.1% line, but 2 < MIN_PAUSE_COMPLAINTS.
    const r = evaluateDeliverability(today(150, 0, 2));
    expect(r.status).toBe("warning");
    expect(r.reasons).toEqual([
      { metric: "complaint", rate: 2 / 150, tier: "warning", windowDays: GUARDRAIL_WINDOW_DAYS },
    ]);
  });

  it("three complaints at 200 sends pauses", () => {
    const r = evaluateDeliverability(today(200, 0, MIN_PAUSE_COMPLAINTS));
    expect(r.status).toBe("paused");
    expect(r.reasons).toEqual([
      { metric: "complaint", rate: 0.015, tier: "paused", windowDays: PAUSE_WINDOW_DAYS },
    ]);
  });

  it("a pause-line rate without the minimum event count only warns", () => {
    // 2/2000 = exactly 0.1%, but 2 < 3 complaints.
    expect(evaluateDeliverability(today(2000, 0, 2)).status).toBe("warning");
    // 6/100 = 6% >= 5%, but 6 < 10 hard bounces.
    expect(evaluateDeliverability(today(100, MIN_PAUSE_HARD_BOUNCES - 4)).status).toBe("warning");
  });

  it("judges the pause on the short window and the warning on the long one", () => {
    // Long window 6% (over the pause line) but the short window is clean:
    // a warning, never a pause.
    const cooled = evaluateDeliverability({ warn: counts(10_000, 600), pause: counts(1000, 10) });
    expect(cooled.status).toBe("warning");
    expect(cooled.reasons).toEqual([
      { metric: "bounce", rate: 0.06, tier: "warning", windowDays: GUARDRAIL_WINDOW_DAYS },
    ]);
    // Long window 0.5% (clean) but the last two days are a 10% spike with
    // enough hard bounces: paused, and the reason reports the short window.
    const spiking = evaluateDeliverability({ warn: counts(10_000, 50), pause: counts(200, 20) });
    expect(spiking.status).toBe("paused");
    expect(spiking.bounceRate).toBeCloseTo(0.005);
    expect(spiking.reasons).toEqual([
      { metric: "bounce", rate: 0.1, tier: "paused", windowDays: PAUSE_WINDOW_DAYS },
    ]);
  });

  it("judges complaints over the sends that could draw one, floor included", () => {
    // 2 complaints in 10,000 sends is 0.02%, but 8,000 went where no one can
    // report: 0.1% of the 2,000 left.
    const r = evaluateDeliverability(today(10_000, 0, 2, 2_000));
    expect(r.complaintRate).toBe(0.001);
    expect(r.reasons).toEqual([
      { metric: "complaint", rate: 0.001, tier: "warning", windowDays: GUARDRAIL_WINDOW_DAYS },
    ]);
    // Five complaints under the floor of sends that could draw one, whatever the total.
    expect(evaluateDeliverability(today(10_000, 0, 5, MIN_GUARDRAIL_VOLUME - 1)).status).toBe("ok");
  });

  it("judges complaints from the first send when their floor is lifted, bounces keeping theirs", () => {
    expect(evaluateDeliverability(today(50, 0, 3)).status).toBe("ok");
    expect(evaluateDeliverability(today(50, 0, 1), MIN_GUARDRAIL_VOLUME, 0).status).toBe("ok");
    expect(evaluateDeliverability(today(50, 0, 2), MIN_GUARDRAIL_VOLUME, 0).reasons).toEqual([
      { metric: "complaint", rate: 0.04, tier: "warning", windowDays: GUARDRAIL_WINDOW_DAYS },
    ]);
    expect(evaluateDeliverability(today(50, 0, 3), MIN_GUARDRAIL_VOLUME, 0).reasons).toEqual([
      { metric: "complaint", rate: 0.06, tier: "paused", windowDays: PAUSE_WINDOW_DAYS },
    ]);
    expect(evaluateDeliverability(today(50, 50), MIN_GUARDRAIL_VOLUME, 0).status).toBe("ok");
  });

  it("is zero-send safe (no divide-by-zero)", () => {
    const r = evaluateDeliverability(today(0));
    expect(r.bounceRate).toBe(0);
    expect(r.complaintRate).toBe(0);
    expect(r.status).toBe("ok");
    expect(r.reasons).toEqual([]);
  });
});

describe("broadcastSendSpacingMs", () => {
  const spacing = Math.ceil(1000 / THROTTLED_BROADCAST_RATE_PER_SECOND);

  it("fans out at full rate (no spacing) when ok", () => {
    expect(broadcastSendSpacingMs("ok")).toBe(0);
  });

  it("drips at the throttled rate for warning and paused", () => {
    expect(broadcastSendSpacingMs("warning")).toBe(spacing);
    expect(broadcastSendSpacingMs("paused")).toBe(spacing);
  });
});

describe("fetchDeliverabilityHealth", () => {
  let db: Db;
  let close: () => Promise<void>;
  const now = new Date("2026-08-14T12:00:00.000Z");
  const nowMs = now.getTime();

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(() => close());

  it("sums both windows in one pass and pauses on the short one", async () => {
    const teamId = await createTeam(db, "deliverability-window");
    const inEdge = utcDay(nowMs - 6 * DAY_MS); // oldest day of the 7-day window
    const outEdge = utcDay(nowMs - 7 * DAY_MS); // just outside it

    await db.insert(schema.usageCounters).values([
      // Today: 300 hard bounces over 5000 sends (6%) — the pause window.
      { teamId, day: utcDay(nowMs), accepted: 6_000, sent: 5_000, bounced: 300, hardBounced: 300 },
      // Six days ago: clean volume that halves the 7-day rate.
      { teamId, day: inEdge, accepted: 6_000, sent: 5_000, bounced: 0, hardBounced: 0 },
      // Out of window: huge clean volume that would dilute everything if counted.
      { teamId, day: outEdge, accepted: 1_000_000, sent: 1_000_000, bounced: 0, hardBounced: 0 },
    ]);

    const health = await fetchDeliverabilityHealth(db, teamId, { now });
    expect(health.sent).toBe(10_000);
    expect(health.windowDays).toBe(GUARDRAIL_WINDOW_DAYS);
    expect(health.bounceRate).toBeCloseTo(0.03);
    expect(health.pause).toEqual({
      sent: 5_000,
      complaintSent: 5_000,
      hardBounced: 300,
      complained: 0,
      windowDays: PAUSE_WINDOW_DAYS,
    });
    expect(health.status).toBe("paused");
    expect(health.reasons).toEqual([
      { metric: "bounce", rate: 0.06, tier: "paused", windowDays: PAUSE_WINDOW_DAYS },
    ]);
  });

  it("ignores transient bounces", async () => {
    const teamId = await createTeam(db, "deliverability-transient");
    await db.insert(schema.usageCounters).values({
      teamId,
      day: utcDay(nowMs),
      sent: 200,
      bounced: 20,
      hardBounced: 0,
    });
    const health = await fetchDeliverabilityHealth(db, teamId, { now });
    expect(health.bounceRate).toBe(0);
    expect(health.status).toBe("ok");
  });

  it("counts yesterday toward the pause window but not the day before", async () => {
    const yesterday = await createTeam(db, "deliverability-yesterday");
    await db.insert(schema.usageCounters).values({
      teamId: yesterday,
      day: utcDay(nowMs - DAY_MS),
      sent: 200,
      bounced: 20,
      hardBounced: 20,
    });
    expect((await fetchDeliverabilityHealth(db, yesterday, { now })).status).toBe("paused");

    const older = await createTeam(db, "deliverability-two-days");
    await db.insert(schema.usageCounters).values({
      teamId: older,
      day: utcDay(nowMs - 2 * DAY_MS),
      sent: 200,
      bounced: 20,
      hardBounced: 20,
    });
    // Same 10% over 7 days, but the pause window is empty: warning only.
    const health = await fetchDeliverabilityHealth(db, older, { now });
    expect(health.status).toBe("warning");
    expect(health.pause.sent).toBe(0);
  });

  it("computes a Gmail-heavy team's complaint rate over the sends that could draw one", async () => {
    const teamId = await createTeam(db, "deliverability-gmail-heavy");
    // 3 complaints in 10,000 sends is 0.03%, under every line. 8,000 of them
    // went to Gmail, which never reports one: 0.15% of the 2,000 left.
    await db.insert(schema.usageCounters).values({
      teamId,
      day: utcDay(nowMs),
      sent: 10_000,
      sentNoFeedback: 8_000,
      complained: 3,
    });
    const health = await fetchDeliverabilityHealth(db, teamId, { now });
    expect(health.sent).toBe(10_000);
    expect(health.complaintSent).toBe(2_000);
    expect(health.complaintRate).toBe(0.0015);
    expect(health.pause).toEqual({
      sent: 10_000,
      complaintSent: 2_000,
      hardBounced: 0,
      complained: 3,
      windowDays: PAUSE_WINDOW_DAYS,
    });
    expect(health.status).toBe("paused");
    expect(health.reasons).toEqual([
      { metric: "complaint", rate: 0.0015, tier: "paused", windowDays: PAUSE_WINDOW_DAYS },
    ]);
  });

  it("judges a Free pool on its one record, whichever of its teams sent, and from the first complaint", async () => {
    const owner = "u-guardrail";
    const a = await createTeam(db, "pool-guardrail-a", { poolOwnerId: owner });
    const b = await createTeam(db, "pool-guardrail-b", { poolOwnerId: owner });
    const paid = await createTeam(db, "pool-guardrail-paid", { poolOwnerId: owner });
    await db.update(schema.teams).set({ plan: "starter" }).where(eq(schema.teams.id, paid));
    // b's own week is clean and large; the pool's record is what counts.
    await db
      .insert(schema.usageCounters)
      .values({ teamId: b, day: utcDay(nowMs), sent: 10_000, complained: 0 });
    await db.insert(schema.freePoolUsage).values({
      ownerId: owner,
      day: utcDay(nowMs),
      sent: 60,
      sentNoFeedback: 10,
      complained: 3,
    });
    for (const teamId of [a, b]) {
      const health = await fetchDeliverabilityHealth(db, teamId, { now });
      expect(health.complaintSent).toBe(50);
      expect(health.reasons).toEqual([
        { metric: "complaint", rate: 0.06, tier: "paused", windowDays: PAUSE_WINDOW_DAYS },
      ]);
    }
    // A paid team of the same creator stands alone.
    expect((await fetchDeliverabilityHealth(db, paid, { now })).status).toBe("ok");
  });

  it("keeps the volume floor for a Free pool's bounces, and for a team outside any pool", async () => {
    const owner = "u-guardrail-bounces";
    const pooled = await createTeam(db, "pool-guardrail-bounces", { poolOwnerId: owner });
    await db
      .insert(schema.freePoolUsage)
      .values({ ownerId: owner, day: utcDay(nowMs), sent: 60, hardBounced: 30 });
    expect((await fetchDeliverabilityHealth(db, pooled, { now })).status).toBe("ok");
    // Self-host never records a creator, and a paid plan never pools: both keep the floor.
    const unrecorded = await createTeam(db, "guardrail-unrecorded");
    const paid = await createTeam(db, "guardrail-paid", { poolOwnerId: owner });
    await db.update(schema.teams).set({ plan: "pro" }).where(eq(schema.teams.id, paid));
    for (const teamId of [unrecorded, paid]) {
      await db
        .insert(schema.usageCounters)
        .values({ teamId, day: utcDay(nowMs), sent: 60, complained: 3 });
      expect((await fetchDeliverabilityHealth(db, teamId, { now })).status).toBe("ok");
    }
  });

  it("returns ok with zero rates for a team that has never sent", async () => {
    const teamId = await createTeam(db, "deliverability-empty");
    expect(await fetchDeliverabilityHealth(db, teamId, { now })).toEqual({
      sent: 0,
      complaintSent: 0,
      windowDays: GUARDRAIL_WINDOW_DAYS,
      bounceRate: 0,
      complaintRate: 0,
      status: "ok",
      reasons: [],
      pause: {
        sent: 0,
        complaintSent: 0,
        hardBounced: 0,
        complained: 0,
        windowDays: PAUSE_WINDOW_DAYS,
      },
    });
  });
});
