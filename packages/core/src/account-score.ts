import type { Db } from "@millionsend/db";
// Schema via the clean subpath, never the package barrel: the barrel pulls the
// postgres driver (node:net), which breaks any client bundle importing the
// thresholds below.
import * as schema from "@millionsend/db/schema";
import { and, eq, gte, isNotNull, or, sql } from "drizzle-orm";
import { type DeliverabilityStatus, fetchDeliverabilityHealth } from "./deliverability.js";
import { resultRows } from "./driver-result.js";
import {
  type CheckId,
  type CheckSeverity,
  SCORE_VERSION,
  type ScoreBand,
  scoreBand,
} from "./email-insights.js";
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
  /** Current guardrail standing — the score must never contradict it. */
  guardrailStatus: DeliverabilityStatus;
}

export interface AccountScore {
  scoreTenths: number | null;
  band: ScoreBand | null;
  /** 0.4·C + 0.6·O before the governor and guardrail; null while a sub-score is missing. */
  blendTenths: number | null;
  /** The governor's ceiling, outcome + 1.5; null without an outcome sub-score. */
  governorCapTenths: number | null;
  /** The guardrail's ceiling (warning 6.9, paused 4.9); null when it does not apply. */
  guardrailCapTenths: number | null;
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

  const blendTenths =
    outcomeScoreTenths !== null && contentScoreTenths !== null
      ? Math.round(0.4 * contentScoreTenths + 0.6 * outcomeScoreTenths)
      : null;
  const governorCapTenths = outcomeScoreTenths === null ? null : outcomeScoreTenths + 15;
  const guardrailCapTenths =
    guardrailStatus === "paused" ? 49 : guardrailStatus === "warning" ? 69 : null;

  let headline: number | null;
  if (blendTenths !== null && governorCapTenths !== null) {
    headline = Math.min(blendTenths, governorCapTenths);
  } else {
    headline = outcomeScoreTenths ?? contentScoreTenths;
  }
  if (headline !== null && guardrailCapTenths !== null) {
    headline = Math.min(headline, guardrailCapTenths);
  }

  return {
    scoreTenths: headline,
    band: headline === null ? null : scoreBand(headline),
    blendTenths,
    governorCapTenths,
    guardrailCapTenths,
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
  opts?: { now?: Date },
): Promise<AccountScore> {
  return computeAccountScore(await fetchAccountScoreInput(db, teamId, opts));
}

/** The window's raw inputs, so a caller can replay the formula with a factor removed. */
export async function fetchAccountScoreInput(
  db: Db,
  teamId: string,
  opts?: { now?: Date },
): Promise<AccountScoreInput> {
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

  const health = await fetchDeliverabilityHealth(db, teamId, opts?.now ? { now: opts.now } : {});

  return {
    contentWeightedTenths: Number(content?.weighted ?? 0),
    contentRecipients: Number(content?.recipients ?? 0),
    sent: Number(counters?.sent ?? 0),
    complained: Number(counters?.complained ?? 0),
    hardBounced: Number(counters?.hardBounced ?? 0),
    guardrailStatus: health.status,
  };
}

/** One failing check aggregated over the window: how many emails and recipients it touched. */
export interface ContentFactor {
  id: CheckId;
  severity: CheckSeverity;
  emails: number;
  recipients: number;
  /** Σ penaltyHundredths × recipients — what the check cost the content sub-score's numerator. */
  weightedPenaltyHundredths: number;
}

/**
 * Failing checks over the score window, heaviest first, with the same
 * email↔insights join and window as the content sub-score so both read the
 * same population. Info checks (zero weight) still list, at zero cost.
 */
export async function fetchContentFactors(
  db: Db,
  teamId: string,
  opts?: { now?: Date },
): Promise<ContentFactor[]> {
  const now = (opts?.now ?? new Date()).getTime();
  const sinceTs = new Date(utcDay(now - (ACCOUNT_SCORE_WINDOW_DAYS - 1) * DAY_MS));
  const createdFloor = new Date(now - 61 * DAY_MS);
  const e = schema.emails;
  const i = schema.emailInsights;
  const rows = resultRows<{
    id: CheckId;
    severity: CheckSeverity;
    emails: number;
    recipients: string;
    weighted: string;
  }>(
    await db.execute(sql`
      select c->>'id' as id,
             c->>'severity' as severity,
             count(distinct ${e.id})::int as emails,
             coalesce(sum(jsonb_array_length(${e.to})), 0)::bigint as recipients,
             coalesce(sum((c->>'penaltyHundredths')::int * jsonb_array_length(${e.to})), 0)::bigint as weighted
      from ${e}
      join ${i} on (${i.emailId} = ${e.id} or (${e.broadcastId} is not null and ${i.broadcastId} = ${e.broadcastId}))
      cross join lateral jsonb_array_elements(${i.checks}) as c
      where ${e.teamId} = ${teamId}
        and ${e.createdAt} >= ${createdFloor}
        and ${e.sentAt} >= ${sinceTs}
        and c->>'status' = 'fail'
      group by 1, 2
      order by weighted desc, recipients desc, id asc
    `),
  );
  return rows.map((row) => ({
    id: row.id,
    severity: row.severity,
    emails: Number(row.emails),
    recipients: Number(row.recipients),
    weightedPenaltyHundredths: Number(row.weighted),
  }));
}

/**
 * What one failing check costs, and what fixing it alone would gain: the
 * formula replayed with the check's penalty handed back to the content
 * numerator. The lift can be zero when the governor or guardrail holds.
 */
export function contentFactorImpact(
  input: AccountScoreInput,
  factor: Pick<ContentFactor, "weightedPenaltyHundredths">,
): { penaltyTenths: number; liftTenths: number } {
  if (input.contentRecipients === 0) return { penaltyTenths: 0, liftTenths: 0 };
  const restoredTenths = factor.weightedPenaltyHundredths / 10;
  const current = computeAccountScore(input).scoreTenths ?? 0;
  const fixed =
    computeAccountScore({
      ...input,
      contentWeightedTenths: input.contentWeightedTenths + restoredTenths,
    }).scoreTenths ?? 0;
  return {
    penaltyTenths: restoredTenths / input.contentRecipients,
    liftTenths: Math.max(0, fixed - current),
  };
}
