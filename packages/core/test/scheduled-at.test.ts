import { describe, expect, it } from "vitest";
import { parseScheduledAt, SCHEDULED_AT_FORMS } from "../src/scheduled-at.js";

const now = new Date("2026-08-19T12:00:00.000Z");

describe("parseScheduledAt", () => {
  it("resolves each relative unit against the provided now", () => {
    const cases: [string, number][] = [
      ["in 1 min", 60_000],
      ["in 5 mins", 5 * 60_000],
      ["in 1 minute", 60_000],
      ["in 30 minutes", 30 * 60_000],
      ["in 1 hour", 3_600_000],
      ["in 2 hours", 2 * 3_600_000],
      ["in 1 day", 86_400_000],
      ["in 2 days", 2 * 86_400_000],
    ];
    for (const [input, offset] of cases) {
      expect(parseScheduledAt(input, now)?.getTime(), input).toBe(now.getTime() + offset);
    }
  });

  it("is case-insensitive and tolerates surrounding whitespace", () => {
    expect(parseScheduledAt("IN 2 DAYS", now)?.getTime()).toBe(now.getTime() + 2 * 86_400_000);
    expect(parseScheduledAt("  in 1 Hour  ", now)?.getTime()).toBe(now.getTime() + 3_600_000);
  });

  it("passes through ISO 8601 with offset (Z and numeric)", () => {
    expect(parseScheduledAt("2026-09-01T10:00:00Z", now)?.toISOString()).toBe(
      "2026-09-01T10:00:00.000Z",
    );
    expect(parseScheduledAt("2026-09-01T10:00:00+02:00", now)?.toISOString()).toBe(
      "2026-09-01T08:00:00.000Z",
    );
  });

  it("rejects everything else", () => {
    for (const input of [
      "2026-09-01", // bare date
      "2026-09-01T10:00:00", // no offset
      "in 2 weeks", // undocumented unit
      "in two days", // spelled-out number
      "tomorrow",
      "in 5", // missing unit
      "5 mins", // missing "in"
      "",
      "in 999999999999999999 days", // overflows the Date range
    ]) {
      expect(parseScheduledAt(input, now), input).toBeNull();
    }
  });

  it("names both accepted forms for 422 messages", () => {
    expect(SCHEDULED_AT_FORMS).toMatch(/ISO 8601/);
    expect(SCHEDULED_AT_FORMS).toMatch(/in 5 mins/);
  });
});
