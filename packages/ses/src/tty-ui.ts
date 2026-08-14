import { emitKeypressEvents } from "node:readline";

/** Structural subset of setup-cli's lineReader — the non-TTY fallback asker. */
export interface Asker {
  question(prompt: string): Promise<string>;
}

const colorOn = (): boolean => process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

/** Gray — secondary text. No-op when piped or NO_COLOR is set. */
export const dim = (s: string): string => (colorOn() ? `\x1b[90m${s}\x1b[39m` : s);
/** Bone-bright white — the selected row. */
export const bone = (s: string): string => (colorOn() ? `\x1b[97m${s}\x1b[39m` : s);
/** Steel blue — the single banner accent. */
export const steel = (s: string): string => (colorOn() ? `\x1b[38;5;153m${s}\x1b[39m` : s);

/**
 * Two-row block glyphs for the banner. Both rows of a glyph must be the same
 * width — the banner tests assert row widths line up per word.
 */
const GLYPHS: Record<string, [string, string]> = {
  M: ["█▀▄▀█", "█ ▀ █"],
  I: ["█", "█"],
  L: ["█  ", "█▄▄"],
  O: ["█▀█", "█▄█"],
  N: ["█▄ █", "█ ▀█"],
  S: ["█▀", "▄█"],
  E: ["█▀▀", "██▄"],
  D: ["█▀▄", "█▄▀"],
};

function word(text: string): [string, string] {
  const glyphs = [...text].map((c) => GLYPHS[c] ?? [" ", " "]);
  return [glyphs.map((g) => g[0]).join(" "), glyphs.map((g) => g[1]).join(" ")];
}

/**
 * Plain (uncolored) banner art: "MILLIONSEND" as one row pair when it fits
 * `width`, else "MILLION" stacked over "SEND". Pure so width logic is testable.
 */
export function bannerLines(width: number): string[] {
  const wide = word("MILLIONSEND");
  if (wide[0].length <= width) return wide;
  return [...word("MILLION"), ...word("SEND")];
}

/**
 * Colored banner art. The M's left stem stays steel-bright against the dim
 * body — the "1" hiding in MillionSend's M.
 */
export function banner(width: number): string[] {
  const lines = bannerLines(width);
  return lines.map((line, i) => {
    const hasStem = lines.length === 2 || i < 2;
    return hasStem ? steel(line[0] ?? "") + dim(line.slice(1)) : dim(line);
  });
}

export interface SelectOption {
  value: string;
  label: string;
  hint?: string;
}

/**
 * Arrow-key list prompt on a TTY; on pipes it degrades to a plain
 * `label [initial]: ` question via `rl` so piped input behaves exactly like
 * the free-form prompt it replaces (typed value, or the initial on empty/EOF).
 * `initial` may be a value outside `options` — pipes accept it verbatim, the
 * TTY cursor just starts at the first option.
 */
export async function selectPrompt(
  rl: Asker,
  { label, options, initial }: { label: string; options: SelectOption[]; initial?: string },
): Promise<string> {
  const fallback = initial ?? options[0]?.value ?? "";
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    const answer = (await rl.question(`${label} [${fallback}]: `)).trim();
    return answer || fallback;
  }
  return selectTty(label, options, fallback);
}

function selectTty(label: string, options: SelectOption[], initial: string): Promise<string> {
  const { stdin, stdout } = process;
  emitKeypressEvents(stdin);
  // The CLI's readline interface also consumes keypresses (it would queue
  // Enter as an empty answered line); park its listeners for the duration.
  const parked = stdin.rawListeners("keypress");
  stdin.removeAllListeners("keypress");
  const wasRaw = stdin.isRaw === true;
  stdin.setRawMode(true);
  stdin.resume();

  let index = Math.max(
    0,
    options.findIndex((o) => o.value === initial),
  );
  const height = options.length + 1;
  const render = (first: boolean): void => {
    if (!first) stdout.write(`\x1b[${height}A`);
    stdout.write("\x1b[J");
    const rows = options.map((o, i) => {
      const hint = o.hint ? ` ${dim(`(${o.hint})`)}` : "";
      return i === index ? bone(`❯ ${o.label}`) + hint : dim(`  ${o.label}`) + hint;
    });
    stdout.write(`${label}\n${rows.join("\n")}\n`);
  };

  return new Promise((resolve) => {
    const done = (value: string | undefined): void => {
      stdin.removeListener("keypress", onKey);
      process.removeListener("SIGINT", onSigint);
      for (const listener of parked) stdin.on("keypress", listener as (...args: unknown[]) => void);
      if (!wasRaw) stdin.setRawMode(false);
      stdout.write(`\x1b[${height}A\x1b[J\x1b[?25h`);
      if (value === undefined) {
        // Ctrl-C/SIGINT mid-select: leave the terminal sane, exit like SIGINT.
        stdin.setRawMode(false);
        stdout.write("\n");
        process.exit(130);
      }
      stdout.write(`${label}: ${value}\n`);
      resolve(value);
    };
    // Raw mode swallows Ctrl-C as a keypress, but an external `kill -INT`
    // still lands as a signal; restore the terminal before dying either way.
    const onSigint = (): void => done(undefined);
    process.once("SIGINT", onSigint);
    const onKey = (_: string | undefined, key: { name?: string; ctrl?: boolean } = {}): void => {
      if (key.ctrl === true && key.name === "c") {
        done(undefined);
      } else if (key.name === "up") {
        index = (index + options.length - 1) % options.length;
        render(false);
      } else if (key.name === "down") {
        index = (index + 1) % options.length;
        render(false);
      } else if (key.name === "return") {
        done(options[index]?.value ?? initial);
      }
    };
    stdout.write("\x1b[?25l");
    render(true);
    stdin.on("keypress", onKey);
  });
}
