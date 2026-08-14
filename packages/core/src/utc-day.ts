export const DAY_MS = 86_400_000;

/**
 * UTC day string ("YYYY-MM-DD"). This is the join key of usage_counters:
 * quota reservation writes and every dashboard/worker read must derive the
 * day from this one function, or rows silently stop matching.
 */
export function utcDay(at: number | Date = Date.now()): string {
  return new Date(at).toISOString().slice(0, 10);
}
