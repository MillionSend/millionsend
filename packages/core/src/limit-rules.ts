/**
 * The new domain limit's rules that the dashboard checks too: what spent a
 * day's room, and the bounds of a request to lift the limit. Imports
 * nothing, so the browser reads the same rules the server enforces.
 */

/** The most a limit request may ask for a day, and the longest note it may carry. */
export const LIMIT_REQUEST_PER_DAY_MAX = 10_000_000;
export const LIMIT_REQUEST_NOTE_MAX = 1_000;

/**
 * What spent the day's room: the domain's own cap, the volume the team's new
 * domains share, or nothing yet, when the next drain lets held mail out.
 */
export function limitSpent(limit: {
  cap: number;
  used: number;
  pool: { cap: number; used: number } | null;
}): "domain" | "pool" | null {
  if (limit.used >= limit.cap) return "domain";
  if (limit.pool && limit.pool.used >= limit.pool.cap) return "pool";
  return null;
}
