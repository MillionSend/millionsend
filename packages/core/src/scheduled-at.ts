import { z } from "zod";
import { DAY_MS } from "./utc-day.js";

/**
 * The two scheduled_at forms Resend documents: an ISO 8601 datetime with
 * offset, or a relative "in N min(s)/minute(s)/hour(s)/day(s)" resolved
 * against now. Shared by every scheduling surface (single send, batch items,
 * email reschedule, broadcast scheduling) so their acceptance never drifts.
 */

/** For 422 messages: names both accepted forms. */
export const SCHEDULED_AT_FORMS =
  'an ISO 8601 datetime with offset (e.g. "2026-09-01T12:00:00Z") or a relative time like "in 5 mins", "in 2 hours", or "in 1 day"';

const RELATIVE_RE = /^in\s+(\d+)\s+(mins?|minutes?|hours?|days?)$/i;

const isoWithOffset = z.iso.datetime({ offset: true });

/** Null = unparseable; callers answer 422 naming SCHEDULED_AT_FORMS. */
export function parseScheduledAt(input: string, now: Date = new Date()): Date | null {
  const relative = RELATIVE_RE.exec(input.trim());
  if (relative?.[1] && relative[2]) {
    const unit = relative[2].toLowerCase();
    const unitMs = unit.startsWith("min") ? 60_000 : unit.startsWith("hour") ? 3_600_000 : DAY_MS;
    const at = new Date(now.getTime() + Number(relative[1]) * unitMs);
    // An absurdly large N overflows the Date range into Invalid Date.
    return Number.isNaN(at.getTime()) ? null : at;
  }
  return isoWithOffset.safeParse(input).success ? new Date(input) : null;
}
