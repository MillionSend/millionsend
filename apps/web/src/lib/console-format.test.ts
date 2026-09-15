import { describe, expect, it } from "vitest";
import { durationUnit, formatPercent, formatSignedPercent, periodDayKeys } from "./console-format";

describe("periodDayKeys", () => {
  const now = new Date("2026-09-15T15:30:00Z");

  it("spans the preset windows ending today, in UTC", () => {
    expect(periodDayKeys("24h", now)).toEqual(["2026-09-14", "2026-09-15"]);
    const week = periodDayKeys("7d", now);
    expect(week).toHaveLength(7);
    expect(week[0]).toBe("2026-09-09");
    expect(week[6]).toBe("2026-09-15");
    expect(periodDayKeys("90d", now)).toHaveLength(90);
  });

  it("caps a custom range at now", () => {
    expect(periodDayKeys({ from: "2026-09-13", to: "2026-09-20" }, now)).toEqual([
      "2026-09-13",
      "2026-09-14",
      "2026-09-15",
    ]);
  });
});

describe("durationUnit", () => {
  it("picks the largest whole unit", () => {
    expect(durationUnit(2)).toEqual({ unit: "seconds", n: 2 });
    expect(durationUnit(150)).toEqual({ unit: "minutes", n: 3 });
    expect(durationUnit(7_200)).toEqual({ unit: "hours", n: 2 });
    expect(durationUnit(200_000)).toEqual({ unit: "days", n: 2 });
  });
});

describe("percent formatters", () => {
  it("keeps the requested decimals and signs deltas", () => {
    expect(formatPercent(0.985, "en", 1)).toBe("98.5%");
    expect(formatPercent(0.00031, "en", 3)).toBe("0.031%");
    expect(formatSignedPercent(0.081, "en", 1)).toBe("+8.1%");
    expect(formatSignedPercent(0, "en", 1)).toBe("0.0%");
  });
});
