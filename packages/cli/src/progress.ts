import { formatNumber, sleep } from "./utils.js";

export interface StepHandle {
  update(n: number, total?: number): void;
  done(summary?: string): void;
  fail(message: string): void;
  note(text: string): void;
}

export interface Progress {
  /** Starts a step; steps run one at a time, so a new step ends the live line of the previous one. */
  step(label: string): StepHandle;
  /** A plain line, kept above the live step line. */
  line(text: string): void;
  /**
   * Foreign text (a stderr log line) kept above the live step line: the live
   * line is cleared, `text` written to `to`, the live line redrawn. Both
   * streams share the terminal, so the order of the three writes is the
   * order the user sees.
   */
  writeAbove(text: string, to?: { write(chunk: string): unknown }): void;
  /** Drops the live line without finishing the step — before a fatal error is printed. */
  clear(): void;
}

export interface ProgressOptions {
  stream?: NodeJS.WritableStream | undefined;
  /** Override the stream's own isTTY (tests). */
  tty?: boolean | undefined;
}

const isTty = (stream: NodeJS.WritableStream): boolean =>
  (stream as { isTTY?: boolean }).isTTY === true;

/**
 * One line per step: `⟳ Contacts 3,200/12,847` rewritten in place on a TTY,
 * appended on done/fail and every 1,000 units when piped. Markers: ✓ done,
 * ✗ failed, ⟳ running, ! note.
 */
export function createProgress({
  stream = process.stdout,
  tty = isTty(stream),
}: ProgressOptions = {}): Progress {
  let live: string | null = null;
  const writeAbove = (text: string, to: { write(chunk: string): unknown } = stream): void => {
    if (live !== null) stream.write("\r\x1b[2K");
    to.write(text);
    if (live !== null) stream.write(live);
  };
  const writeLine = (text: string): void => writeAbove(`${text}\n`);
  return {
    line: writeLine,
    writeAbove,
    clear() {
      if (live !== null) stream.write("\r\x1b[2K");
      live = null;
    },
    step(label) {
      let n = 0;
      let total: number | undefined;
      let milestone = 0;
      let finished = false;
      const counter = (): string => {
        if (n === 0 && total === undefined) return "";
        return ` ${formatNumber(n)}${total === undefined ? "" : `/${formatNumber(total)}`}`;
      };
      const render = (): void => {
        live = `⟳ ${label}${counter()}`;
        stream.write(`\r\x1b[2K${live}`);
      };
      const finish = (text: string): void => {
        finished = true;
        if (live !== null) stream.write("\r\x1b[2K");
        live = null;
        stream.write(`${text}\n`);
      };
      if (tty) render();
      return {
        update(value, t) {
          if (finished) return;
          n = value;
          if (t !== undefined) total = t;
          if (tty) {
            render();
          } else if (Math.floor(n / 1000) > milestone) {
            milestone = Math.floor(n / 1000);
            stream.write(`⟳ ${label}${counter()}\n`);
          }
        },
        done(summary) {
          if (!finished) finish(`✓ ${label}${summary === undefined ? counter() : ` ${summary}`}`);
        },
        fail(message) {
          if (!finished) finish(`✗ ${label} — ${message}`);
        },
        note(text) {
          writeLine(`! ${text}`);
        },
      };
    },
  };
}

export interface CountRow {
  label: string;
  value: number;
}

/**
 * The final numbers, right-aligned: counted up over `ms` on a TTY, printed
 * once when piped. Every intermediate frame rounds; the last one is exact.
 */
export async function countUp(
  rows: CountRow[],
  {
    stream = process.stdout,
    tty = isTty(stream),
    ms = 800,
  }: ProgressOptions & { ms?: number } = {},
): Promise<void> {
  if (rows.length === 0) return;
  const width = Math.max(...rows.map((row) => formatNumber(row.value).length));
  const frame = (t: number): string =>
    `${rows
      .map((row) => `${formatNumber(Math.round(row.value * t)).padStart(width)}  ${row.label}`)
      .join("\n")}\n`;
  if (!tty) {
    stream.write(frame(1));
    return;
  }
  const frameMs = 1000 / 30;
  const frames = Math.max(1, Math.round(ms / frameMs));
  for (let i = 1; i <= frames; i++) {
    const t = i / frames;
    if (i > 1) stream.write(`\x1b[${rows.length}A`);
    stream.write(frame(i === frames ? 1 : 1 - (1 - t) ** 3));
    if (i < frames) await sleep(frameMs);
  }
}
