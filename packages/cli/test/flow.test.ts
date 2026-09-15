import { PassThrough } from "node:stream";
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
});

describe("flow on a terminal", () => {
  it("hangs every block off the rail and redraws an answered question under a hollow diamond", async () => {
    setColorMode("never");
    const { out, text } = screen();
    const rl = reader("https://mail.example.com\n\n");
    const flow = createFlow(rl, { rail: true, out });
    flow.intro("millionsend", "setup", "self-host");
    flow.note("Every step is offered and skippable.");
    flow.list("Plan:", ["IAM user", "SNS topic"]);
    flow.step("IAM policy millionsend-ses");
    flow.warn("careful");
    expect(await flow.ask({ label: "APP_BASE_URL", hint: "dashboard origin" })).toBe(
      "https://mail.example.com",
    );
    expect(await flow.ask({ label: "PUBLIC_API_URL", initial: "" })).toBe("");
    flow.outro("Done.");
    const shown = text();
    expect(shown).toContain(`${RAIL.start}   millionsend  setup · self-host`);
    expect(shown).toContain(`${RAIL.bar}  Every step is offered and skippable.`);
    expect(shown).toContain(
      `${RAIL.done}  Plan:\n${RAIL.bar}  · IAM user\n${RAIL.bar}  · SNS topic`,
    );
    expect(shown).toContain(`${RAIL.done}  IAM policy millionsend-ses`);
    expect(shown).toContain(`${RAIL.warn}  careful`);
    // The active question, then the redraw: cursor up over the two rows, the
    // hollow diamond, the answer on the rail.
    expect(shown).toContain(`${RAIL.active}  APP_BASE_URL (dashboard origin)\n`);
    expect(shown).toContain("\x1b[2A\x1b[J");
    expect(shown).toContain(
      `${RAIL.done}  APP_BASE_URL (dashboard origin)\n${RAIL.bar}  https://mail.example.com\n${RAIL.bar}\n`,
    );
    expect(shown).toContain(`${RAIL.done}  PUBLIC_API_URL\n${RAIL.bar}  —\n`);
    expect(shown).toContain(`${RAIL.end}  Done.\n`);
    rl.close();
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
});
