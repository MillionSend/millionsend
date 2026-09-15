import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import type { TeamFlagDetail } from "@millionsend/db/schema";
import { and, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { fetchAccountScore } from "./account-score.js";
import {
  type DeliverabilityHealth,
  type DeliverabilityStatus,
  fetchDeliverabilityHealth,
  GUARDRAIL_WINDOW_DAYS,
  MIN_GUARDRAIL_VOLUME,
} from "./deliverability.js";
import { DAY_MS, utcDay } from "./utc-day.js";

export type TeamFlagReason = (typeof schema.teamFlagReasonEnum.enumValues)[number];
export type TeamFlagStatus = (typeof schema.teamFlagStatusEnum.enumValues)[number];
export const TEAM_FLAG_REASONS = schema.teamFlagReasonEnum.enumValues;

/**
 * The automatic trust & safety triggers, on the 7-day rates the guardrail
 * shows the team itself. Complaints flag at SES's own review line, hard
 * bounces at its 5% line, both only past the guardrail's volume floor so a
 * handful of sends cannot flag a team; a score under 5 is the "at risk"
 * band of the account score.
 */
export const FLAG_COMPLAINT_RATE = 0.001;
export const FLAG_HARD_BOUNCE_RATE = 0.05;
export const FLAG_SCORE_TENTHS = 50;
/** Teams that sent in this many days get a standing row; the others have nothing to judge. */
export const STANDING_WINDOW_DAYS = 30;

export interface TeamStandingRow {
  teamId: string;
  scoreTenths: number | null;
  guardrail: DeliverabilityStatus;
  guardrailMetric: "complaint" | "hard_bounce" | null;
  complaintRate7d: number;
  hardBounceRate7d: number;
  sent7d: number;
  sent30d: number;
}

/**
 * The standing of every team that sent in the window, computed the way the
 * team's own Metrics page computes it (one guardrail read and one account
 * score per team). Hundreds of teams is a few seconds; the cron owns it.
 * ponytail: unpaged, one team at a time; batch the counter sums if the
 * instance ever holds tens of thousands of active teams.
 */
export async function computeTeamStandings(
  db: Db,
  now: Date = new Date(),
): Promise<TeamStandingRow[]> {
  const c = schema.usageCounters;
  const since = utcDay(now.getTime() - (STANDING_WINDOW_DAYS - 1) * DAY_MS);
  const active = await db
    .select({ teamId: c.teamId, sent30d: sql<number>`coalesce(sum(${c.sent}), 0)::int` })
    .from(c)
    .where(gte(c.day, since))
    .groupBy(c.teamId)
    .having(sql`sum(${c.sent}) > 0`);
  const rows: TeamStandingRow[] = [];
  for (const team of active) {
    const [health, score] = await Promise.all([
      fetchDeliverabilityHealth(db, team.teamId, { now }),
      fetchAccountScore(db, team.teamId, { now }),
    ]);
    rows.push({
      teamId: team.teamId,
      scoreTenths: score.scoreTenths,
      guardrail: health.status,
      guardrailMetric: guardrailMetricOf(health),
      complaintRate7d: health.complaintRate,
      hardBounceRate7d: health.bounceRate,
      sent7d: health.sent,
      sent30d: team.sent30d,
    });
  }
  return rows;
}

/** The metric behind the guardrail's standing: the pause reason when paused, else the warning's. */
function guardrailMetricOf(health: DeliverabilityHealth): TeamStandingRow["guardrailMetric"] {
  if (health.status === "ok") return null;
  const reason = health.reasons.find((r) => r.tier === health.status) ?? health.reasons[0] ?? null;
  return reason === null ? null : reason.metric === "bounce" ? "hard_bounce" : "complaint";
}

export async function saveTeamStandings(
  db: Db,
  rows: readonly TeamStandingRow[],
  now: Date = new Date(),
): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(schema.teamStandings)
    .values(rows.map((r) => ({ ...r, computedAt: now })))
    .onConflictDoUpdate({
      target: schema.teamStandings.teamId,
      set: {
        scoreTenths: sql`excluded.score_tenths`,
        guardrail: sql`excluded.guardrail`,
        guardrailMetric: sql`excluded.guardrail_metric`,
        complaintRate7d: sql`excluded.complaint_rate_7d`,
        hardBounceRate7d: sql`excluded.hard_bounce_rate_7d`,
        sent7d: sql`excluded.sent_7d`,
        sent30d: sql`excluded.sent_30d`,
        computedAt: now,
      },
    });
}

/** Drop the rows a run did not refresh: a team that stopped sending has no standing, not a frozen one. */
export async function pruneTeamStandings(db: Db, refreshedAt: Date): Promise<number> {
  const gone = await db
    .delete(schema.teamStandings)
    .where(lt(schema.teamStandings.computedAt, refreshedAt))
    .returning({ teamId: schema.teamStandings.teamId });
  return gone.length;
}

export interface FlagTrigger {
  reason: TeamFlagReason;
  detail: TeamFlagDetail;
}

/** The trigger a standing fires, strongest first; null when the team is fine. */
export function flagTrigger(s: TeamStandingRow): FlagTrigger | null {
  if (s.guardrail !== "ok") {
    const metric =
      s.guardrailMetric ??
      (s.hardBounceRate7d >= FLAG_HARD_BOUNCE_RATE ? "hard_bounce" : "complaint");
    return {
      reason: "guardrail",
      detail: {
        guardrail: s.guardrail,
        metric,
        rate: metric === "hard_bounce" ? s.hardBounceRate7d : s.complaintRate7d,
      },
    };
  }
  if (s.sent7d >= MIN_GUARDRAIL_VOLUME) {
    if (s.complaintRate7d >= FLAG_COMPLAINT_RATE) {
      return { reason: "complaints", detail: { metric: "complaint", rate: s.complaintRate7d } };
    }
    if (s.hardBounceRate7d >= FLAG_HARD_BOUNCE_RATE) {
      return { reason: "complaints", detail: { metric: "hard_bounce", rate: s.hardBounceRate7d } };
    }
  }
  if (s.scoreTenths !== null && s.scoreTenths < FLAG_SCORE_TENTHS) {
    return { reason: "score", detail: { metric: "score", scoreTenths: s.scoreTenths } };
  }
  return null;
}

/**
 * Bring the automatic flags in line with the standings. A team with a
 * trigger and no open flag gets one, unless an operator cleared a flag for
 * the same reason and the trigger has held since (their call stands; a
 * trigger that lapsed and came back is a new finding, judged against the
 * previous run's standings, so `previous` must be the rows saved before this
 * run's); an open automatic flag whose trigger is gone is cleared; an
 * operator's manual flag is never touched. `opened_at` of an open flag is
 * left alone so the list's "since" holds still.
 */
export async function syncTeamFlags(
  db: Db,
  standings: readonly TeamStandingRow[],
  now: Date = new Date(),
  previous?: readonly TeamStandingRow[],
): Promise<{ opened: number; cleared: number }> {
  const f = schema.teamFlags;
  const open = await db.select().from(f).where(eq(f.status, "open"));
  const before = new Map(
    (previous ?? (await db.select().from(schema.teamStandings))).map((row) => [row.teamId, row]),
  );
  const openByTeam = new Map(open.map((row) => [row.teamId, row]));
  const triggered = new Map(
    standings.flatMap((s) => {
      const trigger = flagTrigger(s);
      return trigger ? [[s.teamId, trigger] as const] : [];
    }),
  );
  let opened = 0;
  let cleared = 0;
  for (const [teamId, trigger] of triggered) {
    const current = openByTeam.get(teamId);
    if (current) {
      if (current.openedBy === null && current.reason !== trigger.reason) {
        await db
          .update(f)
          .set({ reason: trigger.reason, detail: trigger.detail })
          .where(eq(f.id, current.id));
      }
      continue;
    }
    const [latest] = await db
      .select({ reason: f.reason, clearedBy: f.clearedBy })
      .from(f)
      .where(eq(f.teamId, teamId))
      .orderBy(desc(f.openedAt))
      .limit(1);
    const prior = before.get(teamId);
    const held = prior !== undefined && flagTrigger(prior)?.reason === trigger.reason;
    if (held && latest?.clearedBy && latest.reason === trigger.reason) continue;
    await db.insert(f).values({
      teamId,
      reason: trigger.reason,
      detail: trigger.detail,
      openedAt: now,
    });
    opened += 1;
  }
  const stale = open.filter((row) => row.openedBy === null && !triggered.has(row.teamId));
  if (stale.length > 0) {
    await db
      .update(f)
      .set({ status: "cleared", clearedAt: now, clearedBy: null })
      .where(
        and(
          inArray(
            f.id,
            stale.map((row) => row.id),
          ),
          isNull(f.openedBy),
        ),
      );
    cleared = stale.length;
  }
  return { opened, cleared };
}

/** The guardrail window the automatic rates are measured over. */
export const FLAG_WINDOW_DAYS = GUARDRAIL_WINDOW_DAYS;
