const SUMMARY_MAX = 300;

/**
 * A failure as a log line may carry it: the code and message of the
 * innermost error. A failed Drizzle query wraps the driver's error in one
 * whose message lists every parameter (the addresses, IPs and whole files
 * the query wrote), so that wrapper never reaches the log itself.
 */
export function errorSummary(error: unknown): string {
  let current: unknown = error;
  while (current instanceof Error && current.cause instanceof Error) current = current.cause;
  if (!(current instanceof Error)) return "unknown error";
  if (current.message.startsWith("Failed query")) return "query failed";
  const code = (current as { code?: unknown }).code;
  const summary = typeof code === "string" ? `${code} ${current.message}` : current.message;
  return summary.slice(0, SUMMARY_MAX);
}
