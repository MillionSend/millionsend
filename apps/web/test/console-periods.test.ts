import { describe, expect, it } from "vitest";
import {
  dayKeys,
  hourKeys,
  periodSchema,
  previousPeriod,
  resolvePeriod,
} from "../src/server/console/periods";

describe("resolvePeriod", () => {
  it("aligns the 24h window to the hour so its first bucket is kept", () => {
    const now = new Date("2026-09-15T14:37:12Z");
    const period = resolvePeriod("24h", now);
    expect(period.from.toISOString()).toBe("2026-09-14T14:00:00.000Z");
    expect(hourKeys(period.from, period.to)).toHaveLength(25);
  });

  it("rejects a date that does not exist", () => {
    expect(periodSchema.safeParse({ from: "2026-02-31", to: "2026-03-01" }).success).toBe(false);
    expect(periodSchema.safeParse({ from: "2026-02-28", to: "2026-03-01" }).success).toBe(true);
  });

  it("refuses a range that ends before it starts", () => {
    expect(() => resolvePeriod({ from: "2026-03-02", to: "2026-03-01" })).toThrow(/invalid_period/);
  });
});

describe("previousPeriod", () => {
  it("is the same number of whole days, ending where the period starts", () => {
    const now = new Date("2026-09-15T14:37:12Z");
    const period = resolvePeriod("7d", now);
    const before = previousPeriod(period);
    expect(dayKeys(period.from, period.to)).toHaveLength(7);
    expect(dayKeys(before.from, before.to)).toHaveLength(7);
    expect(before.to.getTime()).toBe(period.from.getTime() - 1);
  });

  it("is one day for an hourly window", () => {
    const period = resolvePeriod("24h", new Date("2026-09-15T14:37:12Z"));
    const before = previousPeriod(period);
    expect(before.from.toISOString()).toBe("2026-09-13T14:00:00.000Z");
    expect(hourKeys(before.from, before.to)).toHaveLength(24);
  });
});
