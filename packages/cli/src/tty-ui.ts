import { createInterface, emitKeypressEvents } from "node:readline";
import { stripControl, truncate } from "./utils.js";

/** Structural subset of lineReader — the non-TTY fallback asker every prompt degrades to. */
export interface Asker {
  question(prompt: string): Promise<string>;
}

/**
 * readline/promises' question() drops lines that arrive while no question is
 * pending, so piping all answers at once (`printf 'a\nb\n' | cli`) loses every
 * answer after the first and the next question hangs forever. This reader
 * queues every line as it arrives; question() consumes the queue, and EOF
 * resolves pending/future questions with "" (the "accept default" answer).
 * Ctrl-C on a terminal closes the interface (raw mode off) and exits 130;
 * without a listener readline would close silently and the "" answer would
 * let the caller carry on with defaults after an interrupt.
 */
export function lineReader(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
) {
  const rl = createInterface({ input, output });
  const queue: string[] = [];
  let waiting: ((line: string) => void) | undefined;
  let ended = false;
  rl.on("line", (line) => {
    if (waiting) {
      const resolve = waiting;
      waiting = undefined;
      resolve(line);
    } else {
      queue.push(line);
    }
  });
  rl.on("close", () => {
    ended = true;
    if (waiting) {
      const resolve = waiting;
      waiting = undefined;
      resolve("");
    }
  });
  rl.on("SIGINT", () => {
    rl.close();
    output.write("\n");
    process.exit(130);
  });
  return {
    question(prompt: string): Promise<string> {
      // Hand the prompt to readline instead of writing it to output directly:
      // on a TTY, readline repaints the line on every edit (backspace, arrows)
      // using only the prompt it was given, so a prompt it never saw gets
      // erased down to nothing on the first backspace. On non-TTY output
      // rl.prompt() writes the prompt text verbatim — piped bytes unchanged.
      // After EOF readline has closed itself and prompt() would throw; the
      // direct write keeps the prompt-then-"" contract byte-identical.
      if (ended) {
        output.write(prompt);
      } else {
        rl.setPrompt(prompt);
        rl.prompt();
      }
      const line = queue.shift();
      if (line !== undefined) return Promise.resolve(line);
      if (ended) return Promise.resolve("");
      return new Promise((resolve) => {
        waiting = resolve;
      });
    },
    close() {
      rl.close();
    },
  };
}

export type LineReader = ReturnType<typeof lineReader>;

/** Both ends are terminals: arrow-key and masked prompts are possible. */
export const isInteractive = (): boolean =>
  process.stdin.isTTY === true && process.stdout.isTTY === true;

/**
 * Masking needs raw mode, a property of stdin alone. When stdout is a pipe the
 * prompt and the masked echo go to stderr, so the key never lands in the piped
 * output and the terminal driver never echoes it in cleartext.
 */
export const secretPromptMode = (
  stdinTty: boolean,
  stdoutTty: boolean,
): { masked: boolean; toStderr: boolean } => ({
  masked: stdinTty,
  toStderr: stdinTty && !stdoutTty,
});

/** `Domain limit: first 3` — or `Where is it running? — Cloud` when the label is a question. */
export const answerLine = (label: string, answer: string): string =>
  `${label}${label.endsWith("?") ? " — " : ": "}${answer}`;

/** Characters the terminal shows: SGR sequences removed, code points counted. */
export const visibleLength = (s: string): number => [...stripControl(s)].length;

/** Terminal rows `lines` occupy at `columns` wide; a row wraps every `columns` cells, an empty line still takes one. */
export const rowsFor = (lines: readonly string[], columns: number): number =>
  lines.reduce((sum, line) => sum + Math.max(1, Math.ceil(visibleLength(line) / columns)), 0);

const colorOn = (): boolean => process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

/** Gray — secondary text. No-op when piped or NO_COLOR is set. */
export const dim = (s: string): string => (colorOn() ? `\x1b[90m${s}\x1b[39m` : s);
/** Bone-bright white — the selected row. */
export const bone = (s: string): string => (colorOn() ? `\x1b[97m${s}\x1b[39m` : s);

/**
 * Final hand-tuned banner art, stored verbatim — ▓ marks the M's stem accent,
 * ░ the shadow. Every row of an art is the same visual width; the tests pin
 * 6×74 (full) and 3×44 (compact).
 */
const FULL_ART: string[] = [
  "▓▓▄ ▄██ ████ ██    ██    ████ ▄█████▄ ██▄  ██ ▄█████ █████ ██▄  ██ █████▄ ",
  "▓▓▀▄▀██░ ██░░██░   ██░    ██░░██░░░██░██▀▄ ██░██░░░░░██░░░░██▀▄ ██░██░░██░",
  "▓▓░▀░██░ ██░ ██░   ██░    ██░ ██░  ██░██░▀▄██░▀████▄ ████  ██░▀▄██░██░ ██░",
  "▓▓░ ░██░ ██░ ██░   ██░    ██░ ██░  ██░██░ ▀██░ ░░░██░██░░░ ██░ ▀██░██░ ██░",
  "▓▓░  ██░████ █████ █████ ████ ▀█████▀░██░  ██░█████▀░█████ ██░  ██░█████▀░",
  " ░░   ░░ ░░░░ ░░░░░ ░░░░░ ░░░░ ░░░░░░░ ░░   ░░ ░░░░░░ ░░░░░ ░░   ░░ ░░░░░░",
];

const COMPACT_ART: string[] = [
  "▓▄ ▄█ █ █   █   █ ▄▀▀▄ █▄ █ █▀▀ █▀▀ █▄ █ █▀▄",
  "▓ ▀ █ █ █   █   █ █  █ █ ▀█ ▀▀█ █▀▀ █ ▀█ █ █",
  "▓   █ █ █▄▄ █▄▄ █ ▀▄▄▀ █  █ ▄▄█ █▄▄ █  █ █▄▀",
];

export type BannerTier = "full" | "compact" | "plain";

/**
 * Which banner fits: the full art needs 80 columns, the compact one 48;
 * anything narrower — or a pipe — gets the plain one-line header, keeping
 * piped output byte-identical to the pre-banner CLI.
 */
export function pickBannerTier(columns: number, isTTY: boolean): BannerTier {
  if (!isTTY || columns < 48) return "plain";
  return columns >= 80 ? "full" : "compact";
}

/** Uncolored banner art rows for a tier. Pure so it is testable. */
export function bannerLines(tier: "full" | "compact" = "full"): string[] {
  return tier === "full" ? FULL_ART : COMPACT_ART;
}

/**
 * Banner art, uncolored: the ▓ stem and ░ shadow carry the tones through
 * character density alone — terminal color themes made ANSI tinting read
 * wrong more often than right.
 */
export function banner(tier: "full" | "compact" = "full"): string[] {
  return bannerLines(tier);
}

/** Greedy word wrap; single words longer than width stay unbroken. */
export function wrapText(text: string, width: number): string {
  const lines: string[] = [];
  for (const word of text.split(/\s+/)) {
    const last = lines[lines.length - 1];
    if (last !== undefined && `${last} ${word}`.length <= width) {
      lines[lines.length - 1] = `${last} ${word}`;
    } else {
      lines.push(word);
    }
  }
  return lines.join("\n");
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
  if (!isInteractive()) {
    const answer = (await rl.question(`${label} [${fallback}]: `)).trim();
    return answer || fallback;
  }
  return selectTty(label, options, fallback);
}

interface Key {
  name?: string;
  ctrl?: boolean;
  sequence?: string;
}

/** \r is "return", \n is "enter" — pasted input and some terminals send the latter. */
const isEnter = (key: Key): boolean => key.name === "return" || key.name === "enter";

/**
 * A raw-mode keypress session: `onKey` returns the result to finish with, or
 * undefined to keep reading; `erase` removes whatever the prompt drew, and
 * runs before the cursor is shown again. Ctrl-C (a keypress in raw mode) and
 * an external SIGINT both restore the terminal and exit 130.
 */
function readKeys<T>(
  onKey: (str: string | undefined, key: Key) => T | undefined,
  erase: () => void,
  stdout: NodeJS.WritableStream = process.stdout,
): Promise<T> {
  const { stdin } = process;
  emitKeypressEvents(stdin);
  // The CLI's readline interface also consumes keypresses (it would queue
  // Enter as an empty answered line); park its listeners for the duration.
  const parked = stdin.rawListeners("keypress");
  stdin.removeAllListeners("keypress");
  const wasRaw = stdin.isRaw === true;
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve) => {
    const done = (value: T | undefined): void => {
      stdin.removeListener("keypress", listener);
      process.removeListener("SIGINT", onSigint);
      for (const l of parked) stdin.on("keypress", l as (...args: unknown[]) => void);
      if (!wasRaw) stdin.setRawMode(false);
      erase();
      stdout.write("\x1b[?25h");
      if (value === undefined) {
        stdin.setRawMode(false);
        stdout.write("\n");
        process.exit(130);
      }
      resolve(value);
    };
    const onSigint = (): void => done(undefined);
    process.once("SIGINT", onSigint);
    const listener = (str: string | undefined, key: Key = {}): void => {
      if (key.ctrl === true && key.name === "c") done(undefined);
      else {
        const value = onKey(str, key);
        if (value !== undefined) done(value);
      }
    };
    stdin.on("keypress", listener);
  });
}

/** Cursor-up `height` rows and clear to the end of the screen. */
const eraseRows = (height: number): void => {
  process.stdout.write(`\x1b[${height}A\x1b[J`);
};

const terminalColumns = (): number => process.stdout.columns ?? 80;

/**
 * One option row, cut to `columns - 1` so it never wraps (a wrapped row
 * would throw the in-place redraw off by one). The hint is cut before the
 * label; the label keeps its own color, the hint is dim.
 */
export function optionRow(
  prefix: string,
  { label, hint }: SelectOption,
  selected: boolean,
  columns: number,
): string {
  const text = truncate(`${label}${hint ? ` (${hint})` : ""}`, columns - 1 - [...prefix].length);
  const head = text.slice(0, label.length);
  const tail = text.slice(label.length);
  return `${(selected ? bone : dim)(`${prefix}${head}`)}${tail ? dim(tail) : ""}`;
}

async function selectTty(label: string, options: SelectOption[], initial: string): Promise<string> {
  const { stdout } = process;
  let index = Math.max(
    0,
    options.findIndex((o) => o.value === initial),
  );
  let height = 0;
  const render = (first: boolean): void => {
    if (!first) eraseRows(height);
    const columns = terminalColumns();
    const lines = [
      label,
      ...options.map((o, i) => optionRow(i === index ? "❯ " : "  ", o, i === index, columns)),
    ];
    height = rowsFor(lines, columns);
    stdout.write(`${lines.join("\n")}\n`);
  };
  stdout.write("\x1b[?25l");
  render(true);
  const value = await readKeys<string>(
    (_, key) => {
      if (key.name === "up") {
        index = (index + options.length - 1) % options.length;
        render(false);
      } else if (key.name === "down") {
        index = (index + 1) % options.length;
        render(false);
      } else if (isEnter(key)) {
        return options[index]?.value ?? initial;
      }
      return undefined;
    },
    () => eraseRows(height),
  );
  const chosen = options.find((o) => o.value === value)?.label ?? value;
  stdout.write(`${answerLine(label, chosen)}\n`);
  return value;
}

export interface MultiSelectOption extends SelectOption {
  checked?: boolean;
}

/**
 * Checkbox list on a TTY (space toggles, a toggles all, enter confirms);
 * on pipes a `label [a,b]: ` question answered with a comma list of values,
 * empty meaning the defaults. Returns the chosen values in option order;
 * values outside `options` are dropped, so callers see the same set of
 * possible answers on both paths.
 */
export async function multiSelectPrompt(
  rl: Asker,
  { label, options }: { label: string; options: MultiSelectOption[] },
): Promise<string[]> {
  const defaults = options.filter((o) => o.checked === true).map((o) => o.value);
  if (!isInteractive()) {
    const answer = (await rl.question(`${label} [${defaults.join(",")}]: `)).trim();
    if (answer === "") return defaults;
    const typed = new Set(answer.split(",").map((v) => v.trim()));
    return options.filter((o) => typed.has(o.value)).map((o) => o.value);
  }
  return multiSelectTty(label, options);
}

async function multiSelectTty(label: string, options: MultiSelectOption[]): Promise<string[]> {
  const { stdout } = process;
  const checked = options.map((o) => o.checked === true);
  let index = 0;
  let height = 0;
  const render = (first: boolean): void => {
    if (!first) eraseRows(height);
    const columns = terminalColumns();
    const lines = [
      `${label} ${dim("space toggles · a toggles all · enter confirms")}`,
      ...options.map((o, i) =>
        optionRow(
          `${i === index ? "❯" : " "} ${checked[i] ? "[x]" : "[ ]"} `,
          o,
          i === index,
          columns,
        ),
      ),
    ];
    height = rowsFor(lines, columns);
    stdout.write(`${lines.join("\n")}\n`);
  };
  stdout.write("\x1b[?25l");
  render(true);
  const values = await readKeys<string[]>(
    (str, key) => {
      if (key.name === "up") {
        index = (index + options.length - 1) % options.length;
      } else if (key.name === "down") {
        index = (index + 1) % options.length;
      } else if (key.name === "space") {
        checked[index] = !checked[index];
      } else if (str === "a") {
        const all = checked.every(Boolean);
        checked.fill(!all);
      } else if (isEnter(key)) {
        return options.filter((_, i) => checked[i]).map((o) => o.value);
      } else {
        return undefined;
      }
      render(false);
      return undefined;
    },
    () => eraseRows(height),
  );
  const labels = options.filter((o) => values.includes(o.value)).map((o) => o.label);
  stdout.write(`${answerLine(label, labels.length > 0 ? labels.join(", ") : "none")}\n`);
  return values;
}

/** `re_****…ab12` — enough to recognise a key, never enough to use it. */
export function maskSecret(secret: string): string {
  return secret.length >= 12 ? `${secret.slice(0, 3)}****…${secret.slice(-4)}` : "****";
}

/**
 * Secret entry without echo when stdin is a terminal (backspace edits, enter
 * confirms); the masked value is printed afterwards so the transcript shows
 * which key was used. With stdin piped, a plain `label: ` question.
 */
export async function secretPrompt(rl: Asker, { label }: { label: string }): Promise<string> {
  const mode = secretPromptMode(process.stdin.isTTY === true, process.stdout.isTTY === true);
  if (!mode.masked) return (await rl.question(`${label}: `)).trim();
  const stdout = mode.toStderr ? process.stderr : process.stdout;
  stdout.write(`${label}: `);
  let value = "";
  const secret = await readKeys<string>(
    (str, key) => {
      if (isEnter(key)) return value.trim();
      if (key.name === "backspace" || key.name === "delete") value = value.slice(0, -1);
      else if (str !== undefined && key.ctrl !== true && str >= " ") value += str;
      return undefined;
    },
    () => stdout.write("\r\x1b[2K"),
    stdout,
  );
  stdout.write(`${label}: ${maskSecret(secret)}\n`);
  return secret;
}

/** `label (y/N)` on every path; enter takes `initial`. */
export async function confirmPrompt(
  rl: Asker,
  { label, initial = false }: { label: string; initial?: boolean },
): Promise<boolean> {
  const answer = (await rl.question(`${label} ${initial ? "(Y/n)" : "(y/N)"} `))
    .trim()
    .toLowerCase();
  if (answer === "") return initial;
  return answer === "y" || answer === "yes";
}

/**
 * Free-form line; empty takes `initial`. `validate` returns an error message
 * to re-ask on a terminal — on a pipe there is nobody to re-ask, so the
 * message is thrown for the caller to turn into exit 1.
 */
export async function textPrompt(
  rl: Asker,
  {
    label,
    initial,
    validate,
  }: { label: string; initial?: string; validate?: (value: string) => string | undefined },
): Promise<string> {
  for (;;) {
    const answer = (await rl.question(`${label}${initial ? ` [${initial}]` : ""}: `)).trim();
    const value = answer || initial || "";
    const error = validate?.(value);
    if (error === undefined) return value;
    if (!isInteractive()) throw new Error(`${label}: ${error}`);
    process.stdout.write(`${error}\n`);
  }
}
