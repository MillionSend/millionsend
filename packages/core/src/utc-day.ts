export const DAY_MS = 86_400_000;

/**
 * UTC day string ("YYYY-MM-DD"). This is the join key of usage_counters:
 * quota reservation writes and every dashboard/worker read must derive the
 * day from this one function, or rows silently stop matching.
 */
export function utcDay(at: number | Date = Date.now()): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** The first UTC day of a trailing window of `days` calendar days that ends on `at`'s day. */
export function windowStartDay(days: number, at: number | Date): string {
  return utcDay(Number(at) - (days - 1) * DAY_MS);
}

/** The next UTC midnight after `at`: when the daily usage counter resets. */
export function nextUtcDayStart(at: number | Date = Date.now()): Date {
  const next = new Date(at);
  next.setUTCHours(24, 0, 0, 0);
  return next;
}

/** retry-after for a limit that lifts at `at`: whole seconds from `now`, at least one. */
export function secondsUntil(at: number | Date, now: number | Date = Date.now()): number {
  return Math.max(1, Math.ceil((Number(at) - Number(now)) / 1000));
}
