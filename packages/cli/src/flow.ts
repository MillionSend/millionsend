import {
  badge,
  bold,
  dim,
  err,
  info,
  layoutWidth,
  warn as warnColor,
  wrapIndent,
} from "./theme.js";
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
 * On a pipe the same calls print plain lines and the classic
 * `label [default]: ` questions, byte for byte what scripted runs expect.
 */
export function createFlow(
  rl: Asker,
  opts: { rail?: boolean; out?: NodeJS.WriteStream } = {},
): Flow {
  const rail = opts.rail ?? isInteractive();
  const out = opts.out ?? process.stdout;
  const columns = (): number => out.columns ?? 80;
  const bar = (): string => dim(RAIL.bar);
  const write = (text: string): void => {
    out.write(`${text}\n`);
  };
  // Wrapped to the layout width minus the rail, every line prefixed with it.
  const railed = (text: string, style: (s: string) => string = (s) => s): string[] =>
    text
      .split("\n")
      .flatMap((paragraph) =>
        paragraph === "" ? [""] : wrapIndent(paragraph, { width: layoutWidth() - 3 }).split("\n"),
      )
      .map((line) => `${bar()}  ${style(line)}`);
  const marked = (glyph: string, text: string, style: (s: string) => string = (s) => s): void => {
    const [first = "", ...rest] = railed(text, style);
    write(`${glyph}  ${first.slice(visible(bar()) + 2)}`);
    for (const line of rest) write(line);
  };
  const plain = (text: string): void => {
    for (const line of text.split("\n")) console.log(line);
  };

  const answered = (label: string, answer: string, hint?: string): void => {
    write(`${dim(RAIL.done)}  ${label}${hint ? dim(` (${hint})`) : ""}`);
    write(`${bar()}  ${dim(answer)}`);
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
          width: layoutWidth() - 3,
          indent: "· ",
          hanging: "  ",
        }).split("\n");
        for (const row of wrapped) write(`${bar()}  ${row}`);
      }
      write(bar());
    },
    async ask({ label, hint, initial, secret = false }) {
      if (!rail) {
        const question = `${label}${initial ? ` [${initial}]` : ""}: `;
        const raw = secret ? await secretPrompt(rl, { label }) : await rl.question(question);
        return raw.trim() || initial || "";
      }
      const head = `${info(RAIL.active)}  ${bold(label)}${hint ? dim(` (${hint})`) : ""}`;
      write(head);
      if (secret) {
        const value = await secretPrompt(rl, { label, rail: true });
        // secretPrompt drew its own two rows under the head.
        out.write(`\x1b[${rowsFor([head], columns()) + 2}A\x1b[J`);
        answered(label, value ? "••••" : initial || "—", hint);
        return value || initial || "";
      }
      const prompt = `${bar()}  `;
      const raw = await rl.question(prompt);
      const answer = raw.trim() || initial || "";
      out.write(`\x1b[${rowsFor([head, `${prompt}${raw}`], columns())}A\x1b[J`);
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
        return yes(await rl.question(`${label} ${initial ? "[Y/n]" : "[y/N]"} `), initial);
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

/** Characters the terminal shows, SGR sequences removed. */
function visible(s: string): number {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: SGR escapes are what is stripped
  return [...s.replace(/\x1b\[[0-9;]*m/g, "")].length;
}
