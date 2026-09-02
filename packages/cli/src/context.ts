import type { Config } from "./config.js";
import { createLogger, type Logger } from "./log.js";
import { createProgress, type Progress } from "./progress.js";
import { type LineReader, lineReader } from "./tty-ui.js";

export type OutStream = NodeJS.WritableStream & {
  isTTY?: boolean | undefined;
  columns?: number | undefined;
};

/** Process seams; the tests drive main() in-process with their own streams, env and cwd. */
export interface Io {
  stdin?: (NodeJS.ReadableStream & { isTTY?: boolean | undefined }) | undefined;
  stdout?: OutStream | undefined;
  stderr?: OutStream | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  fetch?: typeof fetch | undefined;
  cwd?: string | undefined;
}

/** What every command gets: parsed config, stderr logger, line reader, progress on `out`. */
export interface Context {
  config: Config;
  log: Logger;
  rl: LineReader;
  progress: Progress;
  /** Human output: stdout, or stderr under --json where stdout is JSON only. */
  out: OutStream;
  /** Machine output under --json. */
  stdout: OutStream;
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  cwd: string;
}

export function createContext(config: Config, io: Io = {}): Context {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const out = config.json ? stderr : stdout;
  const progress = createProgress({ stream: out });
  // On a terminal a log line would land on the live progress row; route it
  // through the renderer so it is printed above that row. Piped, stderr is
  // written directly.
  const logSink =
    out.isTTY === true ? { write: (chunk: string) => progress.writeAbove(chunk, stderr) } : stderr;
  return {
    config,
    log: createLogger({ level: config.verbose ? "debug" : "info", stream: logSink }),
    rl: lineReader(io.stdin ?? process.stdin, out),
    progress,
    out,
    stdout,
    env: io.env ?? process.env,
    fetch: io.fetch ?? globalThis.fetch,
    cwd: io.cwd ?? process.cwd(),
  };
}
