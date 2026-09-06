import { describe, expect, it } from "vitest";
import { findMatches, nearestMatch, stepMatch } from "@/lib/code-find";

describe("findMatches", () => {
  it("returns every non-overlapping occurrence, in order", () => {
    expect(findMatches("<td>a</td><td>b</td>", "<td>")).toEqual([
      { start: 0, end: 4 },
      { start: 10, end: 14 },
    ]);
    expect(findMatches("aaaa", "aa")).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
  });

  it("is case-insensitive and keeps the source offsets", () => {
    expect(findMatches("<TABLE><table>", "table")).toEqual([
      { start: 1, end: 6 },
      { start: 8, end: 13 },
    ]);
  });

  it("treats the query as literal text, not a pattern", () => {
    expect(findMatches("a.b axb", "a.b")).toEqual([{ start: 0, end: 3 }]);
    expect(findMatches("{{{FIRST_NAME|there}}}", "{{{")).toEqual([{ start: 0, end: 3 }]);
  });

  it("finds nothing for an empty query or a missing needle", () => {
    expect(findMatches("<p>x</p>", "")).toEqual([]);
    expect(findMatches("<p>x</p>", "div")).toEqual([]);
    expect(findMatches("", "p")).toEqual([]);
  });
});

describe("stepMatch", () => {
  it("wraps around at both ends", () => {
    expect(stepMatch(3, 2, 1)).toBe(0);
    expect(stepMatch(3, 0, -1)).toBe(2);
    expect(stepMatch(3, 1, 1)).toBe(2);
    expect(stepMatch(3, 1, -1)).toBe(0);
  });

  it("starts from the first (or last) match when nothing is current", () => {
    expect(stepMatch(3, -1, 1)).toBe(0);
    expect(stepMatch(3, -1, -1)).toBe(2);
  });

  it("stays at -1 without matches", () => {
    expect(stepMatch(0, -1, 1)).toBe(-1);
    expect(stepMatch(0, 2, -1)).toBe(-1);
  });
});

describe("nearestMatch", () => {
  const matches = findMatches("ab ab ab", "ab");

  it("picks the first match at or after the caret, wrapping to the first", () => {
    expect(nearestMatch(matches, 0)).toBe(0);
    expect(nearestMatch(matches, 1)).toBe(1);
    expect(nearestMatch(matches, 3)).toBe(1);
    expect(nearestMatch(matches, 7)).toBe(0);
  });

  it("is -1 without matches", () => {
    expect(nearestMatch([], 4)).toBe(-1);
  });
});
