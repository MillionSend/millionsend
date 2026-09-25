import { badge, bold, dim, err, info, warn as warnColor, wrapIndent } from "./theme.js";
import {
  type Asker,
  isInteractive,
  rowsFor,
  type SelectOption,
  secretPrompt,
  selectPrompt,
} from "./tty-ui.js";

/** Glyphs of a guided flow: a rail down the left margin, a diamond per step. */
export const RAIL = {
  start: "┌",
  bar: "│",
  end: "└",
  active: "◆",
  done: "◇",
  warn: "▲",
  error: "■",
} as const;

export interface Flow {
  /** Whether the rail is drawn: a terminal on both ends. Piped runs print plain lines. */
  readonly rail: boolean;
  /** `┌  ▌product▐ title · subtitle`, the head of the flow. */
  intro(product: string, title: string, subtitle?: string): void;
  /** Secondary text under the rail. */
  note(text: string): void;
  /** A plain line under the rail. */
  log(text: string): void;
  /** A completed step (`◇  text`), for provisioning progress. */
  step(text: string): void;
  warn(text: string): void;
  error(text: string): void;
  /** A titled bullet list, the plan of what a step is about to do. */
  list(title: string, lines: readonly string[]): void;
  /** A free-form answer; empty takes `initial`. The typed line is redrawn as the step's answer. */
  ask(opts: { label: string; hint?: string; initial?: string; secret?: boolean }): Promise<string>;
  select(opts: { label: string; options: SelectOption[]; initial?: string }): Promise<string>;
  /** Yes/No; Enter takes `initial`. */
  confirm(label: string, initial: boolean, hint?: string): Promise<boolean>;
  /** `└  text`, the end of the flow. */
  outro(text: string): void;
}

/** Bare `y`/`yes` (any case) is yes; empty takes the default; anything else is no. */
const yes = (answer: string, initial: boolean): boolean => {
  const trimmed = answer.trim();
  if (trimmed === "") return initial;
  return /^y(es)?$/i.test(trimmed);
};

/**
 * A guided flow over an Asker. On a terminal every block hangs off one rail
 * (`│`), the active question is a filled diamond and its answer is redrawn
 * under a hollow one, so the transcript reads as a form that was filled in.
 * On a pipe the same calls print plain lines and plain questions
 * (`label — hint [default]: `, `label [y/N] `), one answer per line.
 */
export function createFlow(
  rl: Asker,
  opts: { rail?: boolean; out?: NodeJS.WriteStream } = {},
): Flow {
  const rail = opts.rail ?? isInteractive();
  const out = opts.out ?? process.stdout;
  const columns = (): number => out.columns ?? 80;
  const wrapWidth = (): number => Math.min(columns(), 100) - 3;
  const bar = (): string => dim(RAIL.bar);
  const write = (text: string): void => {
    out.write(`${text}\n`);
  };
  // Leading whitespace is a verbatim snippet (nginx location); wrapIndent would collapse it.
  const wrapLines = (text: string): string[] =>
    text.split("\n").flatMap((paragraph) => {
      if (paragraph === "") return [""];
      if (/^\s/.test(paragraph)) return [paragraph];
      return wrapIndent(paragraph, { width: wrapWidth() }).split("\n");
    });
  const railed = (text: string, style: (s: string) => string = (s) => s): string[] =>
    wrapLines(text).map((line) => `${bar()}  ${style(line)}`);
  /** Writes a glyph-led block; returns the terminal rows it took, a word too long to wrap included. */
  const marked = (glyph: string, text: string, style: (s: string) => string = (s) => s): number => {
    const [first = "", ...rest] = wrapLines(text);
    const rows = [`${glyph}  ${style(first)}`, ...rest.map((line) => `${bar()}  ${style(line)}`)];
    for (const row of rows) write(row);
    return rowsFor(rows, columns());
  };
  const plain = (text: string): void => {
    for (const line of text.split("\n")) console.log(line);
  };

  const answered = (label: string, answer: string, hint?: string): void => {
    marked(dim(RAIL.done), hint ? `${label} (${hint})` : label);
    for (const line of wrapLines(answer || "—")) write(`${bar()}  ${dim(line)}`);
    write(bar());
  };

  return {
    rail,
    intro(product, title, subtitle) {
      if (!rail) {
        console.log(`${bold(`${product} ${title}`)}${subtitle ? ` · ${subtitle}` : ""}`);
        return;
      }
      write(
        `${dim(RAIL.start)}  ${badge(` ${product} `)} ${bold(title)}${subtitle ? dim(` · ${subtitle}`) : ""}`,
      );
      write(bar());
    },
    note(text) {
      if (!rail) {
        plain(dim(text));
        return;
      }
      for (const line of railed(text, dim)) write(line);
      write(bar());
    },
    log(text) {
      if (!rail) {
        plain(text);
        return;
      }
      for (const line of railed(text)) write(line);
    },
    step(text) {
      if (!rail) {
        plain(`${info("==>")} ${text}`);
        return;
      }
      marked(dim(RAIL.done), text);
    },
    warn(text) {
      if (!rail) {
        plain(text);
        return;
      }
      marked(warnColor(RAIL.warn), text);
      write(bar());
    },
    error(text) {
      if (!rail) {
        console.error(text);
        return;
      }
      marked(err(RAIL.error), text);
      write(bar());
    },
    list(title, lines) {
      if (!rail) {
        console.log(bold(title));
        for (const line of lines) console.log(`  · ${line}`);
        return;
      }
      write(`${dim(RAIL.done)}  ${bold(title)}`);
      for (const line of lines) {
        const wrapped = wrapIndent(line, {
          width: wrapWidth(),
          indent: "· ",
          hanging: "  ",
        }).split("\n");
        for (const row of wrapped) write(`${bar()}  ${row}`);
      }
      write(bar());
    },
    async ask({ label, hint, initial, secret = false }) {
      if (!rail) {
        const question = `${label}${hint ? ` — ${hint}` : ""}${initial ? ` [${initial}]` : ""}: `;
        const raw = secret ? await secretPrompt(rl, { label }) : await rl.question(question);
        return raw.trim() || initial || "";
      }
      const extra = `${hint ? ` (${hint})` : ""}${initial ? ` [${initial}]` : ""}`;
      const headRows = marked(info(RAIL.active), `${label}${extra}`);
      if (secret) {
        const value = await secretPrompt(rl, { label, rail: true });
        out.write(`\x1b[${headRows + 2}A\x1b[J`);
        answered(label, value ? "••••" : initial || "—", hint);
        return value || initial || "";
      }
      const raw = await rl.question(`${bar()}  `);
      const answer = raw.trim() || initial || "";
      out.write(`\x1b[${headRows + (rl.rows?.() ?? 0)}A\x1b[J`);
      answered(label, answer || "—", hint);
      return answer;
    },
    select({ label, options, initial }) {
      return selectPrompt(rl, {
        label,
        options,
        ...(initial !== undefined ? { initial } : {}),
        rail,
      });
    },
    async confirm(label, initial, hint) {
      if (!rail) {
        const question = `${label}${hint ? ` (${hint})` : ""} ${initial ? "[Y/n]" : "[y/N]"} `;
        return yes(await rl.question(question), initial);
      }
      const choice = await selectPrompt(rl, {
        label: hint ? `${label} ${dim(`(${hint})`)}` : label,
        initial: initial ? "yes" : "no",
        options: [
          { value: "yes", label: "Yes" },
          { value: "no", label: "No" },
        ],
        rail,
      });
      return choice === "yes";
    },
    outro(text) {
      if (!rail) {
        plain(text);
        return;
      }
      const [first = "", ...rest] = text.split("\n");
      write(`${dim(RAIL.end)}  ${first}`);
      for (const line of rest) write(`   ${line}`);
      write("");
    },
  };
}
