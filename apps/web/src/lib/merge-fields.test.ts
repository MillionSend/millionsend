import { describe, expect, it } from "vitest";
import {
  buildMergeOptions,
  MERGE_BUILTINS,
  MERGE_TOKEN_RE,
  makeMergeToken,
  parseMergeToken,
} from "./merge-fields";

describe("buildMergeOptions", () => {
  it("lists builtins then valid custom keys, dropping shadows and bad names", () => {
    const opts = buildMergeOptions(["plan", "EMAIL", "bad-key", "signup_date"]);
    expect(opts.slice(0, MERGE_BUILTINS.length)).toEqual(MERGE_BUILTINS);
    const custom = opts.slice(MERGE_BUILTINS.length);
    expect(custom.map((o) => o.name)).toEqual(["plan", "signup_date"]);
    expect(custom.every((o) => o.builtin === false)).toBe(true);
  });
});

describe("token round-trip", () => {
  it("makes and parses tokens with and without fallback", () => {
    expect(makeMergeToken("FIRST_NAME")).toBe("{{{FIRST_NAME}}}");
    expect(makeMergeToken("FIRST_NAME", "there")).toBe("{{{FIRST_NAME|there}}}");
    expect(makeMergeToken("plan", "")).toBe("{{{plan}}}");

    expect(parseMergeToken("{{{FIRST_NAME}}}")).toEqual({ name: "FIRST_NAME" });
    expect(parseMergeToken("{{{FIRST_NAME|there}}}")).toEqual({
      name: "FIRST_NAME",
      fallback: "there",
    });
    expect(parseMergeToken(makeMergeToken("plan", "free"))).toEqual({
      name: "plan",
      fallback: "free",
    });
  });

  it("rejects non-token and partial-match strings", () => {
    expect(parseMergeToken("plain")).toBeNull();
    expect(parseMergeToken("x {{{FIRST_NAME}}} y")).toBeNull();
    expect(parseMergeToken("{{{bad-name}}}")).toBeNull();
  });

  it("matches the worker grammar globally, including fallback capture", () => {
    const matches = [...":{{{FIRST_NAME|hi}}} {{{plan}}}".matchAll(MERGE_TOKEN_RE)];
    expect(matches.map((m) => [m[1], m[2]])).toEqual([
      ["FIRST_NAME", "hi"],
      ["plan", undefined],
    ]);
  });
});
