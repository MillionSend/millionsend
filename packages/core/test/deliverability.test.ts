import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  broadcastSendSpacingMs,
  evaluateDeliverability,
  fetchDeliverabilityHealth,
  MIN_GUARDRAIL_VOLUME,
  THROTTLED_BROADCAST_RATE_PER_SECOND,
} from "../src/deliverability.js";
import { DAY_MS, utcDay } from "../src/utc-day.js";

describe("evaluateDeliverability", () => {
  it("computes rates and stays ok when both metrics are clean", () => {
    const r = evaluateDeliverability({ sent: 10_000, bounced: 100, complained: 0 });
    expect(r.bounceRate).toBeCloseTo(0.01);
    expect(r.complaintRate).toBe(0);
    expect(r.status).toBe("ok");
    expect(r.reasons).toEqual([]);
  });

  it("stays ok just under the warning line", () => {
    // 399/10000 = 3.99% < 4% WARN
    const r = evaluateDeliverability({ sent: 10_000, bounced: 399, complained: 0 });
    expect(r.status).toBe("ok");
    expect(r.reasons).toEqual([]);
  });

  it("warns at exactly the warning line", () => {
    // 400/10000 = 4.00% == WARN_BOUNCE_RATE
    const r = evaluateDeliverability({ sent: 10_000, bounced: 400, complained: 0 });
    expect(r.status).toBe("warning");
    expect(r.reasons).toEqual([{ metric: "bounce", rate: 0.04, tier: "warning" }]);
  });

  it("warns for a bounce rate between WARN and PAUSE", () => {
    // 450/10000 = 4.5% — over 4% WARN, under 5% PAUSE
    const r = evaluateDeliverability({ sent: 10_000, bounced: 450, complained: 0 });
    expect(r.status).toBe("warning");
    expect(r.reasons).toEqual([{ metric: "bounce", rate: 0.045, tier: "warning" }]);
  });

  it("pauses at exactly the pause line", () => {
    // 500/10000 = 5.00% == PAUSE_BOUNCE_RATE
    const r = evaluateDeliverability({ sent: 10_000, bounced: 500, complained: 0 });
    expect(r.status).toBe("paused");
    expect(r.reasons).toEqual([{ metric: "bounce", rate: 0.05, tier: "paused" }]);
  });

  it("reports two reasons and pauses when both metrics are over PAUSE", () => {
    // bounce 6%, complaint 0.2%
    const r = evaluateDeliverability({ sent: 10_000, bounced: 600, complained: 20 });
    expect(r.status).toBe("paused");
    expect(r.reasons).toEqual([
      { metric: "bounce", rate: 0.06, tier: "paused" },
      { metric: "complaint", rate: 0.002, tier: "paused" },
    ]);
  });

  it("mixes a paused bounce with a warning complaint, overall paused", () => {
    // bounce 6% (paused), complaint 0.05% (>=0.01% WARN, <0.1% PAUSE)
    const r = evaluateDeliverability({ sent: 10_000, bounced: 600, complained: 5 });
    expect(r.status).toBe("paused");
    expect(r.reasons).toEqual([
      { metric: "bounce", rate: 0.06, tier: "paused" },
      { metric: "complaint", rate: 0.0005, tier: "warning" },
    ]);
  });

  it("never fires a tier below the volume floor even at 100% bounce", () => {
    const r = evaluateDeliverability({
      sent: MIN_GUARDRAIL_VOLUME - 1,
      bounced: MIN_GUARDRAIL_VOLUME - 1,
      complained: 0,
    });
    expect(r.bounceRate).toBe(1);
    expect(r.status).toBe("ok");
    expect(r.reasons).toEqual([]);
  });

  it("crosses into a decision exactly at the volume floor", () => {
    const r = evaluateDeliverability({
      sent: MIN_GUARDRAIL_VOLUME,
      bounced: MIN_GUARDRAIL_VOLUME,
      complained: 0,
    });
    expect(r.status).toBe("paused");
    expect(r.reasons).toEqual([{ metric: "bounce", rate: 1, tier: "paused" }]);
  });

  it("is zero-send safe (no divide-by-zero)", () => {
    const r = evaluateDeliverability({ sent: 0, bounced: 0, complained: 0 });
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

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(() => close());

  it("sums only rows inside the trailing window and pauses on the windowed rate", async () => {
    const teamId = await createTeam(db, "deliverability-window");
    const now = new Date("2026-08-14T12:00:00.000Z");
    const nowMs = now.getTime();

    // 7-day trailing window (GUARDRAIL default): since = today - 6 days.
    const inEdge = utcDay(nowMs - 6 * DAY_MS); // oldest in-window day
    const outEdge = utcDay(nowMs - 7 * DAY_MS); // just outside the window

    await db.insert(schema.usageCounters).values([
      // In window: 10_000 sent, 600 bounced (6%) → paused on its own.
      { teamId, day: utcDay(nowMs), accepted: 5_000, bounced: 300, complained: 0 },
      { teamId, day: inEdge, accepted: 5_000, bounced: 300, complained: 0 },
      // Out of window: huge clean volume that would dilute the rate to safe if counted.
      { teamId, day: outEdge, accepted: 1_000_000, bounced: 0, complained: 0 },
    ]);

    const health = await fetchDeliverabilityHealth(db, teamId, { now });
    expect(health.sent).toBe(10_000);
    expect(health.windowDays).toBe(7);
    expect(health.bounceRate).toBeCloseTo(0.06);
    expect(health.status).toBe("paused");
    expect(health.reasons).toEqual([{ metric: "bounce", rate: 0.06, tier: "paused" }]);
  });

  it("returns ok with zero rates for a team that has never sent", async () => {
    const teamId = await createTeam(db, "deliverability-empty");
    const health = await fetchDeliverabilityHealth(db, teamId, {
      now: new Date("2026-08-14T12:00:00.000Z"),
    });
    expect(health).toEqual({
      sent: 0,
      windowDays: 7,
      bounceRate: 0,
      complaintRate: 0,
      status: "ok",
      reasons: [],
    });
  });
});
