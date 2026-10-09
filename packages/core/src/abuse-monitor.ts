import { createHmac, hkdfSync } from "node:crypto";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, desc, eq, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { JudgeVerdict } from "./abuse-judge/types.js";
import { recordAudit } from "./audit.js";
import { MONITOR_SETTING_DEFAULTS, type MonitorSettings } from "./monitor-settings.js";
import { fetchTeamStanding, suspendTeam } from "./team-standing.js";
import { DAY_MS, utcDay } from "./utc-day.js";

/**
 * The content monitor's sampling and risk model. After SES accepts a
 * message a keyed draw decides whether the judge sees it; verdicts decay
 * into a per-team risk that opens the monitor flag, alerts the operator and,
 * for a new team, pauses broadcasts; a confident phishing verdict on a new
 * team, or a run of slightly less confident ones in its first week, holds
 * all of its sending for review. Every function here is safe to skip:
 * nothing on the send path waits for a verdict.
 */

export type MonitorSampleKind = (typeof schema.monitorSampleKindEnum.enumValues)[number];
export type MonitorSampleStatus = (typeof schema.monitorSampleStatusEnum.enumValues)[number];
export type MonitorTier = "new" | "probation" | "established" | "trusted" | "exempt";
export const MONITOR_TIERS = ["new", "probation", "established", "trusted", "exempt"] as const;

/** Day 30 after the first send ends Probation. */
export const MONITOR_PROBATION_DAYS = 30;
/** Trusted: this old, this many lifetime sends, and no flag in the clean window. */
export const MONITOR_TRUSTED_DAYS = 120;
export const MONITOR_TRUSTED_SENDS = 50_000;
export const MONITOR_TRUSTED_CLEAN_DAYS = 90;
/** Verdicts halve in weight every week; a fresh team starts closer to "unknown" than a settled one. */
export const MONITOR_RISK_HALF_LIFE_MS = 7 * DAY_MS;
export const MONITOR_PRIOR_WEIGHT = 3;
export const MONITOR_PRIOR_NEW = 0.35;
export const MONITOR_PRIOR_SETTLED = 0.15;
/** A flagged team is sampled this much more until its risk decays under the line. */
export const MONITOR_FLAGGED_RATE_MULTIPLIER = 4;
/** The pause policy also wants one verdict this strong within a day. */
export const MONITOR_PAUSE_VERDICT_SCORE = 90;
export const MONITOR_PAUSE_VERDICT_WINDOW_MS = DAY_MS;
export const MONITOR_ALERT_INTERVAL_MS = DAY_MS;
/**
 * The phishing-type verdicts the review hold acts on: the category the judge
 * chose, or a lure it saw. Any other abuse stays alert-only.
 */
export const MONITOR_HOLD_CATEGORIES = [
  "phishing_credentials",
  "brand_impersonation",
  "payment_redirect",
] as const;
export const MONITOR_HOLD_REASONS = [
  "impersonation",
  "harvests_secrets",
  "off_domain_lure",
] as const;
/**
 * The repeat hold counts the verdicts of a team's first week of sending,
 * from its first send: a phisher who signs up and waits a week before
 * sending is still covered. A team that has not sent has nothing to count.
 */
export const MONITOR_HOLD_REPEAT_DAYS = 7;
/** Samples are metadata on the probes' clock. */
export const MONITOR_SAMPLE_RETENTION_DAYS = 90;
/** A pending sample older than this had its job lost; pg-boss's last retry lands well inside it. */
export const MONITOR_LOST_AFTER_MS = 3 * 3600_000;

/**
 * The insight checks whose failure is an anomaly for the draw: the ones that
 * speak to deception in the content itself. A missing DMARC record or a
 * large body is a configuration finding and would only burn the judge's
 * budget on every send of a team that has it.
 */
export const MONITOR_ANOMALY_CHECKS = [
  "link_domains_match",
  "no_shorteners",
  "phishing_links",
] as const;

const HKDF_INFO = "abuse-judge-sampling";

/** The draw's key, derived from the master key like every other token key, so it is never configured or logged. */
export function deriveSamplingKey(masterKey: Buffer): Buffer {
  if (masterKey.length < 16) throw new Error("master key too short to derive from");
  return Buffer.from(hkdfSync("sha256", masterKey, Buffer.alloc(0), HKDF_INFO, 32));
}

/** A keyed fraction in [0, 1) for one message: the same every time, unpredictable without the key. */
export function samplingFraction(key: Buffer, id: string): number {
  const mac = createHmac("sha256", key).update(id).digest();
  return Number(mac.readBigUInt64BE(0) >> 11n) / 2 ** 53;
}

export interface MonitorTeamState {
  sentTotal: number;
  firstSendAt: Date | null;
  plan: string;
  /** A flag opened inside the clean window keeps a team out of Trusted. */
  flaggedRecently: boolean;
  overrideRate: number | null;
  overrideUntil: Date | null;
  risk: number | null;
}

const daysSince = (at: Date | null, now: Date) =>
  at ? (now.getTime() - at.getTime()) / DAY_MS : 0;

function inFirstWindow(state: MonitorTeamState, s: MonitorSettings, now: Date): boolean {
  const hours = state.firstSendAt ? (now.getTime() - state.firstSendAt.getTime()) / 3600_000 : 0;
  return state.sentTotal <= s.firstSends || hours < s.firstHours;
}

export function monitorTier(state: MonitorTeamState, s: MonitorSettings, now: Date): MonitorTier {
  if (state.plan === "system") return "exempt";
  const days = daysSince(state.firstSendAt, now);
  if (inFirstWindow(state, s, now)) return "new";
  if (state.sentTotal <= s.rampSends && days < s.rampDays) return "new";
  if (days < MONITOR_PROBATION_DAYS) return "probation";
  if (
    days >= MONITOR_TRUSTED_DAYS &&
    state.sentTotal >= MONITOR_TRUSTED_SENDS &&
    !state.flaggedRecently
  ) {
    return "trusted";
  }
  return "established";
}

export function activeOverride(state: MonitorTeamState, now: Date): number | null {
  return state.overrideRate !== null && state.overrideUntil !== null && state.overrideUntil > now
    ? state.overrideRate
    : null;
}

export interface RateDecision {
  tier: MonitorTier;
  /** The tier's own rate, before anomalies and the flag multiplier. */
  base: number;
  rate: number;
  kind: MonitorSampleKind;
  /** Why the rate sits above the tier's: elevated by an anomaly, the open flag, or an override. */
  elevated: ("anomaly" | "flagged" | "override")[];
}

/**
 * The rate one accepted message is judged at. The first-sends and first-hours
 * windows force everything through; an override replaces the tier rate; a
 * failing critical or major insight check multiplies it, two force it; a
 * flagged team samples four times as much. Never above 1, never below 0.
 */
export function monitorRate(
  state: MonitorTeamState,
  s: MonitorSettings,
  now: Date,
  opts: { anomalies: number },
): RateDecision {
  const tier = monitorTier(state, s, now);
  if (tier === "exempt") return { tier, base: 0, rate: 0, kind: "tier", elevated: [] };
  const override = activeOverride(state, now);
  let base: number;
  let kind: MonitorSampleKind;
  const elevated: RateDecision["elevated"] = [];
  if (inFirstWindow(state, s, now)) {
    base = 1;
    kind = "first_sends";
  } else if (override !== null) {
    base = override;
    kind = "override";
    elevated.push("override");
  } else if (tier === "new") {
    base = s.rampRate;
    kind = "ramp";
  } else {
    base =
      tier === "probation"
        ? s.probationRate
        : tier === "trusted"
          ? s.trustedRate
          : s.establishedRate;
    kind = "tier";
  }
  let rate = base;
  if (opts.anomalies >= 2) rate = 1;
  else if (opts.anomalies === 1) rate *= s.anomalyMultiplier;
  if (opts.anomalies > 0) {
    elevated.push("anomaly");
    if (kind === "tier" || kind === "ramp") kind = "anomaly";
  }
  if (state.risk !== null && state.risk >= s.flagRisk) {
    rate *= MONITOR_FLAGGED_RATE_MULTIPLIER;
    elevated.push("flagged");
  }
  return { tier, base, rate: Math.min(1, Math.max(0, rate)), kind, elevated };
}

/** Whether one broadcast recipient is among the rendered copies the judge sees. */
export function drawBroadcastCopy(
  key: Buffer,
  broadcastId: string,
  emailId: string,
  copies: number,
  recipients: number,
): boolean {
  return samplingFraction(key, `${broadcastId}:${emailId}`) < copies / Math.max(1, recipients);
}

export interface RiskState {
  riskNum: number;
  riskDen: number;
  riskUpdatedAt: Date | null;
  firstSendAt: Date | null;
}

/**
 * One verdict folded into the decayed mean: what came before is halved
 * every half-life, the new score joins at full weight, and a prior of three
 * pseudo-samples keeps a team with two verdicts from reading as certain.
 */
export function foldRisk(
  state: RiskState,
  score: number,
  now: Date,
): { riskNum: number; riskDen: number; risk: number } {
  const elapsed = state.riskUpdatedAt ? now.getTime() - state.riskUpdatedAt.getTime() : 0;
  const decay = 2 ** (-Math.max(0, elapsed) / MONITOR_RISK_HALF_LIFE_MS);
  const riskNum = state.riskNum * decay + score / 100;
  const riskDen = state.riskDen * decay + 1;
  return { riskNum, riskDen, risk: riskOf(riskNum, riskDen, state.firstSendAt, now) };
}

function riskOf(riskNum: number, riskDen: number, firstSendAt: Date | null, now: Date): number {
  const prior =
    daysSince(firstSendAt, now) < MONITOR_PROBATION_DAYS
      ? MONITOR_PRIOR_NEW
      : MONITOR_PRIOR_SETTLED;
  return (riskNum + prior * MONITOR_PRIOR_WEIGHT) / (riskDen + MONITOR_PRIOR_WEIGHT);
}

/**
 * The risk as of `now`: the stored numerator and denominator decayed since
 * the last verdict, so a team that stopped being sampled drifts back toward
 * the prior instead of keeping the last verdict's reading. Null before the
 * first verdict.
 */
export function riskAt(state: RiskState, now: Date): number | null {
  if (state.riskUpdatedAt === null) return null;
  const decay =
    2 ** (-Math.max(0, now.getTime() - state.riskUpdatedAt.getTime()) / MONITOR_RISK_HALF_LIFE_MS);
  return riskOf(state.riskNum * decay, state.riskDen * decay, state.firstSendAt, now);
}

export interface MonitorDeps {
  samplingKey: Buffer;
  settings: () => Promise<MonitorSettings>;
  enqueueJudge: (sampleId: string) => Promise<void>;
}

type TeamMonitorRow = typeof schema.teamMonitor.$inferSelect;

const tm = schema.teamMonitor;
const ms = schema.monitorSamples;

/**
 * Count the accepted send on the team's monitor row. A row created now for a
 * team that sent before the monitor existed takes its history from the
 * usage counters, so an old team is not judged as brand new.
 */
export async function noteAcceptedSend(db: Db, teamId: string, now: Date): Promise<TeamMonitorRow> {
  const [row] = await db
    .insert(tm)
    .values({ teamId, sentTotal: 1, firstSendAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: tm.teamId,
      set: {
        sentTotal: sql`${tm.sentTotal} + 1`,
        firstSendAt: sql`coalesce(${tm.firstSendAt}, ${now})`,
        updatedAt: now,
      },
    })
    .returning();
  if (!row) throw new Error("team_monitor upsert returned nothing");
  if (row.sentTotal !== 1) return row;
  const c = schema.usageCounters;
  const [history] = await db
    .select({
      sent: sql<number>`coalesce(sum(${c.sent}), 0)::int`,
      first: sql<string | null>`min(${c.day}) filter (where ${c.sent} > 0)`,
    })
    .from(c)
    .where(eq(c.teamId, teamId));
  if (!history || history.sent <= 1) return row;
  // A first day in the past is history the monitor missed; today's counter
  // is the batch this row was created in, and its first send was just now.
  const firstSendAt =
    history.first && history.first < utcDay(now) ? new Date(`${history.first}T00:00:00Z`) : now;
  const [backfilled] = await db
    .update(tm)
    .set({ sentTotal: history.sent, firstSendAt })
    .where(eq(tm.teamId, teamId))
    .returning();
  return backfilled ?? row;
}

const EMPTY_ROW = (teamId: string): TeamMonitorRow => ({
  teamId,
  sentTotal: 0,
  firstSendAt: null,
  risk: null,
  riskNum: 0,
  riskDen: 0,
  riskUpdatedAt: null,
  lastSampleAt: null,
  overrideRate: null,
  overrideUntil: null,
  broadcastsPausedAt: null,
  broadcastsResumedAt: null,
  heldAt: null,
  alertedAt: null,
  updatedAt: new Date(0),
});

export async function teamMonitorRow(db: Db, teamId: string): Promise<TeamMonitorRow> {
  const [row] = await db.select().from(tm).where(eq(tm.teamId, teamId));
  return row ?? EMPTY_ROW(teamId);
}

/** The tier inputs for a team: its monitor row plus the plan and, when it could be Trusted, its recent flags. */
export async function loadMonitorState(
  db: Db,
  row: TeamMonitorRow,
  now: Date,
): Promise<MonitorTeamState> {
  const [team] = await db
    .select({ plan: schema.teams.plan })
    .from(schema.teams)
    .where(eq(schema.teams.id, row.teamId));
  const couldBeTrusted =
    row.sentTotal >= MONITOR_TRUSTED_SENDS &&
    daysSince(row.firstSendAt, now) >= MONITOR_TRUSTED_DAYS;
  let flaggedRecently = false;
  if (couldBeTrusted) {
    const f = schema.teamFlags;
    const [flag] = await db
      .select({ id: f.id })
      .from(f)
      .where(
        and(
          eq(f.teamId, row.teamId),
          gte(f.openedAt, new Date(now.getTime() - MONITOR_TRUSTED_CLEAN_DAYS * DAY_MS)),
        ),
      )
      .limit(1);
    flaggedRecently = flag !== undefined;
  }
  return {
    sentTotal: row.sentTotal,
    firstSendAt: row.firstSendAt,
    plan: (team?.plan as string | undefined) ?? "free",
    flaggedRecently,
    overrideRate: row.overrideRate,
    overrideUntil: row.overrideUntil,
    risk: riskAt(row, now),
  };
}

const dayStart = (now: Date) => new Date(`${utcDay(now)}T00:00:00Z`);

/**
 * Write the pending sample and hand it to the judge queue, unless a daily
 * cap says no. The team cap stops every kind; the instance cap spares the
 * first-sends and anomaly kinds, which are the ones worth the most.
 */
export async function recordMonitorSample(
  db: Db,
  deps: MonitorDeps,
  s: MonitorSettings,
  input: {
    teamId: string;
    emailId: string | null;
    broadcastId: string | null;
    kind: MonitorSampleKind;
    now: Date;
  },
): Promise<string | null> {
  const since = dayStart(input.now);
  const [team] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(ms)
    .where(and(eq(ms.teamId, input.teamId), gte(ms.createdAt, since)));
  if ((team?.n ?? 0) >= s.teamDailyCap) return null;
  if (input.kind !== "first_sends" && input.kind !== "anomaly") {
    const [all] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(ms)
      .where(gte(ms.createdAt, since));
    if ((all?.n ?? 0) >= s.instanceDailyCap) return null;
  }
  const [sample] = await db
    .insert(ms)
    .values({
      teamId: input.teamId,
      emailId: input.emailId,
      broadcastId: input.broadcastId,
      kind: input.kind,
      createdAt: input.now,
    })
    .returning({ id: ms.id });
  if (!sample) throw new Error("monitor sample insert returned nothing");
  await db
    .insert(tm)
    .values({ teamId: input.teamId, lastSampleAt: input.now, updatedAt: input.now })
    .onConflictDoUpdate({ target: tm.teamId, set: { lastSampleAt: input.now } });
  await deps.enqueueJudge(sample.id);
  return sample.id;
}

/**
 * The hook behind every accepted transactional send: count it, draw, and
 * queue the judge when the draw picks it. Broadcast recipients count here
 * too but are drawn at fan-out as rendered copies, never per recipient.
 */
export async function sampleAcceptedEmail(
  db: Db,
  deps: MonitorDeps,
  input: { teamId: string; emailId: string; broadcast: boolean; anomalies: number; now?: Date },
): Promise<{ sampleId: string | null; decision: RateDecision | null }> {
  const now = input.now ?? new Date();
  const row = await noteAcceptedSend(db, input.teamId, now);
  if (input.broadcast) return { sampleId: null, decision: null };
  const s = await deps.settings();
  const decision = monitorRate(await loadMonitorState(db, row, now), s, now, {
    anomalies: input.anomalies,
  });
  if (
    decision.rate <= 0 ||
    samplingFraction(deps.samplingKey, `${input.teamId}:${input.emailId}`) >= decision.rate
  ) {
    return { sampleId: null, decision };
  }
  const sampleId = await recordMonitorSample(db, deps, s, {
    teamId: input.teamId,
    emailId: input.emailId,
    broadcastId: null,
    kind: decision.kind,
    now,
  });
  return { sampleId, decision };
}

/** At fan-out start: the broadcast's own HTML as the skeleton, and how many rendered copies to draw. */
export async function planBroadcastSamples(
  db: Db,
  deps: MonitorDeps,
  input: { teamId: string; broadcastId: string; now?: Date },
): Promise<{ skeletonSampleId: string | null; copies: number }> {
  const now = input.now ?? new Date();
  const s = await deps.settings();
  const state = await loadMonitorState(db, await teamMonitorRow(db, input.teamId), now);
  const tier = monitorTier(state, s, now);
  if (tier === "exempt") return { skeletonSampleId: null, copies: 0 };
  // A resumed fan-out plans again; the skeleton was judged the first time.
  const [existing] = await db
    .select({ id: ms.id })
    .from(ms)
    .where(and(eq(ms.broadcastId, input.broadcastId), eq(ms.kind, "broadcast_skeleton")))
    .limit(1);
  const skeletonSampleId =
    existing?.id ??
    (await recordMonitorSample(db, deps, s, {
      teamId: input.teamId,
      emailId: null,
      broadcastId: input.broadcastId,
      kind: "broadcast_skeleton",
      now,
    }));
  return {
    skeletonSampleId,
    copies: tier === "new" || tier === "probation" ? s.broadcastCopiesNew : s.broadcastCopies,
  };
}

export interface VerdictOutcome {
  risk: number;
  tier: MonitorTier;
  /** The operator is emailed now: the risk crossed the alert line and no alert went out today. */
  alert: boolean;
  /** Broadcasts were paused now by the policy. */
  paused: boolean;
  /** The team was suspended for review now by the hold policy, under this rule. */
  held: HoldRule | null;
}

/** One verdict from `holdScore`, or the `verdicts`th from `holdRepeatScore` in the first week of sending. */
export type HoldRule = { rule: "score" } | { rule: "repeat"; verdicts: number };

/** A verdict as the judge returns it or as its sample stores it. */
interface HoldVerdictFields {
  score: number | null;
  verdict: string | null;
  categories: readonly string[] | null;
  reasons: readonly string[] | null;
}

/** One verdict is a phishing-type abuse call from `holdScore`. */
export function isHoldVerdict(v: HoldVerdictFields, holdScore: number): boolean {
  return (
    v.verdict === "abuse" &&
    v.score !== null &&
    v.score >= holdScore &&
    ((v.categories ?? []).some((c) => (MONITOR_HOLD_CATEGORIES as readonly string[]).includes(c)) ||
      (v.reasons ?? []).some((r) => (MONITOR_HOLD_REASONS as readonly string[]).includes(r)))
  );
}

/**
 * The repeat hold: this verdict is at least the `holdRepeatCount`th
 * phishing-type one from `holdRepeatScore` judged in the team's first week
 * of sending. The stored verdicts include this one: the judge writes it in
 * the transaction that folds it.
 */
async function repeatHold(
  db: Db,
  s: MonitorSettings,
  row: Pick<TeamMonitorRow, "teamId" | "firstSendAt">,
  verdict: HoldVerdictFields,
  now: Date,
): Promise<HoldRule | null> {
  if (s.holdRepeatCount === 0 || !row.firstSendAt || !isHoldVerdict(verdict, s.holdRepeatScore)) {
    return null;
  }
  const until = new Date(row.firstSendAt.getTime() + MONITOR_HOLD_REPEAT_DAYS * DAY_MS);
  if (now >= until) return null;
  const judged = await db
    .select({
      score: ms.score,
      verdict: ms.verdict,
      categories: ms.categories,
      reasons: ms.reasons,
    })
    .from(ms)
    .where(
      and(
        eq(ms.teamId, row.teamId),
        eq(ms.status, "judged"),
        gte(ms.score, s.holdRepeatScore),
        lt(ms.judgedAt, until),
      ),
    );
  const verdicts = judged.filter((v) => isHoldVerdict(v, s.holdRepeatScore)).length;
  return verdicts >= s.holdRepeatCount ? { rule: "repeat", verdicts } : null;
}

/**
 * A judged sample's score folded into the team's risk, then the thresholds.
 * The flag itself is the safety cron's (it reads the risk off the
 * standings); this writes the alert stamp and, for a new team, the policies:
 * the broadcast pause (the monitor's own column and the operator hold every
 * send surface already honours) and, on a confident phishing verdict or the
 * repeat hold's count of them, the review hold (a suspension, with the flag
 * that keeps it on the list).
 */
export async function applyJudgedSample(
  db: Db,
  s: MonitorSettings,
  input: {
    teamId: string;
    score: number;
    verdict?: Pick<JudgeVerdict, "verdict" | "categories" | "reasons"> | undefined;
    now?: Date;
  },
): Promise<VerdictOutcome> {
  const now = input.now ?? new Date();
  // Judge lanes run side by side; the team's fold is serialised on an
  // advisory lock held to the end of the transaction, so no verdict is lost
  // to a stale read and the alert and pause fire once.
  const outcome = await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    await t.execute(sql`select pg_advisory_xact_lock(hashtext(${input.teamId}))`);
    const row = await teamMonitorRow(t, input.teamId);
    const next = foldRisk(row, input.score, now);
    await t
      .insert(tm)
      .values({ teamId: input.teamId, ...next, riskUpdatedAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: tm.teamId,
        set: { ...next, riskUpdatedAt: now, updatedAt: now },
      });
    const tier = monitorTier(await loadMonitorState(t, { ...row, risk: next.risk }, now), s, now);
    let held: HoldRule | null = null;
    const verdict = input.verdict && { ...input.verdict, score: input.score };
    const rule =
      s.autoHold && tier === "new" && row.heldAt === null && verdict
        ? isHoldVerdict(verdict, s.holdScore)
          ? ({ rule: "score" } as const)
          : await repeatHold(t, s, row, verdict, now)
        : null;
    if (rule) {
      // A standing suspension is the operator's call and stays as it is.
      const suspended = await suspendTeam(t, {
        teamId: input.teamId,
        reason: "review",
        now,
        ifNotSuspended: true,
      });
      if (suspended) {
        held = rule;
        await t.update(tm).set({ heldAt: now }).where(eq(tm.teamId, input.teamId));
        const samples = await monitorSamplesByTeam(t, [input.teamId], now);
        await t
          .insert(schema.teamFlags)
          .values({
            teamId: input.teamId,
            reason: "monitor",
            detail: {
              risk: Number(next.risk.toFixed(3)),
              samples: samples.get(input.teamId) ?? 1,
            },
            openedAt: now,
          })
          .onConflictDoNothing();
      }
    }
    let alert = false;
    if (next.risk >= s.alertRisk) {
      const stamped = await t
        .update(tm)
        .set({ alertedAt: now })
        .where(
          and(
            eq(tm.teamId, input.teamId),
            or(
              isNull(tm.alertedAt),
              lte(tm.alertedAt, new Date(now.getTime() - MONITOR_ALERT_INTERVAL_MS)),
            ),
          ),
        )
        .returning({ teamId: tm.teamId });
      alert = stamped.length > 0;
    }
    let paused = false;
    // A team held for review is never paused by the policy, during the hold
    // or after its release: the backlog sampled before the hold is judged
    // after it and keeps the risk past the line, so a pause would outlive the
    // release and park the broadcasts the release let go.
    if (
      s.autoPause &&
      tier === "new" &&
      next.risk >= s.pauseRisk &&
      row.broadcastsPausedAt === null &&
      held === null &&
      row.heldAt === null &&
      (await fetchTeamStanding(t, input.teamId))?.suspended?.reason !== "review"
    ) {
      // Only verdicts since the operator last resumed count: a reviewed
      // episode's evidence must not pause the team again on its own.
      const since = new Date(
        Math.max(
          now.getTime() - MONITOR_PAUSE_VERDICT_WINDOW_MS,
          row.broadcastsResumedAt?.getTime() ?? 0,
        ),
      );
      const [hot] = await t
        .select({ n: sql<number>`count(*)::int` })
        .from(ms)
        .where(
          and(
            eq(ms.teamId, input.teamId),
            eq(ms.status, "judged"),
            gte(ms.score, MONITOR_PAUSE_VERDICT_SCORE),
            gte(ms.judgedAt, since),
          ),
        );
      if ((hot?.n ?? 0) > 0 || input.score >= MONITOR_PAUSE_VERDICT_SCORE) {
        // A team the operator already holds is theirs; the policy only
        // stamps a team nothing else holds, so its Resume lifts its own hold.
        const stamped = await t
          .update(schema.teams)
          .set({ broadcastsPausedByOperatorAt: now })
          .where(
            and(
              eq(schema.teams.id, input.teamId),
              isNull(schema.teams.broadcastsPausedByOperatorAt),
            ),
          )
          .returning({ id: schema.teams.id });
        if (stamped.length > 0) {
          await t.update(tm).set({ broadcastsPausedAt: now }).where(eq(tm.teamId, input.teamId));
          paused = true;
        }
      }
    }
    return { risk: next.risk, tier, alert, paused, held };
  });
  if (outcome.held) {
    await recordAudit(db, {
      teamId: input.teamId,
      actor: "system",
      action: "team.held_for_review",
      target: { type: "team", id: input.teamId },
    });
  }
  if (outcome.paused) {
    await recordAudit(db, {
      teamId: input.teamId,
      actor: "system",
      action: "monitor.broadcasts_paused",
      target: { type: "team", id: input.teamId },
      metadata: { risk: Number(outcome.risk.toFixed(3)), score: input.score, tier: outcome.tier },
    });
  }
  return outcome;
}

/** The review page's Resume: lifts the monitor's pause and the operator hold it rode on. */
export async function resumeMonitorPause(
  db: Db,
  input: { teamId: string; actor: { userId: string } },
): Promise<boolean> {
  const [row] = await db
    .update(tm)
    .set({ broadcastsPausedAt: null, broadcastsResumedAt: new Date() })
    .where(and(eq(tm.teamId, input.teamId), sql`${tm.broadcastsPausedAt} is not null`))
    .returning({ teamId: tm.teamId });
  if (!row) return false;
  await db
    .update(schema.teams)
    .set({ broadcastsPausedByOperatorAt: null })
    .where(eq(schema.teams.id, input.teamId));
  await recordAudit(db, {
    teamId: input.teamId,
    actor: input.actor,
    action: "monitor.broadcasts_resumed",
    target: { type: "team", id: input.teamId },
  });
  return true;
}

export const MONITOR_OVERRIDE_DAYS = 7;

/** "Sample everything for 7 days": rate 1 until a week from now, audited. */
export async function setMonitorOverride(
  db: Db,
  input: { teamId: string; rate: number; until: Date; actor: { userId: string } },
): Promise<void> {
  await db
    .insert(tm)
    .values({ teamId: input.teamId, overrideRate: input.rate, overrideUntil: input.until })
    .onConflictDoUpdate({
      target: tm.teamId,
      set: { overrideRate: input.rate, overrideUntil: input.until, updatedAt: new Date() },
    });
  await recordAudit(db, {
    teamId: input.teamId,
    actor: input.actor,
    action: "monitor.override_set",
    target: { type: "team", id: input.teamId },
    metadata: { rate: input.rate, until: input.until.toISOString() },
  });
}

export async function clearMonitorOverride(
  db: Db,
  input: { teamId: string; actor: { userId: string } },
): Promise<void> {
  await db
    .update(tm)
    .set({ overrideRate: null, overrideUntil: null, updatedAt: new Date() })
    .where(eq(tm.teamId, input.teamId));
  await recordAudit(db, {
    teamId: input.teamId,
    actor: input.actor,
    action: "monitor.override_cleared",
    target: { type: "team", id: input.teamId },
  });
}

/** The last hour's samples and how many the judge could not answer. */
export async function monitorHealth(
  db: Db,
  now: Date = new Date(),
): Promise<{ samples: number; unjudged: number; unjudgedRate: number | null }> {
  const [row] = await db
    .select({
      samples: sql<number>`count(*)::int`,
      unjudged: sql<number>`count(*) filter (where ${ms.status} = 'unjudged')::int`,
    })
    .from(ms)
    .where(gte(ms.createdAt, new Date(now.getTime() - 3600_000)));
  const samples = row?.samples ?? 0;
  const unjudged = row?.unjudged ?? 0;
  return { samples, unjudged, unjudgedRate: samples > 0 ? unjudged / samples : null };
}

/** Pending samples whose job never came back are unjudged, not lost in a count. */
export async function markLostSamples(db: Db, now: Date = new Date()): Promise<number> {
  const rows = await db
    .update(ms)
    .set({ status: "unjudged", errorClass: "lost", judgedAt: now })
    .where(
      and(
        eq(ms.status, "pending"),
        sql`${ms.createdAt} < ${new Date(now.getTime() - MONITOR_LOST_AFTER_MS)}`,
      ),
    )
    .returning({ id: ms.id });
  return rows.length;
}

export async function pruneMonitorSamples(db: Db, now: Date = new Date()): Promise<number> {
  const rows = await db
    .delete(ms)
    .where(
      sql`${ms.createdAt} < ${new Date(now.getTime() - MONITOR_SAMPLE_RETENTION_DAYS * DAY_MS)}`,
    )
    .returning({ id: ms.id });
  return rows.length;
}

/** Today's tallies for the console: drawn, answered, unanswered, and answered over the flag line. */
export async function monitorDayCounts(
  db: Db,
  s: Pick<MonitorSettings, "flagScore">,
  now: Date = new Date(),
): Promise<{ sampled: number; judged: number; unjudged: number; flagged: number }> {
  const [row] = await db
    .select({
      sampled: sql<number>`count(*)::int`,
      judged: sql<number>`count(*) filter (where ${ms.status} = 'judged')::int`,
      unjudged: sql<number>`count(*) filter (where ${ms.status} = 'unjudged')::int`,
      flagged: sql<number>`count(*) filter (where ${ms.status} = 'judged' and ${ms.score} >= ${s.flagScore})::int`,
    })
    .from(ms)
    .where(gte(ms.createdAt, dayStart(now)));
  return row ?? { sampled: 0, judged: 0, unjudged: 0, flagged: 0 };
}

/** Per team, the judged samples of the last week; what the monitor flag's label counts. */
export async function monitorSamplesByTeam(
  db: Db,
  teamIds: readonly string[],
  now: Date = new Date(),
): Promise<Map<string, number>> {
  if (teamIds.length === 0) return new Map();
  const rows = await db
    .select({ teamId: ms.teamId, n: sql<number>`count(*)::int` })
    .from(ms)
    .where(
      and(
        inArray(ms.teamId, [...teamIds]),
        eq(ms.status, "judged"),
        gte(ms.createdAt, new Date(now.getTime() - 7 * DAY_MS)),
      ),
    )
    .groupBy(ms.teamId);
  return new Map(rows.map((r) => [r.teamId, r.n]));
}

export interface TeamMonitorOverview {
  tier: MonitorTier;
  decision: RateDecision;
  risk: number | null;
  sentTotal: number;
  firstSendAt: Date | null;
  lastSampleAt: Date | null;
  samples7d: number;
  judged7d: number;
  flagged7d: number;
  unjudged7d: number;
  /** The reason codes the flagged verdicts gave, most frequent first. */
  topReasons: string[];
  override: { rate: number; until: Date } | null;
  broadcastsPausedAt: Date | null;
}

/** Everything the review page's Monitoring card shows for one team. */
export async function teamMonitorOverview(
  db: Db,
  teamId: string,
  s: MonitorSettings,
  now: Date = new Date(),
): Promise<TeamMonitorOverview> {
  const row = await teamMonitorRow(db, teamId);
  const state = await loadMonitorState(db, row, now);
  const decision = monitorRate(state, s, now, { anomalies: 0 });
  const week = new Date(now.getTime() - 7 * DAY_MS);
  const [counts] = await db
    .select({
      samples: sql<number>`count(*)::int`,
      judged: sql<number>`count(*) filter (where ${ms.status} = 'judged')::int`,
      unjudged: sql<number>`count(*) filter (where ${ms.status} = 'unjudged')::int`,
      flagged: sql<number>`count(*) filter (where ${ms.status} = 'judged' and ${ms.score} >= ${s.flagScore})::int`,
    })
    .from(ms)
    .where(and(eq(ms.teamId, teamId), gte(ms.createdAt, week)));
  const flagged = await db
    .select({ reasons: ms.reasons })
    .from(ms)
    .where(
      and(
        eq(ms.teamId, teamId),
        eq(ms.status, "judged"),
        gte(ms.score, s.flagScore),
        gte(ms.createdAt, week),
      ),
    );
  const tally = new Map<string, number>();
  for (const f of flagged) for (const r of f.reasons ?? []) tally.set(r, (tally.get(r) ?? 0) + 1);
  const override = activeOverride(state, now);
  return {
    tier: decision.tier,
    decision,
    risk: state.risk,
    sentTotal: row.sentTotal,
    firstSendAt: row.firstSendAt,
    lastSampleAt: row.lastSampleAt,
    samples7d: counts?.samples ?? 0,
    judged7d: counts?.judged ?? 0,
    flagged7d: counts?.flagged ?? 0,
    unjudged7d: counts?.unjudged ?? 0,
    topReasons: [...tally.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([r]) => r),
    override:
      override !== null && row.overrideUntil ? { rate: override, until: row.overrideUntil } : null,
    broadcastsPausedAt: row.broadcastsPausedAt,
  };
}

/** The newest samples of a team: kind, verdict or error class, never any content. */
export async function recentMonitorSamples(db: Db, teamId: string, limit = 20) {
  return db
    .select({
      id: ms.id,
      emailId: ms.emailId,
      broadcastId: ms.broadcastId,
      kind: ms.kind,
      status: ms.status,
      score: ms.score,
      verdict: ms.verdict,
      reasons: ms.reasons,
      errorClass: ms.errorClass,
      model: ms.model,
      createdAt: ms.createdAt,
      judgedAt: ms.judgedAt,
    })
    .from(ms)
    .where(eq(ms.teamId, teamId))
    .orderBy(desc(ms.createdAt))
    .limit(limit);
}

/** The flag line when the caller has no settings at hand. */
export const MONITOR_FLAG_RISK_DEFAULT = MONITOR_SETTING_DEFAULTS.flagRisk;
