import type { Db } from "@millionsend/db";
// Schema via the clean subpath, never the package barrel: the barrel pulls the
// postgres driver (node:net), which breaks any client bundle that imports this
// module's thresholds. The type-only Db import above is erased.
import * as schema from "@millionsend/db/schema";
import { and, eq, gte, type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { freePoolOwner } from "./plans.js";
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
 * and full mailboxes are not a reputation signal. Complaint rates count only
 * the sends a recipient's provider could report, as SES does too: Gmail,
 * Apple and Deutsche Telekom never report one, so mail to them would dilute
 * the rate.
 */
export const WARN_BOUNCE_RATE = 0.04;
export const WARN_COMPLAINT_RATE = 0.0005;
export const PAUSE_BOUNCE_RATE = 0.05;
export const PAUSE_COMPLAINT_RATE = 0.001;

/**
 * Below this many sends in a window no tier fires regardless of rate: a
 * handful of bounces in a tiny sample must never pause an account. The
 * complaint tiers count only the sends that could draw a complaint, and a
 * Free pool's complaint tiers have no floor at all (fetchDeliverabilityHealth).
 */
export const MIN_GUARDRAIL_VOLUME = 100;

/**
 * The pause tier also needs this many events in its window. With the floor
 * at 100 sends a rate alone would let one complaint pause a team; the count
 * is what makes a small sample's rate mean something.
 */
export const MIN_PAUSE_COMPLAINTS = 3;
export const MIN_PAUSE_HARD_BOUNCES = 10;
/**
 * The warning tier's own floor for complaints: one complaint in a small week
 * clears 0.05% on its own and would throttle a team's broadcasts for seven
 * days; two make it a pattern.
 */
export const MIN_WARN_COMPLAINTS = 2;

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
 * or paused): sends continue but are dripped so reputation can recover. One a
 * second is SES's own sandbox pace; a 36k campaign still drains within a day,
 * just never in a burst.
 */
export const THROTTLED_BROADCAST_RATE_PER_SECOND = 1;

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
  /**
   * The complaint rate's denominator: sends with a recipient at a provider
   * that reports complaints.
   */
  complaintSent: number;
  hardBounced: number;
  complained: number;
}

/** complaintSent from a usage_counters row, for summing over a window. */
export const counterComplaintSent: SQL = sql`${schema.usageCounters.sent} - ${schema.usageCounters.sentNoFeedback}`;

export interface DeliverabilityEvaluation {
  /** Hard-bounce rate over the warning window. */
  bounceRate: number;
  complaintRate: number;
  status: DeliverabilityStatus;
  reasons: DeliverabilityReason[];
}

export interface DeliverabilityHealth extends DeliverabilityEvaluation {
  /** Sends in the warning window (the denominator of the displayed bounce rate). */
  sent: number;
  /** The warning window's sends that could draw a complaint (the complaint rate's denominator). */
  complaintSent: number;
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
 * the metric's floor of sends in its own window, counted over the metric's
 * own denominator (complaints over complaintSent): `minVolume` for bounces,
 * `complaintMinVolume` for complaints. The rates returned for display are the
 * long window's; zero sends yields zero rates, never NaN.
 */
export function evaluateDeliverability(
  windows: { warn: WindowCounts; pause: WindowCounts },
  minVolume: number = MIN_GUARDRAIL_VOLUME,
  complaintMinVolume: number = minVolume,
): DeliverabilityEvaluation {
  const { warn, pause } = windows;
  const reasons: DeliverabilityReason[] = [];
  const judge = (
    metric: DeliverabilityReason["metric"],
    lines: { warn: number; pause: number; minPauseEvents: number; minWarnEvents: number },
  ) => {
    const [events, sends] =
      metric === "bounce"
        ? (["hardBounced", "sent"] as const)
        : (["complained", "complaintSent"] as const);
    const floor = metric === "bounce" ? minVolume : complaintMinVolume;
    const pauseRate = rateOf(pause[events], pause[sends]);
    if (
      pause[sends] >= floor &&
      pauseRate >= lines.pause &&
      pause[events] >= lines.minPauseEvents
    ) {
      reasons.push({ metric, rate: pauseRate, tier: "paused", windowDays: PAUSE_WINDOW_DAYS });
      return;
    }
    const warnRate = rateOf(warn[events], warn[sends]);
    if (warn[sends] >= floor && warnRate >= lines.warn && warn[events] >= lines.minWarnEvents) {
      reasons.push({ metric, rate: warnRate, tier: "warning", windowDays: GUARDRAIL_WINDOW_DAYS });
    }
  };
  judge("bounce", {
    warn: WARN_BOUNCE_RATE,
    pause: PAUSE_BOUNCE_RATE,
    minPauseEvents: MIN_PAUSE_HARD_BOUNCES,
    minWarnEvents: 1,
  });
  judge("complaint", {
    warn: WARN_COMPLAINT_RATE,
    pause: PAUSE_COMPLAINT_RATE,
    minPauseEvents: MIN_PAUSE_COMPLAINTS,
    minWarnEvents: MIN_WARN_COMPLAINTS,
  });

  const status: DeliverabilityStatus = reasons.some((r) => r.tier === "paused")
    ? "paused"
    : reasons.some((r) => r.tier === "warning")
      ? "warning"
      : "ok";

  return {
    bounceRate: rateOf(warn.hardBounced, warn.sent),
    complaintRate: rateOf(warn.complained, warn.complaintSent),
    status,
    reasons,
  };
}

/**
 * A team's current deliverability standing. Sums usage_counters over both
 * windows in one round-trip (the pause window is the recent slice of the
 * warning window), using the successful SES send count as the denominator
 * (complaints: the sends that could draw one), with the windows' lower bounds
 * derived from utcDay so rows join on the exact same UTC-day key production
 * writes. A team in a Free pool (freePoolOwner) is judged on the pool's one
 * record instead, free_pool_usage summed the same way, so a pause holds every
 * Free team of its creator; its complaints count from the first send, since a
 * pool's volume is small and every complaint reaches the shared reputation.
 */
export async function fetchDeliverabilityHealth(
  db: Db,
  teamId: string,
  opts?: { now?: Date },
): Promise<DeliverabilityHealth> {
  const at = opts?.now ?? new Date();
  const now = at.getTime();
  const sinceWarn = utcDay(now - (GUARDRAIL_WINDOW_DAYS - 1) * DAY_MS);
  const sincePause = utcDay(now - (PAUSE_WINDOW_DAYS - 1) * DAY_MS);

  const t = schema.teams;
  const [team] = await db
    .select({ plan: t.plan, currentPeriodEnd: t.currentPeriodEnd, poolOwnerId: t.poolOwnerId })
    .from(t)
    .where(eq(t.id, teamId));
  const ownerId = team ? freePoolOwner(team, at) : null;
  const c = schema.usageCounters;
  const p = schema.freePoolUsage;
  const src = ownerId
    ? {
        table: p,
        scope: eq(p.ownerId, ownerId),
        day: p.day,
        sent: p.sent,
        complaintSent: sql`${p.sent} - ${p.sentNoFeedback}`,
        hardBounced: p.hardBounced,
        complained: p.complained,
      }
    : {
        table: c,
        scope: eq(c.teamId, teamId),
        day: c.day,
        sent: c.sent,
        complaintSent: counterComplaintSent,
        hardBounced: c.hardBounced,
        complained: c.complained,
      };
  // ::bigint — a busy sender's window sum can overflow int4. The driver
  // returns bigint as a string; Number() is exact up to 2^53.
  const total = (col: AnyPgColumn | SQL) => sql<string>`coalesce(sum(${col}), 0)::bigint`;
  const recent = (col: AnyPgColumn | SQL) =>
    sql<string>`coalesce(sum(case when ${src.day} >= ${sincePause} then ${col} else 0 end), 0)::bigint`;
  const [row] = await db
    .select({
      sent: total(src.sent),
      complaintSent: total(src.complaintSent),
      hardBounced: total(src.hardBounced),
      complained: total(src.complained),
      pauseSent: recent(src.sent),
      pauseComplaintSent: recent(src.complaintSent),
      pauseHardBounced: recent(src.hardBounced),
      pauseComplained: recent(src.complained),
    })
    .from(src.table)
    .where(and(src.scope, gte(src.day, sinceWarn)));

  const n = (v: string | undefined) => Number(v ?? 0);
  const warn = {
    sent: n(row?.sent),
    complaintSent: n(row?.complaintSent),
    hardBounced: n(row?.hardBounced),
    complained: n(row?.complained),
  };
  const pause = {
    sent: n(row?.pauseSent),
    complaintSent: n(row?.pauseComplaintSent),
    hardBounced: n(row?.pauseHardBounced),
    complained: n(row?.pauseComplained),
  };

  return {
    ...evaluateDeliverability(
      { warn, pause },
      MIN_GUARDRAIL_VOLUME,
      ownerId ? 0 : MIN_GUARDRAIL_VOLUME,
    ),
    sent: warn.sent,
    complaintSent: warn.complaintSent,
    windowDays: GUARDRAIL_WINDOW_DAYS,
    pause: { ...pause, windowDays: PAUSE_WINDOW_DAYS },
  };
}
