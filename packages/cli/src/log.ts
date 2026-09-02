import { stripControl } from "./utils.js";

export type LogLevel = "error" | "warn" | "info" | "debug";

const RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

const TOKEN_RE = /\b(?:re|ms|whsec)_[A-Za-z0-9+/=_-]+/g;
const AUTHORIZATION_RE = /(authorization["']?\s*[:=]\s*["']?)(?:bearer\s+)?[^\s"',}]+/gi;

/** Replaces API keys, webhook secrets and Authorization values with `***`. */
export function redact(text: string): string {
  return text.replace(AUTHORIZATION_RE, "$1***").replace(TOKEN_RE, "***");
}

export interface Logger {
  readonly level: LogLevel;
  error(message: string): void;
  warn(message: string): void;
  info(message: string): void;
  debug(message: string): void;
}

export interface LogSink {
  write(chunk: string): unknown;
}

/** Leveled stderr logger; every message passes through redact() and stripControl(). */
export function createLogger({
  level = "info",
  stream = process.stderr,
}: {
  level?: LogLevel;
  stream?: LogSink;
} = {}): Logger {
  const write = (at: LogLevel, prefix: string, message: string): void => {
    if (RANK[at] <= RANK[level]) stream.write(`${prefix}${stripControl(redact(message))}\n`);
  };
  return {
    level,
    error: (message) => write("error", "error: ", message),
    warn: (message) => write("warn", "warning: ", message),
    info: (message) => write("info", "", message),
    debug: (message) => write("debug", "", message),
  };
}
