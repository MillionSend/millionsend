import type { Db } from "@millionsend/db";
// Schema via the clean subpath, never the package barrel: the barrel pulls the
// postgres driver (node:net), which breaks any client bundle that imports this
// module's thresholds. The type-only Db import above is erased.
import * as schema from "@millionsend/db/schema";
import { and, eq, gte, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { DAY_MS, utcDay } from "./utc-day.js";

/**
 * Single source of truth for deliverability thresholds and standing. The
 * Metrics page and BOTH send guards (tRPC broadcast + public API) import from
 * here — thresholds must never be re-hardcoded at a call site or they drift.
 *
 * Two tiers:
 * - WARN_* are the product "RISK" lines shown on the rate cards. Banner and a
 *   reduced broadcast rate, never a block.
 * - PAUSE_* mirror SES's own review lines; crossing one blocks new sends
 *   before SES pauses the whole account.
 * Bounce rates count hard (permanent) bounces only, as SES does: greylisting
 * and full mailboxes are not a reputation signal.
 */
export const WARN_BOUNCE_RATE = 0.04;
export const WARN_COMPLAINT_RATE = 0.0001;
export const PAUSE_BOUNCE_RATE = 0.05;
export const PAUSE_COMPLAINT_RATE = 0.001;

/**
 * Below this many sends in a window no tier fires regardless of rate: a
 * handful of bounces in a tiny sample must never pause an account.
 */
export const MIN_GUARDRAIL_VOLUME = 100;

/**
 * The pause tier also needs this many events in its window. With the floor
 * at 100 sends a rate alone would let one complaint pause a team; the count
 * is what makes a small sample's rate mean something.
 */
export const MIN_PAUSE_COMPLAINTS = 3;
export const MIN_PAUSE_HARD_BOUNCES = 10;

/** Trailing window, in UTC calendar days, the warning tier and the displayed rates use. */
export const GUARDRAIL_WINDOW_DAYS = 7;

/**
 * Window the pause tier is judged on: today and yesterday. usage_counters is
 * keyed by UTC day, so this is the honest "last 24 hours" — a one-day window
 * would hold five minutes of data just after midnight. A team that fixes its
 * list recovers in a day instead of waiting out the warning window.
 */
export const PAUSE_WINDOW_DAYS = 2;

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
  /** Window the rate was measured over, so messages can name it truthfully. */
  windowDays: number;
}

/** Counts summed over one window. Hard bounces only: transient ones never count. */
export interface WindowCounts {
  sent: number;
  hardBounced: number;
  complained: number;
}

export interface DeliverabilityEvaluation {
  /** Hard-bounce rate over the warning window. */
  bounceRate: number;
  complaintRate: number;
  status: DeliverabilityStatus;
  reasons: DeliverabilityReason[];
}

export interface DeliverabilityHealth extends DeliverabilityEvaluation {
  /** Sends in the warning window (the denominator of the displayed rates). */
  sent: number;
  windowDays: number;
  pause: WindowCounts & { windowDays: number };
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

const rateOf = (events: number, sent: number): number => (sent > 0 ? events / sent : 0);

/**
 * Pure guardrail decision. The pause tier reads the short window: rate at or
 * over the pause line AND at least MIN_PAUSE_* events. The warning tier reads
 * the long window: rate at or over the warning line. Neither fires under
 * `minVolume` sends in its own window. The rates returned for display are the
 * long window's; zero sends yields zero rates, never NaN.
 */
export function evaluateDeliverability(
  windows: { warn: WindowCounts; pause: WindowCounts },
  minVolume: number = MIN_GUARDRAIL_VOLUME,
): DeliverabilityEvaluation {
  const { warn, pause } = windows;
  const reasons: DeliverabilityReason[] = [];
  const judge = (
    metric: DeliverabilityReason["metric"],
    lines: { warn: number; pause: number; minPauseEvents: number },
  ) => {
    const events = metric === "bounce" ? "hardBounced" : "complained";
    const pauseRate = rateOf(pause[events], pause.sent);
    if (
      pause.sent >= minVolume &&
      pauseRate >= lines.pause &&
      pause[events] >= lines.minPauseEvents
    ) {
      reasons.push({ metric, rate: pauseRate, tier: "paused", windowDays: PAUSE_WINDOW_DAYS });
      return;
    }
    const warnRate = rateOf(warn[events], warn.sent);
    if (warn.sent >= minVolume && warnRate >= lines.warn) {
      reasons.push({ metric, rate: warnRate, tier: "warning", windowDays: GUARDRAIL_WINDOW_DAYS });
    }
  };
  judge("bounce", {
    warn: WARN_BOUNCE_RATE,
    pause: PAUSE_BOUNCE_RATE,
    minPauseEvents: MIN_PAUSE_HARD_BOUNCES,
  });
  judge("complaint", {
    warn: WARN_COMPLAINT_RATE,
    pause: PAUSE_COMPLAINT_RATE,
    minPauseEvents: MIN_PAUSE_COMPLAINTS,
  });

  const status: DeliverabilityStatus = reasons.some((r) => r.tier === "paused")
    ? "paused"
    : reasons.some((r) => r.tier === "warning")
      ? "warning"
      : "ok";

  return {
    bounceRate: rateOf(warn.hardBounced, warn.sent),
    complaintRate: rateOf(warn.complained, warn.sent),
    status,
    reasons,
  };
}

/**
 * A team's current deliverability standing. Sums usage_counters over both
 * windows in one round-trip (the pause window is the recent slice of the
 * warning window), using the successful SES send count as the denominator,
 * with the windows' lower bounds derived from utcDay so rows join on the exact
 * same UTC-day key production writes.
 */
export async function fetchDeliverabilityHealth(
  db: Db,
  teamId: string,
  opts?: { now?: Date },
): Promise<DeliverabilityHealth> {
  const now = (opts?.now ?? new Date()).getTime();
  const sinceWarn = utcDay(now - (GUARDRAIL_WINDOW_DAYS - 1) * DAY_MS);
  const sincePause = utcDay(now - (PAUSE_WINDOW_DAYS - 1) * DAY_MS);

  const c = schema.usageCounters;
  // ::bigint — a busy sender's window sum can overflow int4. The driver
  // returns bigint as a string; Number() is exact up to 2^53.
  const total = (col: AnyPgColumn) => sql<string>`coalesce(sum(${col}), 0)::bigint`;
  const recent = (col: AnyPgColumn) =>
    sql<string>`coalesce(sum(case when ${c.day} >= ${sincePause} then ${col} else 0 end), 0)::bigint`;
  const [row] = await db
    .select({
      sent: total(c.sent),
      hardBounced: total(c.hardBounced),
      complained: total(c.complained),
      pauseSent: recent(c.sent),
      pauseHardBounced: recent(c.hardBounced),
      pauseComplained: recent(c.complained),
    })
    .from(c)
    .where(and(eq(c.teamId, teamId), gte(c.day, sinceWarn)));

  const n = (v: string | undefined) => Number(v ?? 0);
  const warn = {
    sent: n(row?.sent),
    hardBounced: n(row?.hardBounced),
    complained: n(row?.complained),
  };
  const pause = {
    sent: n(row?.pauseSent),
    hardBounced: n(row?.pauseHardBounced),
    complained: n(row?.pauseComplained),
  };

  return {
    ...evaluateDeliverability({ warn, pause }),
    sent: warn.sent,
    windowDays: GUARDRAIL_WINDOW_DAYS,
    pause: { ...pause, windowDays: PAUSE_WINDOW_DAYS },
  };
}
