/**
 * A send the API refused at accept because every `to` recipient was
 * suppressed: its row is kept for the log, but no body was ever stored. The
 * worker's own suppressions carry source "worker" and had a body to purge.
 */
export function suppressedAtAccept(
  events: readonly { type: string; data: Record<string, unknown> | null }[],
): boolean {
  return events.some((event) => event.type === "suppressed" && event.data?.source === "api");
}
