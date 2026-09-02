export const DAY_MS = 86_400_000;

/**
 * UTC day string ("YYYY-MM-DD"). This is the join key of usage_counters:
 * quota reservation writes and every dashboard/worker read must derive the
 * day from this one function, or rows silently stop matching.
 */
export function utcDay(at: number | Date = Date.now()): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** The next UTC midnight after `at`: when the daily usage counter resets. */
export function nextUtcDayStart(at: number | Date = Date.now()): Date {
  const next = new Date(at);
  next.setUTCHours(24, 0, 0, 0);
  return next;
}
