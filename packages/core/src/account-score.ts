import type { Db } from "@millionsend/db";
// Schema via the clean subpath, never the package barrel: the barrel pulls the
// postgres driver (node:net), which breaks any client bundle importing the
// thresholds below.
import * as schema from "@millionsend/db/schema";
import { and, eq, gte, isNotNull, or, sql } from "drizzle-orm";
import {
  type DeliverabilityStatus,
  fetchDeliverabilityHealth,
  GUARDRAIL_WINDOW_DAYS,
} from "./deliverability.js";
import { SCORE_VERSION, type ScoreBand, scoreBand } from "./email-insights.js";
import type { Plan } from "./plans.js";
import { DAY_MS, utcDay } from "./utc-day.js";

/** Trailing window, in UTC calendar days, the account score is computed over. */
export const ACCOUNT_SCORE_WINDOW_DAYS = 30;

/**
 * Below this many sends in the window, the outcome sub-score is withheld
 * ("not enough data") rather than fabricated from a tiny sample — the
 * headline then falls back to the content sub-score alone.
 */
export const MIN_OUTCOME_SENDS = 100;

export interface AccountScoreInput {
  /** Σ scoreTenths × recipients over scored emails in the window. */
  contentWeightedTenths: number;
  /** Σ recipients over scored emails in the window (C's denominator). */
  contentRecipients: number;
  /** usage_counters sums over the window. */
  sent: number;
  complained: number;
  hardBounced: number;
  /** Current 7-day guardrail standing — the score must never contradict it. */
  guardrailStatus: DeliverabilityStatus;
}

export interface AccountScore {
  scoreTenths: number | null;
  band: ScoreBand | null;
  contentScoreTenths: number | null;
  /** Null when the window has fewer than MIN_OUTCOME_SENDS sends. */
  outcomeScoreTenths: number | null;
  complaintRate: number;
  hardBounceRate: number;
  insufficientOutcomeData: boolean;
  guardrailStatus: DeliverabilityStatus;
  sent: number;
  contentRecipients: number;
  windowDays: number;
  scoreVersion: number;
}

/** Linear ramp of `rate` from 0 at `lo` to `max` at `hi`, clamped. */
function ramp(rate: number, lo: number, hi: number, max: number): number {
  if (rate <= lo) return 0;
  if (rate >= hi) return max;
  return ((rate - lo) / (hi - lo)) * max;
}

/**
 * Outcome penalty gradients (in score tenths), anchored to Google's published
 * spam-rate lines (keep below 0.10%, never reach 0.30%) with a severe tail:
 * complaints ramp 0→6pts across 0.1%–0.3% and 6→10pts across 0.3%–1%;
 * hard bounces ramp 0→4pts across 2%–5% and 4→6pts across 5%–10%.
 * Denominator is `sent`, matching evaluateDeliverability — the guardrail and
 * the score must read the same rates or they become two arguing authorities.
 */
function outcomePenaltyTenths(complaintRate: number, hardBounceRate: number): number {
  const complaint = ramp(complaintRate, 0.001, 0.003, 60) + ramp(complaintRate, 0.003, 0.01, 40);
  const bounce = ramp(hardBounceRate, 0.02, 0.05, 40) + ramp(hardBounceRate, 0.05, 0.1, 20);
  return complaint + bounce;
}

/**
 * Pure account-score math. Two sub-scores, outcome-dominant headline:
 * headline = min(0.4·C + 0.6·O, O + 1.5) — the governor means immaculate
 * content lint can never mask a real complaint problem. The 7-day guardrail
 * additionally caps the headline (paused ≤ 4.9, warning ≤ 6.9) so "score 8.1
 * but your sends are paused" is impossible by construction.
 */
export function computeAccountScore(input: AccountScoreInput): AccountScore {
  const { sent, complained, hardBounced, guardrailStatus } = input;
  const complaintRate = sent > 0 ? complained / sent : 0;
  const hardBounceRate = sent > 0 ? hardBounced / sent : 0;

  const contentScoreTenths =
    input.contentRecipients > 0
      ? Math.round(input.contentWeightedTenths / input.contentRecipients)
      : null;

  const insufficientOutcomeData = sent < MIN_OUTCOME_SENDS;
  const outcomeScoreTenths = insufficientOutcomeData
    ? null
    : Math.round(Math.max(0, 100 - outcomePenaltyTenths(complaintRate, hardBounceRate)));

  let headline: number | null;
  if (outcomeScoreTenths !== null && contentScoreTenths !== null) {
    headline = Math.min(
      Math.round(0.4 * contentScoreTenths + 0.6 * outcomeScoreTenths),
      outcomeScoreTenths + 15,
    );
  } else {
    headline = outcomeScoreTenths ?? contentScoreTenths;
  }
  if (headline !== null) {
    if (guardrailStatus === "paused") headline = Math.min(headline, 49);
    else if (guardrailStatus === "warning") headline = Math.min(headline, 69);
  }

  return {
    scoreTenths: headline,
    band: headline === null ? null : scoreBand(headline),
    contentScoreTenths,
    outcomeScoreTenths,
    complaintRate,
    hardBounceRate,
    insufficientOutcomeData,
    guardrailStatus,
    sent,
    contentRecipients: input.contentRecipients,
    windowDays: ACCOUNT_SCORE_WINDOW_DAYS,
    scoreVersion: SCORE_VERSION,
  };
}

/**
 * A team's rolling account score over the trailing 30 days. The content
 * sub-score is the recipient-weighted mean of per-email scores (a 100k-blast
 * counts 100k, a test send counts 1); broadcast emails resolve their shared
 * broadcast-keyed insights row.
 */
export async function fetchAccountScore(
  db: Db,
  teamId: string,
  opts?: { now?: Date; plan?: Plan },
): Promise<AccountScore> {
  const now = (opts?.now ?? new Date()).getTime();
  const since = utcDay(now - (ACCOUNT_SCORE_WINDOW_DAYS - 1) * DAY_MS);
  // The content query windows on sentAt from the SAME UTC-day boundary the
  // counters window on, or the two sub-scores measure different populations.
  const sinceTs = new Date(since);
  // Loose createdAt floor purely to drive the (teamId, createdAt) index:
  // schedule cap 30d + window 30d + margin.
  const createdFloor = new Date(now - 61 * DAY_MS);

  const c = schema.usageCounters;
  const e = schema.emails;
  const i = schema.emailInsights;

  const [counters] = await db
    .select({
      sent: sql<string>`coalesce(sum(${c.sent}), 0)::bigint`,
      complained: sql<string>`coalesce(sum(${c.complained}), 0)::bigint`,
      hardBounced: sql<string>`coalesce(sum(${c.hardBounced}), 0)::bigint`,
    })
    .from(c)
    .where(and(eq(c.teamId, teamId), gte(c.day, since)));

  // ponytail: OR-join over the two unique insight keys; rewrite as a UNION of
  // two index-driven joins if this scan ever shows up in slow queries.
  const [content] = await db
    .select({
      weighted: sql<string>`coalesce(sum(${i.scoreTenths} * jsonb_array_length(${e.to})), 0)::bigint`,
      recipients: sql<string>`coalesce(sum(jsonb_array_length(${e.to})), 0)::bigint`,
    })
    .from(e)
    .innerJoin(
      i,
      or(eq(i.emailId, e.id), and(isNotNull(e.broadcastId), eq(i.broadcastId, e.broadcastId))),
    )
    .where(and(eq(e.teamId, teamId), gte(e.createdAt, createdFloor), gte(e.sentAt, sinceTs)));

  const health = await fetchDeliverabilityHealth(db, teamId, {
    windowDays: GUARDRAIL_WINDOW_DAYS,
    ...(opts?.now ? { now: opts.now } : {}),
    ...(opts?.plan ? { plan: opts.plan } : {}),
  });

  return computeAccountScore({
    contentWeightedTenths: Number(content?.weighted ?? 0),
    contentRecipients: Number(content?.recipients ?? 0),
    sent: Number(counters?.sent ?? 0),
    complained: Number(counters?.complained ?? 0),
    hardBounced: Number(counters?.hardBounced ?? 0),
    guardrailStatus: health.status,
  });
}
