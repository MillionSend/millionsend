import { describe, expect, it } from "vitest";
import {
  formatDurationShort,
  formatHoursMinutes,
  formatUtcMinute,
  formatUtcTimestampMs,
  maskApiKey,
} from "@/lib/format";

describe("formatHoursMinutes", () => {
  it("renders h/m countdowns, dropping a zero hour", () => {
    expect(formatHoursMinutes(5 * 3_600_000 + 32 * 60_000)).toBe("5h 32m");
    expect(formatHoursMinutes(48 * 60_000)).toBe("48m");
    expect(formatHoursMinutes(0)).toBe("0m");
  });
});

describe("formatDurationShort", () => {
  it("picks the unit by magnitude and trims trailing zeros", () => {
    expect(formatDurationShort(21)).toBe("21 ms");
    expect(formatDurationShort(1920)).toBe("1.92 s");
    expect(formatDurationShort(2300)).toBe("2.3 s");
    expect(formatDurationShort(384_000)).toBe("6.4 m");
    expect(formatDurationShort(4_320_000)).toBe("1.2 h");
    expect(formatDurationShort(259_200_000)).toBe("3 d");
  });
});

describe("utc timestamps", () => {
  it("renders millisecond and minute precision", () => {
    const d = new Date("2026-08-12T14:03:20.208Z");
    expect(formatUtcTimestampMs(d)).toBe("2026-08-12 14:03:20.208 UTC");
    expect(formatUtcMinute(d)).toBe("2026-08-12 14:03 UTC");
  });
});

describe("maskApiKey", () => {
  it("masks everything after the scheme, keeping the last 4", () => {
    expect(maskApiKey("ms_abc123", "wxyz")).toBe("ms_••••••••wxyz");
  });

  it("is unaffected by underscores inside the base64url secret chars", () => {
    expect(maskApiKey("ms_ab_c1d", "wxyz")).toBe("ms_••••••••wxyz");
  });

  it("falls back to the whole prefix when the scheme is unrecognized", () => {
    expect(maskApiKey("legacy", "wxyz")).toBe("legacy••••••••wxyz");
  });
});
