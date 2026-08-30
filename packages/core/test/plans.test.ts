import { describe, expect, it } from "vitest";
import { effectivePlan, PLAN_GRACE_DAYS } from "../src/plans.js";
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
