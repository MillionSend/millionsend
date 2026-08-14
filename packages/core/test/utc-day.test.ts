import { describe, expect, it } from "vitest";
import { DAY_MS, utcDay } from "../src/utc-day.js";

describe("utcDay", () => {
  it("formats as YYYY-MM-DD in UTC regardless of local time", () => {
    expect(utcDay(Date.UTC(2026, 0, 5, 23, 59, 59))).toBe("2026-01-05");
    expect(utcDay(Date.UTC(2026, 0, 6, 0, 0, 0))).toBe("2026-01-06");
    expect(utcDay(new Date(Date.UTC(1970, 0, 1)))).toBe("1970-01-01");
  });

  it("defaults to today", () => {
    expect(utcDay()).toBe(new Date().toISOString().slice(0, 10));
  });

  it("pins the day length constant", () => {
    expect(DAY_MS).toBe(86_400_000);
  });
});
