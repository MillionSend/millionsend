import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFlow, RAIL } from "../src/flow.js";
import { setColorMode } from "../src/theme.js";
import { lineReader } from "../src/tty-ui.js";

function reader(answers: string) {
  const input = new PassThrough();
  const output = new PassThrough();
  input.end(answers);
  return lineReader(input, output);
}

/**
 * What a terminal `columns` wide shows after `text`, trailing blank rows
 * dropped: a full row wraps on the next character (pending wrap), CR, LF,
 * CSI A/B/C/D/G moves, CSI J and K clears. A test oracle for the erase math,
 * independent of how readline chose to draw.
 */
function render(text: string, columns: number): string[] {
  const rows: string[][] = [];
  let row = 0;
  let col = 0;
  let pending = false;
  const cells = (): string[] => {
    const line = rows[row] ?? [];
    rows[row] = line;
    return line;
  };
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the control bytes are the target
  for (const [token] of text.matchAll(/\x1b\[[?\d;]*[@-~]|[\s\S]/gu)) {
    if (token === "\r" || token === "\n") {
      if (token === "\n") row++;
      col = 0;
      pending = false;
    } else if (token.startsWith("\x1b[")) {
      const n = Number.parseInt(token.slice(2), 10) || 1;
      const op = token.at(-1);
      if (op === "A") row = Math.max(0, row - n);
      else if (op === "B") row += n;
      else if (op === "C") col = Math.min(columns - 1, col + n);
      else if (op === "D") col = Math.max(0, col - n);
      else if (op === "G") col = Math.min(columns - 1, n - 1);
      else if (op === "J") {
        cells().length = Math.min(cells().length, col);
        rows.length = Math.min(rows.length, row + 1);
      } else if (op === "K") {
        if (token === "\x1b[2K") rows[row] = [];
        else cells().length = Math.min(cells().length, col);
      } else continue;
      pending = false;
    } else if (token >= " ") {
      if (pending) {
        row++;
        col = 0;
        pending = false;
      }
      const line = cells();
      while (line.length < col) line.push(" ");
      line[col] = token;
      if (col === columns - 1) pending = true;
      else col++;
    }
  }
  const shown = Array.from(rows, (line) => (line ?? []).join("").trimEnd());
  while (shown.at(-1) === "") shown.pop();
  return shown;
}

/** A terminal on both ends: keys go in, and readline's echo and the flow share one screen. */
function terminal(columns = 80) {
  const input = Object.assign(new PassThrough(), { isTTY: true });
  const chunks: string[] = [];
  const out = Object.assign(
    new Writable({
      write(chunk, _encoding, done) {
        chunks.push(String(chunk));
        done();
      },
    }),
    { isTTY: true, columns },
  ) as unknown as NodeJS.WriteStream;
  const rl = lineReader(input, out);
  return {
    rl,
    flow: createFlow(rl, { rail: true, out }),
    screen: () => render(chunks.join(""), columns),
    /** One key per event-loop turn, the way typing arrives. */
    async type(keys: string) {
      for (const key of keys) {
        input.write(key);
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
    /** One chunk, the way a paste arrives. */
    paste(text: string) {
      input.write(text);
    },
  };
}

/** A fake terminal: collects what the flow writes, 80 columns wide. */
function screen() {
  const chunks: string[] = [];
  const out = {
    columns: 80,
    write: (chunk: string) => {
      chunks.push(chunk);
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  return { out, text: () => chunks.join("") };
}

afterEach(() => {
  setColorMode("auto");
  vi.restoreAllMocks();
});

describe("flow on a pipe", () => {
  it("prints plain lines and asks the classic `label [default]: ` questions", async () => {
    setColorMode("never");
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.join(" "));
    });
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.join(" "));
    });
    const rl = reader("typed\n\ny\n\nn\n");
    const questions: string[] = [];
    const asking = {
      question: async (prompt: string) => {
        questions.push(prompt);
        return rl.question(prompt);
      },
    };
    const flow = createFlow(asking, { rail: false });
    flow.intro("millionsend", "setup", "self-host");
    flow.note("some help");
    flow.list("Plan:", ["one", "two"]);
    flow.step("created");
    flow.error("boom");
    expect(await flow.ask({ label: "Name", initial: "x" })).toBe("typed");
    expect(await flow.ask({ label: "Empty", initial: "fallback" })).toBe("fallback");
    expect(await flow.confirm("Go?", false)).toBe(true);
    expect(await flow.confirm("Go?", true)).toBe(true);
    expect(await flow.confirm("Go?", true)).toBe(false);
    flow.outro("bye");
    expect(lines).toEqual([
      "millionsend setup · self-host",
      "some help",
      "Plan:",
      "  · one",
      "  · two",
      "==> created",
      "bye",
    ]);
    expect(errors).toEqual(["boom"]);
    expect(questions).toEqual([
      "Name [x]: ",
      "Empty [fallback]: ",
      "Go? [y/N] ",
      "Go? [Y/n] ",
      "Go? [Y/n] ",
    ]);
    rl.close();
  });

  it("puts the hint on piped questions", async () => {
    setColorMode("never");
    const questions: string[] = [];
    const rl = reader("\nn\n");
    const asking = {
      question: async (prompt: string) => {
        questions.push(prompt);
        return rl.question(prompt);
      },
    };
    const flow = createFlow(asking, { rail: false });
    await flow.ask({ label: "S3_ENDPOINT", hint: "empty skips", initial: "x" });
    await flow.confirm("Delete these?", false, "the access keys stop working immediately");
    expect(questions).toEqual([
      "S3_ENDPOINT — empty skips [x]: ",
      "Delete these? (the access keys stop working immediately) [y/N] ",
    ]);
    rl.close();
  });
});

describe("flow on a terminal", () => {
  it("hangs every block off the rail and redraws an answered question under a hollow diamond", async () => {
    setColorMode("never");
    const t = terminal();
    t.flow.intro("millionsend", "setup", "self-host");
    t.flow.note("Every step is offered and skippable.");
    t.flow.list("Plan:", ["IAM user", "SNS topic"]);
    t.flow.step("IAM policy millionsend-ses");
    t.flow.warn("careful");
    const first = t.flow.ask({ label: "APP_BASE_URL", hint: "dashboard origin" });
    expect(t.screen().slice(-2)).toEqual([
      `${RAIL.active}  APP_BASE_URL (dashboard origin)`,
      RAIL.bar,
    ]);
    await t.type("https://mail.example.com\r");
    expect(await first).toBe("https://mail.example.com");
    const second = t.flow.ask({ label: "PUBLIC_API_URL", initial: "" });
    await t.type("\r");
    expect(await second).toBe("");
    t.flow.outro("Done.");
    expect(t.screen()).toEqual([
      `${RAIL.start}   millionsend  setup · self-host`,
      RAIL.bar,
      `${RAIL.bar}  Every step is offered and skippable.`,
      RAIL.bar,
      `${RAIL.done}  Plan:`,
      `${RAIL.bar}  · IAM user`,
      `${RAIL.bar}  · SNS topic`,
      RAIL.bar,
      `${RAIL.done}  IAM policy millionsend-ses`,
      `${RAIL.warn}  careful`,
      RAIL.bar,
      `${RAIL.done}  APP_BASE_URL (dashboard origin)`,
      `${RAIL.bar}  https://mail.example.com`,
      RAIL.bar,
      `${RAIL.done}  PUBLIC_API_URL`,
      `${RAIL.bar}  —`,
      RAIL.bar,
      `${RAIL.end}  Done.`,
    ]);
    t.rl.close();
  });

  describe("erases a question back to its head and no further", () => {
    const answered = (label: string, answer: string) => [
      `${RAIL.done}  ${label}`,
      `${RAIL.bar}  ${answer}`,
      RAIL.bar,
    ];

    it("after a typed answer exactly as wide as the terminal (readline adds a row)", async () => {
      setColorMode("never");
      const t = terminal();
      t.flow.note("above");
      const asked = t.flow.ask({ label: "Q1" });
      await t.type(`${"a".repeat(77)}\r`);
      expect(await asked).toBe("a".repeat(77));
      expect(t.screen()).toEqual([
        `${RAIL.bar}  above`,
        RAIL.bar,
        ...answered("Q1", "a".repeat(77)),
      ]);
      t.rl.close();
    });

    it("after a pasted answer exactly as wide as the terminal (no added row)", async () => {
      setColorMode("never");
      const t = terminal();
      t.flow.note("above");
      const asked = t.flow.ask({ label: "Q1" });
      t.paste(`${"b".repeat(77)}\r`);
      expect(await asked).toBe("b".repeat(77));
      expect(t.screen()).toEqual([
        `${RAIL.bar}  above`,
        RAIL.bar,
        ...answered("Q1", "b".repeat(77)),
      ]);
      t.rl.close();
    });

    it("after a multi-line paste: the lines echoed under the first answer go too", async () => {
      setColorMode("never");
      const t = terminal();
      t.flow.note("above");
      const first = t.flow.ask({ label: "Q1" });
      t.paste("one\rtwo\r");
      expect(await first).toBe("one");
      expect(await t.flow.ask({ label: "Q2" })).toBe("two");
      expect(t.screen()).toEqual([
        `${RAIL.bar}  above`,
        RAIL.bar,
        ...answered("Q1", "one"),
        ...answered("Q2", "two"),
      ]);
      t.rl.close();
    });

    it("after Ctrl-D, which answers this and every later question with its default", async () => {
      setColorMode("never");
      const t = terminal();
      t.flow.note("above");
      const first = t.flow.ask({ label: "Q1", initial: "d1" });
      await t.type("\x04");
      expect(await first).toBe("d1");
      expect(await t.flow.ask({ label: "Q2", initial: "d2" })).toBe("d2");
      expect(t.screen()).toEqual([
        `${RAIL.bar}  above`,
        RAIL.bar,
        ...answered("Q1", "d1"),
        ...answered("Q2", "d2"),
      ]);
      t.rl.close();
    });

    it("when a default too long to wrap makes the head take more rows than lines", async () => {
      setColorMode("never");
      const t = terminal();
      t.flow.note("above");
      const key = "k".repeat(120);
      const asked = t.flow.ask({ label: "SECRET", initial: key });
      await t.type("\r");
      expect(await asked).toBe(key);
      const shown = t.screen();
      expect(shown.slice(0, 3)).toEqual([`${RAIL.bar}  above`, RAIL.bar, `${RAIL.done}  SECRET`]);
      expect(shown.some((row) => row.startsWith(RAIL.active))).toBe(false);
      t.rl.close();
    });
  });

  it("wraps long text under the rail instead of letting the terminal break it", () => {
    setColorMode("never");
    const { out, text } = screen();
    const flow = createFlow({ question: async () => "" }, { rail: true, out });
    flow.note("word ".repeat(40).trim());
    const rows = text()
      .split("\n")
      .filter((row) => row.startsWith(`${RAIL.bar}  word`));
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(80);
  });

  it("does not slice into the bar's SGR when colors are on", () => {
    setColorMode("always");
    const { out, text } = screen();
    const flow = createFlow({ question: async () => "" }, { rail: true, out });
    flow.step("created");
    flow.warn("careful");
    flow.error("boom");
    const shown = text();
    expect(shown).not.toContain("  m│");
    expect(shown).toContain("\x1b[2m◇\x1b[22m  created\n");
    expect(shown).toContain("\x1b[33m▲\x1b[39m  careful\n");
    expect(shown).toContain("\x1b[31m■\x1b[39m  boom\n");
  });

  it("keeps the colored hanging bar intact on a wrapped step", () => {
    setColorMode("always");
    const chunks: string[] = [];
    const out = {
      columns: 40,
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
    } as unknown as NodeJS.WriteStream;
    const flow = createFlow({ question: async () => "" }, { rail: true, out });
    flow.step("word ".repeat(20).trim());
    const shown = chunks.join("");
    expect(shown).not.toContain("  m│");
    expect(shown.split("\n").filter((row) => row.includes("word")).length).toBeGreaterThan(1);
    expect(shown).toContain("\x1b[2m│\x1b[22m  word");
  });

  it("wraps a long ask head under the rail and erases it by row count", async () => {
    setColorMode("never");
    const t = terminal(40);
    t.flow.note("above");
    const asked = t.flow.ask({
      label: "APP_BASE_URL",
      hint: "the URL the dashboard is opened at; an https URL also gets SES events pushed",
      initial: "http://localhost:3000",
    });
    const head = t.screen().slice(2);
    expect(head.length).toBeGreaterThan(1);
    for (const row of head) expect(row.length).toBeLessThanOrEqual(40);
    await t.type("https://mail.example.com\r");
    expect(await asked).toBe("https://mail.example.com");
    const shown = t.screen();
    expect(shown.slice(0, 2)).toEqual([`${RAIL.bar}  above`, RAIL.bar]);
    expect(shown[2]).toMatch(/^◇ {2}APP_BASE_URL \(the URL/);
    expect(shown.some((row) => row.startsWith(RAIL.active))).toBe(false);
    expect(shown).toContain(`${RAIL.bar}  https://mail.example.com`);
    t.rl.close();
  });

  it("shows the default on the rail head before the operator types", async () => {
    setColorMode("never");
    const { out, text } = screen();
    const rl = reader("\n");
    const flow = createFlow(rl, { rail: true, out });
    expect(
      await flow.ask({
        label: "APP_BASE_URL",
        hint: "dashboard origin",
        initial: "http://localhost:3000",
      }),
    ).toBe("http://localhost:3000");
    expect(text()).toContain(
      `${RAIL.active}  APP_BASE_URL (dashboard origin) [http://localhost:3000]`,
    );
    rl.close();
  });

  it("keeps leading indent on verbatim snippets", () => {
    setColorMode("never");
    const { out, text } = screen();
    const flow = createFlow({ question: async () => "" }, { rail: true, out });
    flow.note("    location = /ses/events { proxy_pass http://127.0.0.1:3001; }");
    expect(text()).toContain(
      `${RAIL.bar}      location = /ses/events { proxy_pass http://127.0.0.1:3001; }`,
    );
  });

  it("wraps to the output stream's width", () => {
    setColorMode("never");
    const chunks: string[] = [];
    const out = {
      columns: 40,
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
    } as unknown as NodeJS.WriteStream;
    const flow = createFlow({ question: async () => "" }, { rail: true, out });
    flow.note("word ".repeat(20).trim());
    const rows = chunks
      .join("")
      .split("\n")
      .filter((row) => row.startsWith(`${RAIL.bar}  word`));
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(40);
  });
});
