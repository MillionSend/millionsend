import { describe, expect, it } from "vitest";
import {
  effectivePlan,
  formatVolume,
  monthlyCapacity,
  OVERAGE_HARD_CAP,
  PLAN_CONTACT_LIMIT,
  PLAN_GRACE_DAYS,
  PLAN_RUNGS,
  planLabel,
  type QuotaTeamRow,
  quotaPeriod,
  raisesQuota,
  type TeamQuota,
  teamQuota,
  teamRung,
} from "../src/plans.js";
import { DAY_MS } from "../src/utc-day.js";

describe("effectivePlan", () => {
  const now = new Date("2026-06-15T00:00:00Z");

  it("keeps a paid plan through the current period and its grace window", () => {
    expect(effectivePlan("pro", new Date(now.getTime() + DAY_MS), now)).toBe("pro");
    const graceEdge = new Date(now.getTime() - PLAN_GRACE_DAYS * DAY_MS);
    expect(effectivePlan("scale", graceEdge, now)).toBe("scale");
  });

  it("drops to free once the last period end is past the grace window", () => {
    const stale = new Date(now.getTime() - PLAN_GRACE_DAYS * DAY_MS - 1);
    expect(effectivePlan("pro", stale, now)).toBe("free");
    expect(effectivePlan("scale", stale, now)).toBe("free");
  });

  it("takes a plan with no period end at face value", () => {
    expect(effectivePlan("pro", null, now)).toBe("pro");
    expect(effectivePlan("free", new Date(0), now)).toBe("free");
  });
});

describe("PLAN_RUNGS", () => {
  it("is the eight-rung ladder, cheapest first", () => {
    expect(
      PLAN_RUNGS.map((r) => [
        r.key,
        r.plan,
        r.included,
        r.period,
        r.priceCents,
        r.overageCentsPer1k,
      ]),
    ).toEqual([
      ["free", "free", 100, "day", 0, null],
      ["starter", "starter", 1_500, "day", 900, null],
      ["pro_100k", "pro", 100_000, "month", 2_000, 30],
      ["pro_200k", "pro", 200_000, "month", 3_500, 30],
      ["scale_500k", "scale", 500_000, "month", 7_500, 25],
      ["scale_1m", "scale", 1_000_000, "month", 14_000, 20],
      ["scale_1_5m", "scale", 1_500_000, "month", 20_000, 18],
      ["scale_2_5m", "scale", 2_500_000, "month", 33_000, 16],
    ]);
  });
});

describe("PLAN_CONTACT_LIMIT", () => {
  it("caps contacts on Free only", () => {
    expect(PLAN_CONTACT_LIMIT).toEqual({ free: 1_000, starter: null, pro: null, scale: null });
  });
});

describe("teamRung", () => {
  it("finds the monthly rung by its included volume and falls back to the plan's first rung", () => {
    expect(teamRung("free", null).key).toBe("free");
    expect(teamRung("starter", null).key).toBe("starter");
    expect(teamRung("starter", 100_000).key).toBe("starter");
    expect(teamRung("pro", 200_000).key).toBe("pro_200k");
    expect(teamRung("pro", null).key).toBe("pro_100k");
    expect(teamRung("scale", 999).key).toBe("scale_500k");
    expect(teamRung("scale", 2_500_000).key).toBe("scale_2_5m");
  });
});

describe("formatVolume and planLabel", () => {
  it("prints volumes the way plan cards do", () => {
    expect([100, 1_500, 100_000, 1_000_000, 1_500_000, 2_500_000].map(formatVolume)).toEqual([
      "100",
      "1.5k",
      "100k",
      "1M",
      "1.5M",
      "2.5M",
    ]);
  });

  it("labels a monthly rung with its volume and a daily plan by name alone", () => {
    expect(planLabel("free", null)).toBe("Free");
    expect(planLabel("starter", null)).toBe("Starter");
    expect(planLabel("pro", 100_000)).toBe("Pro 100k");
    expect(planLabel("pro", null)).toBe("Pro 100k");
    expect(planLabel("scale", 2_500_000)).toBe("Scale 2.5M");
  });
});

const START = new Date("2026-09-03T10:00:00Z");
const END = new Date("2026-10-03T10:00:00Z");
const row = (over: Partial<QuotaTeamRow> = {}): QuotaTeamRow => ({
  plan: "pro",
  planQuota: 100_000,
  currentPeriodStart: START,
  currentPeriodEnd: END,
  overageEnabled: false,
  ...over,
});

describe("quotaPeriod", () => {
  it("is the Stripe period while it runs, and the one after it once it ended", () => {
    expect(quotaPeriod(row(), new Date("2026-09-20T00:00:00Z"))).toEqual({
      start: START,
      end: END,
    });
    expect(quotaPeriod(row(), END)).toEqual({
      start: END,
      end: new Date("2026-11-03T10:00:00Z"),
    });
  });

  it("runs a month from the start when no end is recorded, and on calendar months without either", () => {
    expect(quotaPeriod(row({ currentPeriodEnd: null }), new Date("2026-09-20T00:00:00Z"))).toEqual({
      start: START,
      end: new Date("2026-10-03T10:00:00Z"),
    });
    expect(
      quotaPeriod(
        row({ currentPeriodStart: null, currentPeriodEnd: null }),
        new Date("2026-09-20T15:00:00Z"),
      ),
    ).toEqual({
      start: new Date("2026-09-01T00:00:00Z"),
      end: new Date("2026-10-01T00:00:00Z"),
    });
  });
});

describe("teamQuota", () => {
  const now = new Date("2026-09-20T00:00:00Z");

  it("caps nothing off Cloud", () => {
    expect(teamQuota(row(), false, now)).toEqual({ kind: "none" });
  });

  it("caps daily plans by their rung's volume", () => {
    expect(teamQuota(row({ plan: "free", planQuota: null }), true, now)).toEqual({
      kind: "day",
      plan: "free",
      limit: 100,
    });
    expect(teamQuota(row({ plan: "starter", planQuota: null }), true, now)).toEqual({
      kind: "day",
      plan: "starter",
      limit: 1_500,
    });
  });

  it("caps monthly plans by the bought volume over the billing period, overage as the row flag says", () => {
    expect(teamQuota(row(), true, now)).toEqual({
      kind: "month",
      plan: "pro",
      included: 100_000,
      periodStart: START,
      periodEnd: END,
      overage: false,
      overageCentsPer1k: 30,
    });
    expect(teamQuota(row({ overageEnabled: true }), true, now)).toMatchObject({
      overage: true,
    });
    expect(
      teamQuota(row({ plan: "scale", planQuota: 1_500_000, overageEnabled: true }), true, now),
    ).toMatchObject({ included: 1_500_000, overageCentsPer1k: 18, overage: true });
    // A monthly row written before rungs existed sits on the plan's first rung.
    expect(teamQuota(row({ plan: "scale", planQuota: null }), true, now)).toMatchObject({
      included: 500_000,
    });
  });

  it("rolls the period forward when the recorded one has ended", () => {
    expect(teamQuota(row(), true, END)).toMatchObject({
      kind: "month",
      periodStart: END,
      periodEnd: new Date("2026-11-03T10:00:00Z"),
    });
  });

  it("limits a paid plan past its grace window as free, ignoring the bought volume", () => {
    const lapsed = new Date(END.getTime() + (PLAN_GRACE_DAYS + 1) * DAY_MS);
    expect(teamQuota(row(), true, lapsed)).toEqual({ kind: "day", plan: "free", limit: 100 });
    const inGrace = new Date(END.getTime() + PLAN_GRACE_DAYS * DAY_MS);
    expect(teamQuota(row(), true, inGrace)).toMatchObject({ kind: "month", plan: "pro" });
  });
});

describe("monthlyCapacity and raisesQuota", () => {
  const none: TeamQuota = { kind: "none" };
  const free: TeamQuota = { kind: "day", plan: "free", limit: 100 };
  const starter: TeamQuota = { kind: "day", plan: "starter", limit: 1_500 };
  const month = (included: number, overage = false): TeamQuota => ({
    kind: "month",
    plan: "pro",
    included,
    periodStart: START,
    periodEnd: END,
    overage,
    overageCentsPer1k: 30,
  });

  it("measures a quota in emails per month, unlimited only where nothing stops sends", () => {
    expect(monthlyCapacity(none)).toBe(Number.POSITIVE_INFINITY);
    expect(monthlyCapacity(free)).toBe(3_000);
    expect(monthlyCapacity(starter)).toBe(45_000);
    expect(monthlyCapacity(month(100_000))).toBe(100_000);
    // Overage on still stops at the hard cap, never an open-ended bill.
    expect(OVERAGE_HARD_CAP).toBe(5);
    expect(monthlyCapacity(month(100_000, true))).toBe(500_000);
  });

  it("is true only when the move lets more mail through", () => {
    expect(raisesQuota(free, starter)).toBe(true);
    expect(raisesQuota(starter, free)).toBe(false);
    expect(raisesQuota(starter, month(100_000))).toBe(true);
    expect(raisesQuota(month(100_000), month(200_000))).toBe(true);
    expect(raisesQuota(month(200_000), month(100_000))).toBe(false);
    expect(raisesQuota(month(100_000), month(100_000, true))).toBe(true);
    expect(raisesQuota(month(100_000), month(100_000))).toBe(false);
    expect(raisesQuota(month(2_500_000), none)).toBe(true);
    expect(raisesQuota(none, none)).toBe(false);
  });
});
