import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  answerLine,
  banner,
  bannerLines,
  confirmPrompt,
  lineReader,
  maskSecret,
  multiSelectPrompt,
  optionRow,
  pickBannerTier,
  rowsFor,
  secretPrompt,
  secretPromptMode,
  selectPrompt,
  textPrompt,
  visibleLength,
  wrapText,
} from "../src/tty-ui.js";
import { truncate } from "../src/utils.js";

describe("lineReader", () => {
  function reader() {
    const input = new PassThrough();
    const output = new PassThrough();
    return { input, rl: lineReader(input, output) };
  }

  it("keeps answers piped in one burst, including lines arriving between questions", async () => {
    const { input, rl } = reader();
    input.end("first\nsecond\nthird\n");
    expect(await rl.question("q1? ")).toBe("first");
    // The burst delivered these while no question was pending — the
    // readline/promises API drops them; the queue must not.
    expect(await rl.question("q2? ")).toBe("second");
    expect(await rl.question("q3? ")).toBe("third");
    rl.close();
  });

  it("answers a question that is already waiting when the line arrives", async () => {
    const { input, rl } = reader();
    const pending = rl.question("q? ");
    input.write("typed\n");
    expect(await pending).toBe("typed");
    rl.close();
  });

  it("resolves pending and later questions with '' after EOF", async () => {
    const { input, rl } = reader();
    input.end("only\n");
    expect(await rl.question("q1? ")).toBe("only");
    expect(await rl.question("q2? ")).toBe("");
    expect(await rl.question("q3? ")).toBe("");
    rl.close();
  });
});

describe("wrapText", () => {
  it("wraps greedily and leaves long words unbroken", () => {
    expect(wrapText("aa bb cc dd", 5)).toBe("aa bb\ncc dd");
    expect(wrapText("abcdefghij k", 4)).toBe("abcdefghij\nk");
  });
});

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

describe("piped prompts", () => {
  function reader(pipedInput: string) {
    const input = new PassThrough();
    const output = new PassThrough();
    input.end(pipedInput);
    return { rl: lineReader(input, output), output };
  }
  const options = [
    { value: "contacts", label: "Contacts", checked: true },
    { value: "topics", label: "Topics", checked: true },
    { value: "sent", label: "Sent broadcasts" },
  ];

  it("multiSelectPrompt: empty answer keeps the defaults, a comma list replaces them", async () => {
    const { rl, output } = reader("\ntopics, sent,bogus\n");
    expect(await multiSelectPrompt(rl, { label: "Resources", options })).toEqual([
      "contacts",
      "topics",
    ]);
    expect(output.read()?.toString()).toBe("Resources [contacts,topics]: ");
    expect(await multiSelectPrompt(rl, { label: "Resources", options })).toEqual([
      "topics",
      "sent",
    ]);
    rl.close();
  });

  it("secretPrompt: plain question, trimmed answer", async () => {
    const { rl, output } = reader("  re_abc123  \n");
    expect(await secretPrompt(rl, { label: "Resend API key" })).toBe("re_abc123");
    expect(output.read()?.toString()).toBe("Resend API key: ");
    rl.close();
  });

  it("confirmPrompt: y/yes accept, empty takes the initial, anything else declines", async () => {
    const { rl, output } = reader("y\nYES\n\n\nmaybe\n");
    expect(await confirmPrompt(rl, { label: "Proceed?" })).toBe(true);
    expect(output.read()?.toString()).toBe("Proceed? (y/N) ");
    expect(await confirmPrompt(rl, { label: "Proceed?" })).toBe(true);
    expect(await confirmPrompt(rl, { label: "Proceed?" })).toBe(false);
    expect(await confirmPrompt(rl, { label: "Proceed?", initial: true })).toBe(true);
    expect(await confirmPrompt(rl, { label: "Proceed?", initial: true })).toBe(false);
    rl.close();
  });

  it("textPrompt: empty takes the initial; an invalid piped answer throws", async () => {
    const { rl, output } = reader("\nnot a url\n");
    expect(await textPrompt(rl, { label: "API URL", initial: "https://a" })).toBe("https://a");
    expect(output.read()?.toString()).toBe("API URL [https://a]: ");
    await expect(
      textPrompt(rl, {
        label: "API URL",
        validate: (v) => (v.startsWith("https://") ? undefined : "must start with https://"),
      }),
    ).rejects.toThrow("API URL: must start with https://");
    rl.close();
  });
});

describe("maskSecret", () => {
  it("keeps the first 3 and last 4 characters, nothing of a short value", () => {
    expect(maskSecret("re_123456789ab12")).toBe("re_****…ab12");
    expect(maskSecret("short")).toBe("****");
  });
});

describe("secretPromptMode", () => {
  it("masks whenever stdin is a terminal, on stderr when stdout is a pipe", () => {
    expect(secretPromptMode(true, true)).toEqual({ masked: true, toStderr: false });
    expect(secretPromptMode(true, false)).toEqual({ masked: true, toStderr: true });
    expect(secretPromptMode(false, true)).toEqual({ masked: false, toStderr: false });
    expect(secretPromptMode(false, false)).toEqual({ masked: false, toStderr: false });
  });
});

describe("answerLine", () => {
  it("uses a dash after a question and a colon otherwise", () => {
    expect(answerLine("Where is MillionSend running?", "MillionSend Cloud")).toBe(
      "Where is MillionSend running? — MillionSend Cloud",
    );
    expect(answerLine("Domain limit", "First 3 domains")).toBe("Domain limit: First 3 domains");
  });
});

describe("rowsFor", () => {
  const row =
    "❯ [x] Enrichment — properties and topic subscriptions, read per contact (12,847 contacts)";

  it("counts wrapped rows per line, ANSI excluded", () => {
    expect([...row].length).toBe(89);
    expect(rowsFor([row], 80)).toBe(2);
    expect(rowsFor([row], 40)).toBe(3);
    expect(rowsFor(["Resources", row, "short"], 80)).toBe(4);
    expect(rowsFor([""], 80)).toBe(1);
    expect(visibleLength(`\x1b[97m${"x".repeat(80)}\x1b[39m`)).toBe(80);
    expect(rowsFor([`\x1b[97m${"x".repeat(80)}\x1b[39m`], 80)).toBe(1);
  });
});

describe("optionRow", () => {
  const option = {
    value: "enrichment",
    label: "Enrichment — properties and topic subscriptions",
    hint: "12,847 contacts",
  };

  it("fits in columns - 1 with an ellipsis, hint cut first", () => {
    const full = optionRow("❯ [x] ", option, true, 120);
    expect(full).toBe("❯ [x] Enrichment — properties and topic subscriptions (12,847 contacts)");
    const cut = optionRow("❯ [x] ", option, true, 60);
    expect([...cut].length).toBe(59);
    expect(cut).toBe("❯ [x] Enrichment — properties and topic subscriptions (12,…");
    const short = optionRow("  ", option, false, 20);
    expect(short).toBe("  Enrichment — pro…");
  });
});

describe("truncate", () => {
  it("cuts by code point and marks the cut", () => {
    expect(truncate("abcdef", 6)).toBe("abcdef");
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("héllo wörld", 5)).toBe("héll…");
  });
});
