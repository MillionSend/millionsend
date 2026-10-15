import { describe, expect, it } from "vitest";
import { fixedWindowCounter } from "../src/rate-limit.js";

const MINUTE = Date.UTC(2026, 9, 9, 10, 0);

describe("fixedWindowCounter", () => {
  it("counts each key's hits in the current minute and the seconds left in it", () => {
    const count = fixedWindowCounter();
    expect(count("a", MINUTE)).toEqual({ count: 1, retryAfterSec: 60 });
    expect(count("a", MINUTE + 59_500)).toEqual({ count: 2, retryAfterSec: 1 });
    expect(count("b", MINUTE + 30_000)).toEqual({ count: 1, retryAfterSec: 30 });
    expect(count("a", MINUTE + 60_000)).toEqual({ count: 1, retryAfterSec: 60 });
  });

  it("sweeps only past minutes, so a flood of keys never resets a live count", () => {
    const count = fixedWindowCounter();
    count("team", MINUTE);
    for (let i = 0; i < 10_000; i++) count(`ip:${i}`, MINUTE);
    // Past the sweep size: this hit sweeps the map and keeps the minute's counts.
    expect(count("team", MINUTE + 1_000).count).toBe(2);
    expect(count("team", MINUTE + 60_000).count).toBe(1);
  });
});
