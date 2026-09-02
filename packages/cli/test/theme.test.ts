import { afterEach, describe, expect, it } from "vitest";
import {
  bold,
  colorEnabled,
  column,
  dim,
  heading,
  layoutWidth,
  ok,
  setColorMode,
  shortId,
  wrapIndent,
} from "../src/theme.js";
import { visibleLength } from "../src/tty-ui.js";

const stdout = process.stdout as unknown as {
  isTTY?: boolean | undefined;
  columns?: number | undefined;
};
const saved = {
  isTTY: stdout.isTTY,
  columns: stdout.columns,
  NO_COLOR: process.env.NO_COLOR,
  FORCE_COLOR: process.env.FORCE_COLOR,
};

function setEnv(name: "NO_COLOR" | "FORCE_COLOR", value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  setColorMode("auto");
  stdout.isTTY = saved.isTTY;
  stdout.columns = saved.columns;
  setEnv("NO_COLOR", saved.NO_COLOR);
  setEnv("FORCE_COLOR", saved.FORCE_COLOR);
});

describe("colorEnabled", () => {
  it.each([
    // [mode, tty, NO_COLOR, FORCE_COLOR, expected]
    ["auto", true, undefined, undefined, true],
    ["auto", false, undefined, undefined, false],
    ["auto", true, "1", undefined, false],
    ["auto", false, undefined, "1", true],
    ["auto", false, "1", "1", true],
    ["auto", false, undefined, "0", false],
    ["always", false, "1", undefined, true],
    ["never", true, undefined, "1", false],
  ] as const)("mode %s tty %s NO_COLOR %s FORCE_COLOR %s → %s", (mode, tty, no, force, want) => {
    setColorMode(mode);
    stdout.isTTY = tty;
    setEnv("NO_COLOR", no);
    setEnv("FORCE_COLOR", force);
    expect(colorEnabled()).toBe(want);
  });

  it("auto follows the stream given to setColorMode, not process.stdout", () => {
    setEnv("NO_COLOR", undefined);
    setEnv("FORCE_COLOR", undefined);
    stdout.isTTY = true;
    setColorMode("auto", false);
    expect(colorEnabled()).toBe(false);
    stdout.isTTY = false;
    setColorMode("auto", true);
    expect(colorEnabled()).toBe(true);
  });

  it("wrappers are the identity when disabled and use 16-color SGR when enabled", () => {
    setColorMode("never");
    expect(ok("x")).toBe("x");
    expect(dim("x")).toBe("x");
    setColorMode("always");
    expect(ok("x")).toBe("\x1b[32mx\x1b[39m");
    expect(bold("x")).toBe("\x1b[1mx\x1b[22m");
    expect(dim("x")).toBe("\x1b[2mx\x1b[22m");
  });
});

describe("wrapIndent", () => {
  it("wraps greedily with a hanging indent", () => {
    expect(wrapIndent("aa bb cc dd ee", { width: 8, indent: "- ", hanging: "  " })).toBe(
      "- aa bb\n  cc dd\n  ee",
    );
  });

  it("keeps a word longer than the width whole", () => {
    expect(wrapIndent("abcdefghij k", { width: 4 })).toBe("abcdefghij\nk");
    expect(wrapIndent("a abcdefghij k", { width: 4 })).toBe("a\nabcdefghij\nk");
  });

  it("does not count ANSI sequences", () => {
    const word = "\x1b[1mbold\x1b[22m";
    expect(wrapIndent(`${word} ${word} ${word}`, { width: 9 })).toBe(`${word} ${word}\n${word}`);
  });

  it("hanging defaults to indent; empty text is just the indent", () => {
    expect(wrapIndent("a b", { width: 3, indent: "> " })).toBe("> a\n> b");
    expect(wrapIndent("", { width: 10, indent: "  " })).toBe("  ");
  });
});

describe("layoutWidth and heading", () => {
  it("is the terminal width capped at 100, 80 without one", () => {
    stdout.columns = 60;
    expect(layoutWidth()).toBe(60);
    stdout.columns = 200;
    expect(layoutWidth()).toBe(100);
    stdout.columns = undefined;
    expect(layoutWidth()).toBe(80);
  });

  it("draws the rule as wide as the layout", () => {
    stdout.columns = 72;
    setColorMode("always");
    const [title, rule] = heading("Plan").split("\n");
    expect(title).toBe("\x1b[1mPlan\x1b[22m");
    expect(visibleLength(rule ?? "")).toBe(72);
    expect(rule).toBe(`\x1b[2m${"─".repeat(72)}\x1b[22m`);
  });
});

describe("shortId", () => {
  it("shortens UUIDs only", () => {
    expect(shortId("05cda767-3b56-4e7c-be10-0954661a052c")).toBe("05cda767…");
    expect(shortId("re_abc")).toBe("re_abc");
    expect(shortId("updates.example.com")).toBe("updates.example.com");
  });
});

describe("column", () => {
  it("pads labels to the longest and right-aligns values to width 7, ANSI excluded", () => {
    setColorMode("always");
    expect(
      column([
        ["Contacts", "721"],
        [dim("Templates"), "0"],
        ["Broadcasts", "1,234,567"],
      ]),
    ).toEqual(["Contacts       721", `${dim("Templates")}        0`, "Broadcasts 1,234,567"]);
  });

  it("takes a wider value column", () => {
    expect(
      column(
        [
          ["Topics", "5/5"],
          ["Contacts", "1,250/1,250"],
        ],
        11,
      ),
    ).toEqual(["Topics           5/5", "Contacts 1,250/1,250"]);
  });
});
