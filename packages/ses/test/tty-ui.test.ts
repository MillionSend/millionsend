import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { lineReader } from "../src/setup-cli.js";
import { banner, bannerLines, pickBannerTier, selectPrompt } from "../src/tty-ui.js";

describe("bannerLines", () => {
  it("full art: 6 rows, every row 74 wide", () => {
    const lines = bannerLines("full");
    expect(lines).toHaveLength(6);
    for (const line of lines) expect([...line].length).toBe(74);
  });

  it("compact art: 3 rows, every row 44 wide", () => {
    const lines = bannerLines("compact");
    expect(lines).toHaveLength(3);
    for (const line of lines) expect([...line].length).toBe(44);
  });
});

describe("pickBannerTier", () => {
  it("tiers by width on a TTY", () => {
    expect(pickBannerTier(120, true)).toBe("full");
    expect(pickBannerTier(80, true)).toBe("full");
    expect(pickBannerTier(79, true)).toBe("compact");
    expect(pickBannerTier(48, true)).toBe("compact");
    expect(pickBannerTier(47, true)).toBe("plain");
    expect(pickBannerTier(0, true)).toBe("plain");
  });

  it("is always plain when piped", () => {
    expect(pickBannerTier(200, false)).toBe("plain");
  });
});

describe("banner coloring", () => {
  // Colors key off process.stdout.isTTY and NO_COLOR at call time; stub both.
  function onColorTty(noColor: string | undefined, fn: () => void): void {
    const stdout = process.stdout as unknown as { isTTY?: boolean | undefined };
    const prevTty = stdout.isTTY;
    const prevNoColor = process.env.NO_COLOR;
    stdout.isTTY = true;
    if (noColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = noColor;
    try {
      fn();
    } finally {
      stdout.isTTY = prevTty;
      if (prevNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prevNoColor;
    }
  }

  it("is uncolored — art carries its tones through character density", () => {
    for (const line of banner("full")) {
      expect(line).not.toContain("\x1b");
    }
  });

  it("NO_COLOR strips every escape", () => {
    onColorTty("1", () => {
      expect(banner("full")).toEqual(bannerLines("full"));
      expect(banner("compact")).toEqual(bannerLines("compact"));
    });
  });
});

describe("selectPrompt non-TTY fallback", () => {
  // vitest workers run piped, so process.stdin/stdout are not TTYs here and
  // selectPrompt must take the lineReader question path.
  const options = [
    { value: "us-east-1", label: "us-east-1" },
    { value: "eu-west-1", label: "eu-west-1" },
  ];

  function reader(pipedInput: string) {
    const input = new PassThrough();
    const output = new PassThrough();
    input.end(pipedInput);
    return { rl: lineReader(input, output), output };
  }

  it("returns the typed line, even one outside the options", async () => {
    const { rl, output } = reader("ap-southeast-2\n");
    const value = await selectPrompt(rl, { label: "AWS region", options, initial: "us-east-1" });
    expect(value).toBe("ap-southeast-2");
    expect(output.read()?.toString()).toBe("AWS region [us-east-1]: ");
    rl.close();
  });

  it("returns the initial on an empty answer and on EOF", async () => {
    const { rl } = reader("\n");
    expect(await selectPrompt(rl, { label: "AWS region", options, initial: "sa-east-1" })).toBe(
      "sa-east-1",
    );
    expect(await selectPrompt(rl, { label: "AWS region", options, initial: "sa-east-1" })).toBe(
      "sa-east-1",
    );
    rl.close();
  });

  it("defaults to the first option value without an initial", async () => {
    const { rl } = reader("\n");
    expect(await selectPrompt(rl, { label: "AWS region", options })).toBe("us-east-1");
    rl.close();
  });
});
