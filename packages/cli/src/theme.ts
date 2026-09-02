import { visibleLength } from "./tty-ui.js";

export type ColorMode = "auto" | "always" | "never";

export const COLOR_MODES: readonly ColorMode[] = ["auto", "always", "never"];

let mode: ColorMode = "auto";
let streamTty: boolean | undefined;

/**
 * `--color`, and whether the stream the human lines go to is a terminal
 * (stderr under --json); without it, auto looks at process.stdout. The
 * wrappers below read both at call time.
 */
export function setColorMode(next: ColorMode, tty?: boolean): void {
  mode = next;
  streamTty = tty;
}

/**
 * auto = the output stream is a terminal and NO_COLOR is unset; FORCE_COLOR
 * (any value but "0") wins over both, so a colored transcript can be captured
 * through a pipe.
 */
export function colorEnabled(): boolean {
  if (mode !== "auto") return mode === "always";
  const force = process.env.FORCE_COLOR;
  if (force !== undefined && force !== "" && force !== "0") return true;
  return (streamTty ?? process.stdout.isTTY === true) && process.env.NO_COLOR === undefined;
}

// Only the 16 standard colors plus bold/dim: every terminal theme renders them.
const sgr =
  (on: string, off: string) =>
  (s: string): string =>
    colorEnabled() ? `\x1b[${on}m${s}\x1b[${off}m` : s;

export const ok = sgr("32", "39");
export const warn = sgr("33", "39");
export const err = sgr("31", "39");
export const info = sgr("36", "39");
export const note = sgr("35", "39");
/** Secondary text. */
export const dim = sgr("2", "22");
/** Reserved for numbers and the one thing to act on — never a whole paragraph. */
export const bold = sgr("1", "22");
/** Bold bright white. */
export const accent = sgr("1;97", "22;39");
/** Bright white — the selected row in a list prompt. */
export const bone = sgr("97", "39");

export const SYM = {
  ok: "✓",
  err: "✗",
  live: "⟳",
  note: "!",
  create: "+",
  update: "~",
  same: "=",
  manual: "!",
  skip: "−",
} as const;

/** Lines are composed at this width, never left to the terminal to break mid-word. */
export const layoutWidth = (): number => Math.min(process.stdout.columns ?? 80, 100);

/**
 * Greedy word wrap: the first line starts with `indent`, the rest with
 * `hanging` (defaults to `indent`). A word longer than the width stays whole
 * on its own line; ANSI sequences do not count toward the width.
 */
export function wrapIndent(
  text: string,
  {
    width = layoutWidth(),
    indent = "",
    hanging = indent,
  }: { width?: number; indent?: string; hanging?: string } = {},
): string {
  const lines: string[] = [];
  let line = indent;
  let empty = true;
  for (const word of text.split(/\s+/).filter((w) => w !== "")) {
    if (!empty && visibleLength(line) + 1 + visibleLength(word) > width) {
      lines.push(line);
      line = hanging;
      empty = true;
    }
    line += empty ? word : ` ${word}`;
    empty = false;
  }
  lines.push(line);
  return lines.join("\n");
}

/** Bold title over a dim rule the layout width long. */
export const heading = (title: string): string =>
  `${bold(title)}\n${dim("─".repeat(layoutWidth()))}`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `05cda767-…` → `05cda767…`; anything that is not a UUID is returned as is. */
export const shortId = (id: string): string => (UUID_RE.test(id) ? `${id.slice(0, 8)}…` : id);

export const VALUE_WIDTH = 7;

/** Labels padded to the longest, values right-aligned in a `valueWidth` column (7 by default); ANSI excluded from widths. */
export function column(
  rows: readonly (readonly [string, string])[],
  valueWidth = VALUE_WIDTH,
): string[] {
  const width = Math.max(0, ...rows.map(([label]) => visibleLength(label)));
  return rows.map(
    ([label, value]) =>
      `${label}${" ".repeat(width - visibleLength(label))} ${" ".repeat(Math.max(0, valueWidth - visibleLength(value)))}${value}`,
  );
}
