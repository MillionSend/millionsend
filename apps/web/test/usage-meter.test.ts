import { describe, expect, it } from "vitest";
import { formatUtcDayReset, meterClass } from "@/lib/usage-meter";

describe("meterClass", () => {
  it("maps ratio to warn/danger thresholds", () => {
    expect(meterClass(0)).toBe("");
    expect(meterClass(0.79)).toBe("");
    expect(meterClass(0.8)).toBe("ms-meter-warn");
    expect(meterClass(0.95)).toBe("ms-meter-danger");
    expect(meterClass(1)).toBe("ms-meter-danger");
  });
});

describe("formatUtcDayReset", () => {
  it("formats time left until next UTC midnight", () => {
    // 2026-08-13T17:48:00Z → 6h 12m left in the UTC day.
    expect(formatUtcDayReset(Date.UTC(2026, 7, 13, 17, 48))).toBe("6h 12m");
    expect(formatUtcDayReset(Date.UTC(2026, 7, 13, 0, 0))).toBe("24h 0m");
    expect(formatUtcDayReset(Date.UTC(2026, 7, 13, 23, 59, 30))).toBe("0h 0m");
  });
});
