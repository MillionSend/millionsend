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

/**
 * Five-row cell maps for the banner letters ('#' = filled cell). Every row of
 * a letter must be the same width — banner rows are assembled cell by cell and
 * the tests pin that all banner lines come out the same visual width. Five
 * rows give M its peaks and N its diagonal; at one char per cell the full
 * one-line word plus echo stays under 80 cols.
 */
const LETTERS: Record<string, string[]> = {
  M: ["#...#", "##.##", "#.#.#", "#...#", "#...#"],
  I: ["###", ".#.", ".#.", ".#.", "###"],
  L: ["#...", "#...", "#...", "#...", "####"],
  O: [".###.", "#...#", "#...#", "#...#", ".###."],
  N: ["#...#", "##..#", "#.#.#", "#..##", "#...#"],
  S: [".###", "#...", ".##.", "...#", "###."],
  E: ["####", "#...", "###.", "#...", "####"],
  D: ["###.", "#..#", "#..#", "#..#", "###."],
};

const ART_ROWS = 5;

/**
 * Block art for `text`: full-shade body cells with a light-shade echo offset
 * one character right and one row down — a thin drop shadow along each
 * letter's right and bottom edges. Returns ART_ROWS + 1 equal-width lines.
 */
function art(text: string): string[] {
  const grid: boolean[][] = Array.from({ length: ART_ROWS }, () => []);
  const glyphs = [...text].map((c) => LETTERS[c] ?? []);
  glyphs.forEach((glyph, gi) => {
    for (let r = 0; r < ART_ROWS; r++) {
      for (const cell of glyph[r] ?? "") grid[r]?.push(cell === "#");
      if (gi < glyphs.length - 1) grid[r]?.push(false);
    }
  });
  const width = (grid[0]?.length ?? 0) + 1;
  const canvas = Array.from({ length: ART_ROWS + 1 }, () => Array<string>(width).fill(" "));
  const paint = (dr: number, dc: number, ch: string): void => {
    for (let r = 0; r < ART_ROWS; r++) {
      for (let c = 0; c < (grid[r]?.length ?? 0); c++) {
        if (!grid[r]?.[c]) continue;
        const row = canvas[r + dr];
        if (row) row[c + dc] = ch;
      }
    }
  };
  paint(1, 1, "░"); // echo first, body painted over it
  paint(0, 0, "█");
  return canvas.map((row) => row.join(""));
}

/**
 * Plain (uncolored) banner art: MILLIONSEND on a single line, narrow enough
 * (echo included) to never wrap at 80 columns. Every line is the same visual
 * width. Pure so it is testable.
 */
export function bannerLines(): string[] {
  return art("MILLIONSEND");
}

/** Banner art with the echo dimmed — grays only, no-op when piped/NO_COLOR. */
export function banner(): string[] {
  return bannerLines().map((line) => line.replace(/░+/g, (run) => dim(run)));
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
