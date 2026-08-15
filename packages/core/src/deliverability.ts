import type { Db } from "@millionsend/db";
// Schema via the clean subpath, never the package barrel: the barrel pulls the
// postgres driver (node:net), which breaks any client bundle that imports this
// module's thresholds. The type-only Db import above is erased.
import * as schema from "@millionsend/db/schema";
import { and, eq, gte, sql } from "drizzle-orm";
import { DAY_MS, utcDay } from "./utc-day.js";

/**
 * Single source of truth for deliverability thresholds and standing. The
 * Metrics page and BOTH send guards (tRPC broadcast + public API) import from
 * here — thresholds must never be re-hardcoded at a call site or they drift.
 *
 * Two tiers:
 * - WARN_* are the product "RISK" lines shown on the rate cards. Banner only,
 *   never blocks a send.
 * - PAUSE_* mirror SES's own enforcement thresholds; crossing one blocks new
 *   broadcast sends before SES pauses the whole account.
 */
export const WARN_BOUNCE_RATE = 0.04;
export const WARN_COMPLAINT_RATE = 0.0001;
export const PAUSE_BOUNCE_RATE = 0.05;
export const PAUSE_COMPLAINT_RATE = 0.001;

/**
 * Below this many sends in the window the guardrail is always "ok" regardless
 * of rate: a handful of bounces in a tiny sample must never pause an account.
 */
export const MIN_GUARDRAIL_VOLUME = 1000;

/** Trailing window, in UTC calendar days, that rates are computed over. */
export const GUARDRAIL_WINDOW_DAYS = 7;

/**
 * Reduced per-second fan-out rate for a team in the "tolerance" band (warning
 * or paused): sends continue but are dripped so reputation can recover. Well
 * under SES's 14/s default so a large campaign still drains, just not in a
 * burst.
 */
export const THROTTLED_BROADCAST_RATE_PER_SECOND = 5;

export type DeliverabilityStatus = "ok" | "warning" | "paused";

export interface DeliverabilityReason {
  metric: "bounce" | "complaint";
  rate: number;
  tier: "warning" | "paused";
}

export interface DeliverabilityEvaluation {
  bounceRate: number;
  complaintRate: number;
  status: DeliverabilityStatus;
  reasons: DeliverabilityReason[];
}

export interface DeliverabilityHealth extends DeliverabilityEvaluation {
  sent: number;
  windowDays: number;
}

/**
 * Milliseconds to space consecutive broadcast enqueues by, given a team's
 * standing. "ok" fans out at full rate (0 spacing); "warning" and "paused"
 * both drip at THROTTLED_BROADCAST_RATE_PER_SECOND — the fan-out throttles
 * rather than halts (initiation guards block new paused sends upstream).
 */
export function broadcastSendSpacingMs(status: DeliverabilityStatus): number {
  return status === "ok" ? 0 : Math.ceil(1000 / THROTTLED_BROADCAST_RATE_PER_SECOND);
}

function tierFor(rate: number, warn: number, pause: number): "warning" | "paused" | null {
  if (rate >= pause) return "paused";
  if (rate >= warn) return "warning";
  return null;
}

/**
 * Pure guardrail decision from a window's counts. Rates are always computed
 * for display, but no tier fires below MIN_GUARDRAIL_VOLUME. `sent` is the
 * accepted count (the denominator every rate divides by); zero sends yields
 * zero rates, never NaN.
 */
export function evaluateDeliverability(counts: {
  sent: number;
  bounced: number;
  complained: number;
}): DeliverabilityEvaluation {
  const { sent, bounced, complained } = counts;
  const bounceRate = sent > 0 ? bounced / sent : 0;
  const complaintRate = sent > 0 ? complained / sent : 0;

  if (sent < MIN_GUARDRAIL_VOLUME) {
    return { bounceRate, complaintRate, status: "ok", reasons: [] };
  }

  const reasons: DeliverabilityReason[] = [];
  const bounceTier = tierFor(bounceRate, WARN_BOUNCE_RATE, PAUSE_BOUNCE_RATE);
  if (bounceTier) reasons.push({ metric: "bounce", rate: bounceRate, tier: bounceTier });
  const complaintTier = tierFor(complaintRate, WARN_COMPLAINT_RATE, PAUSE_COMPLAINT_RATE);
  if (complaintTier)
    reasons.push({ metric: "complaint", rate: complaintRate, tier: complaintTier });

  const status: DeliverabilityStatus = reasons.some((r) => r.tier === "paused")
    ? "paused"
    : reasons.some((r) => r.tier === "warning")
      ? "warning"
      : "ok";

  return { bounceRate, complaintRate, status, reasons };
}

/**
 * A team's current deliverability standing over the trailing window. Sums
 * usage_counters (sent = accepted) the same way the metrics router reads them,
 * with the window's lower bound derived from utcDay so rows join on the exact
 * same UTC-day key production writes.
 */
export async function fetchDeliverabilityHealth(
  db: Db,
  teamId: string,
  opts?: { now?: Date; windowDays?: number },
): Promise<DeliverabilityHealth> {
  const windowDays = opts?.windowDays ?? GUARDRAIL_WINDOW_DAYS;
  const now = (opts?.now ?? new Date()).getTime();
  const since = utcDay(now - (windowDays - 1) * DAY_MS);

  const c = schema.usageCounters;
  // ::bigint — a busy sender's window sum can overflow int4. The driver
  // returns bigint as a string; Number() is exact up to 2^53.
  const [row] = await db
    .select({
      sent: sql<string>`coalesce(sum(${c.accepted}), 0)::bigint`,
      bounced: sql<string>`coalesce(sum(${c.bounced}), 0)::bigint`,
      complained: sql<string>`coalesce(sum(${c.complained}), 0)::bigint`,
    })
    .from(c)
    .where(and(eq(c.teamId, teamId), gte(c.day, since)));

  const sent = Number(row?.sent ?? 0);
  const evaluation = evaluateDeliverability({
    sent,
    bounced: Number(row?.bounced ?? 0),
    complained: Number(row?.complained ?? 0),
  });

  return { ...evaluation, sent, windowDays };
}
