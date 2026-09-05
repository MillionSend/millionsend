import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config.js";
import { createContext } from "../src/context.js";
import { countUp, createProgress } from "../src/progress.js";
import { colorEnabled, setColorMode } from "../src/theme.js";
import { formatDuration, formatNumber } from "../src/utils.js";

function sink() {
  const chunks: string[] = [];
  const stream = {
    write: (c: string) => {
      chunks.push(String(c));
      return true;
    },
  } as never;
  return { chunks, stream };
}

describe("createProgress (piped)", () => {
  it("appends a line every 1,000 units and on done", () => {
    const { chunks, stream } = sink();
    const progress = createProgress({ stream, tty: false });
    progress.section(["Contacts"]);
    const step = progress.step("Contacts");
    step.update(400, 12847);
    step.update(999, 12847);
    step.update(1000, 12847);
    step.update(1500, 12847);
    step.update(3200, 12847);
    step.note("2 rejected by the API");
    step.done();
    step.done("again");
    expect(chunks).toEqual([
      "⟳ Contacts 1,000/12,847\n",
      "⟳ Contacts 3,200/12,847\n",
      "! 2 rejected by the API\n",
      "✓ Contacts 3,200/12,847\n",
    ]);
  });

  it("fail and a summary on done", () => {
    const { chunks, stream } = sink();
    const progress = createProgress({ stream, tty: false });
    progress.section(["Domains", "Webhooks"]);
    progress.step("Domains").done("3 created, 1 unchanged");
    progress.step("Webhooks").fail("MillionSend answered 500");
    expect(chunks).toEqual([
      "✓ Domains  3 created, 1 unchanged\n",
      "✗ Webhooks — MillionSend answered 500\n",
    ]);
  });

  it("counts sit in a 7-wide column after the section's longest label", () => {
    const { chunks, stream } = sink();
    const progress = createProgress({ stream, tty: false });
    progress.section(["Contact properties", "Contacts", "MillionSend"]);
    progress.step("Contacts").done("721");
    progress.step("Contact properties").done("3");
    progress.step("MillionSend").done("current state read");
    expect(chunks).toEqual([
      `✓ ${"Contacts".padEnd(18)}     721\n`,
      `✓ Contact properties       3\n`,
      `✓ ${"MillionSend".padEnd(18)} current state read\n`,
    ]);
  });

  it("section values widen the count column so n/total counters share a right edge", () => {
    const { chunks, stream } = sink();
    const progress = createProgress({ stream, tty: false });
    progress.section(["Topics", "Contacts"], ["5/5", "1,250/1,250"]);
    const topics = progress.step("Topics");
    topics.update(5, 5);
    topics.done();
    const contacts = progress.step("Contacts");
    contacts.update(1250, 1250);
    contacts.done();
    expect(chunks).toEqual([
      "✓ Topics           5/5\n",
      "⟳ Contacts 1,250/1,250\n",
      "✓ Contacts 1,250/1,250\n",
    ]);
    progress.section(["Topics"]);
    progress.step("Topics").done("5");
    expect(chunks.at(-1)).toBe("✓ Topics       5\n");
  });

  it("without a section, labels pad to a fixed 20", () => {
    const { chunks, stream } = sink();
    createProgress({ stream, tty: false }).step("Contacts").done("3");
    expect(chunks).toEqual([`✓ ${"Contacts".padEnd(20)} ${"3".padStart(7)}\n`]);
  });

  it("colors only the marker; a zero count reads dim as a whole", () => {
    const { chunks, stream } = sink();
    setColorMode("always");
    try {
      const progress = createProgress({ stream, tty: false });
      progress.section(["Contacts", "Templates"]);
      progress.step("Contacts").done("721");
      progress.step("Templates").done("0");
      const failed = progress.step("Webhooks");
      failed.note("resumed");
      failed.fail("MillionSend answered 500");
    } finally {
      setColorMode("auto");
    }
    expect(chunks).toEqual([
      "\x1b[32m✓\x1b[39m Contacts      721\n",
      "\x1b[2m✓ Templates       0\x1b[22m\n",
      "\x1b[35m!\x1b[39m resumed\n",
      "\x1b[31m✗\x1b[39m Webhooks — MillionSend answered 500\n",
    ]);
  });
});

describe("createProgress (tty)", () => {
  it("rewrites the live line in place and keeps notes above it", () => {
    const { chunks, stream } = sink();
    const progress = createProgress({ stream, tty: true });
    progress.section(["Contacts"]);
    const step = progress.step("Contacts");
    step.update(3200, 12847);
    step.note("resumed");
    step.done();
    expect(chunks.join("")).toBe(
      "\r\x1b[2K⟳ Contacts" +
        "\r\x1b[2K⟳ Contacts 3,200/12,847" +
        "\r\x1b[2K! resumed\n⟳ Contacts 3,200/12,847" +
        "\r\x1b[2K✓ Contacts 3,200/12,847\n",
    );
  });

  it("the live marker is cyan; the count column holds while it moves", () => {
    const { chunks, stream } = sink();
    setColorMode("always");
    try {
      const progress = createProgress({ stream, tty: true });
      progress.section(["Contacts"]);
      const step = progress.step("Contacts");
      step.update(1, 12847);
      step.update(12847, 12847);
      step.done();
    } finally {
      setColorMode("auto");
    }
    expect(chunks).toEqual([
      "\r\x1b[2K\x1b[36m⟳\x1b[39m Contacts",
      "\r\x1b[2K\x1b[36m⟳\x1b[39m Contacts 1/12,847",
      "\r\x1b[2K\x1b[36m⟳\x1b[39m Contacts 12,847/12,847",
      "\r\x1b[2K",
      "\x1b[32m✓\x1b[39m Contacts 12,847/12,847\n",
    ]);
  });

  it("writeAbove clears the live line, writes to the other stream, redraws", () => {
    const bytes: string[] = [];
    const tag = (name: string) => ({
      write: (c: string) => {
        bytes.push(`${name}:${String(c)}`);
        return true;
      },
    });
    const progress = createProgress({ stream: tag("out") as never, tty: true });
    progress.section(["Contacts"]);
    const step = progress.step("Contacts");
    step.update(3200, 12847);
    progress.writeAbove("warning: retry 2/5 in 1s — Resend 503\n", tag("err"));
    progress.clear();
    progress.writeAbove("error: Resend rejected the API key (401)\n", tag("err"));
    expect(bytes).toEqual([
      "out:\r\x1b[2K⟳ Contacts",
      "out:\r\x1b[2K⟳ Contacts 3,200/12,847",
      "out:\r\x1b[2K",
      "err:warning: retry 2/5 in 1s — Resend 503\n",
      "out:⟳ Contacts 3,200/12,847",
      "out:\r\x1b[2K",
      "err:error: Resend rejected the API key (401)\n",
    ]);
  });

  it("createContext routes the logger through the live line only on a TTY", () => {
    const bytes: string[] = [];
    // readline needs a real stream for its output; tap the writes and fake isTTY.
    const tag = (name: string, isTTY: boolean) => {
      const stream = Object.assign(new PassThrough(), { isTTY });
      const write = stream.write.bind(stream);
      stream.write = ((c: string) => {
        bytes.push(`${name}:${String(c)}`);
        return write(c);
      }) as typeof stream.write;
      return stream;
    };
    const config = parseConfig(["migrate", "--from", "resend", "--color", "never"], {}, true);
    const tty = createContext(config, {
      stdout: tag("out", true) as never,
      stderr: tag("err", false) as never,
      stdin: new PassThrough(),
    });
    tty.progress.section(["Contacts"]);
    tty.progress.step("Contacts").update(1);
    tty.log.warn("careful");
    tty.rl.close();
    expect(bytes).toEqual([
      "out:\r\x1b[2K⟳ Contacts",
      "out:\r\x1b[2K⟳ Contacts       1",
      "out:\r\x1b[2K",
      "err:warning: careful\n",
      "out:⟳ Contacts       1",
    ]);

    bytes.length = 0;
    const piped = createContext(config, {
      stdout: tag("out", false) as never,
      stderr: tag("err", false) as never,
      stdin: new PassThrough(),
    });
    piped.progress.step("Contacts").update(1);
    piped.log.warn("careful");
    piped.rl.close();
    expect(bytes).toEqual(["err:warning: careful\n"]);
  });

  it("createContext keys auto color on the human stream: stderr under --json", () => {
    const stream = (isTTY: boolean) => Object.assign(new PassThrough(), { isTTY });
    const { NO_COLOR, FORCE_COLOR } = process.env;
    delete process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;
    try {
      const keys = {
        RESEND_API_KEY: "re_x",
        MILLIONSEND_API_KEY: "ms_x",
        MILLIONSEND_BASE_URL: "http://127.0.0.1:1",
      };
      const json = parseConfig(["migrate", "plan", "--from", "resend", "--json"], keys, true);
      const plain = parseConfig(["migrate", "--from", "resend"], {}, true);
      let ctx = createContext(json, { stdout: stream(true), stderr: stream(false) });
      ctx.rl.close();
      expect(colorEnabled()).toBe(false);
      ctx = createContext(json, { stdout: stream(false), stderr: stream(true) });
      ctx.rl.close();
      expect(colorEnabled()).toBe(true);
      ctx = createContext(plain, { stdout: stream(false), stderr: stream(true) });
      ctx.rl.close();
      expect(colorEnabled()).toBe(false);
    } finally {
      if (NO_COLOR !== undefined) process.env.NO_COLOR = NO_COLOR;
      if (FORCE_COLOR !== undefined) process.env.FORCE_COLOR = FORCE_COLOR;
      setColorMode("auto");
    }
  });
});

describe("countUp", () => {
  it("prints static right-aligned rows when piped", async () => {
    const { chunks, stream } = sink();
    await countUp(
      [
        { label: "contacts", value: 12847 },
        { label: "segments", value: 7 },
      ],
      { stream, tty: false },
    );
    expect(chunks).toEqual(["12,847  contacts\n     7  segments\n"]);
  });

  it("bolds the number, never the noun", async () => {
    const { chunks, stream } = sink();
    setColorMode("always");
    try {
      await countUp([{ label: "contacts", value: 7 }], { stream, tty: false });
    } finally {
      setColorMode("auto");
    }
    expect(chunks).toEqual(["\x1b[1m7\x1b[22m  contacts\n"]);
  });

  it("animates on a TTY and ends on the exact numbers", async () => {
    const { chunks, stream } = sink();
    await countUp([{ label: "contacts", value: 12847 }], { stream, tty: true, ms: 100 });
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[chunks.length - 1]).toBe("12,847  contacts\n");
    expect(chunks[chunks.length - 2]).toBe("\x1b[1A");
  });
});

describe("format helpers", () => {
  it("thousands separators and durations", () => {
    expect(formatNumber(713)).toBe("713");
    expect(formatNumber(2140)).toBe("2,140");
    expect(formatDuration(12)).toBe("12 s");
    expect(formatDuration(0.2)).toBe("1 s");
    expect(formatDuration(267)).toBe("about 4 min");
  });
});

describe("createProgress (tty pace)", () => {
  afterEach(() => vi.useRealTimers());

  it("shows the rate and the time left once enough items are in", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T12:00:00Z"));
    setColorMode("never");
    const { chunks, stream } = sink();
    const step = createProgress({ stream, tty: true }).step("Enrichment · topics");
    for (let n = 1; n <= 40; n++) {
      vi.advanceTimersByTime(500);
      step.update(n, 1000);
    }
    const last = chunks.at(-1) ?? "";
    expect(last).toContain("40/1,000");
    expect(last).toMatch(/2(\.0)?\/s · ~8 min left/);
    step.update(1000, 1000);
    expect(chunks.at(-1)).not.toContain("left");
  });
});
