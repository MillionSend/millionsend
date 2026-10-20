const SUMMARY_MAX = 300;
/** Deeper than any real cause chain; a chain that loops back on itself stops here. */
const CAUSE_DEPTH_MAX = 10;

/**
 * A failure as a log line may carry it: the code and message of the
 * innermost error. A failed Drizzle query wraps the driver's error in one
 * whose message lists every parameter (the addresses, IPs and whole files
 * the query wrote), so that wrapper never reaches the log itself.
 */
export function errorSummary(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < CAUSE_DEPTH_MAX; depth += 1) {
    if (!(current instanceof Error && current.cause instanceof Error)) break;
    current = current.cause;
  }
  if (!(current instanceof Error)) return "unknown error";
  if (current.message.startsWith("Failed query")) return "query failed";
  const code = (current as { code?: unknown }).code;
  const summary = typeof code === "string" ? `${code} ${current.message}` : current.message;
  return summary.slice(0, SUMMARY_MAX);
}

/**
 * A failed write as a log line may name it: the outer error's class and the
 * first string `code` down its cause chain (the SQLSTATE a driver error
 * carries), "" when there is none. Never the message, which for a failed
 * query lists its parameters.
 */
export function errorClassAndCode(error: unknown): [errorClass: string, code: string] {
  let current: unknown = error;
  for (let depth = 0; depth < CAUSE_DEPTH_MAX && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return [(error as Error).name, code];
    current = current.cause;
  }
  return [error instanceof Error ? error.name : "error", ""];
}
