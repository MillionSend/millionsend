import { describe, expect, it } from "vitest";
import {
  buildMergeOptions,
  hasWellFormedMergeTokens,
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

  it("merges derived and defined keys, keeping a defined-only key and deduping overlap", () => {
    // Callers pass [...derivedKeys, ...definedKeys]; `plan` is in both, `tier`
    // is defined but not yet in use — it must still appear, exactly once.
    const opts = buildMergeOptions(["plan", "plan", "tier"]);
    const custom = opts.slice(MERGE_BUILTINS.length).map((o) => o.name);
    expect(custom).toEqual(["plan", "tier"]);
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

describe("hasWellFormedMergeTokens", () => {
  it("passes html whose every triple-brace group is a valid token", () => {
    expect(hasWellFormedMergeTokens("<p>Hi {{{FIRST_NAME|there}}}</p>")).toBe(true);
    expect(hasWellFormedMergeTokens("<a href='{{{UNSUBSCRIBE_URL}}}'>x</a>")).toBe(true);
    expect(hasWellFormedMergeTokens("<p>no tokens here</p>")).toBe(true);
  });

  it("rejects a triple-brace group that is not a well-formed token", () => {
    // A space or a brace in the name is what a tampered/hand-edited doc would
    // leak — the worker would ship it as literal text, so the save is blocked.
    expect(hasWellFormedMergeTokens("<p>{{{FIRST NAME}}}</p>")).toBe(false);
    expect(hasWellFormedMergeTokens("<p>{{{bad-name}}}</p>")).toBe(false);
  });
});
