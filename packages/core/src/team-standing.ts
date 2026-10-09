import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import {
  type DeliverabilityReason,
  fetchDeliverabilityHealth,
  PAUSE_BOUNCE_RATE,
  PAUSE_COMPLAINT_RATE,
} from "./deliverability.js";

export type SuspensionReason = (typeof schema.suspensionReasonEnum.enumValues)[number];
export const SUSPENSION_REASONS = schema.suspensionReasonEnum.enumValues;

/** The operator overrides on a team that every send surface honours. */
export interface TeamStanding {
  suspended: { at: Date; reason: SuspensionReason; note: string | null } | null;
  broadcastsPausedByOperatorAt: Date | null;
  dailySendCeiling: number | null;
}

/** The columns fetchTeamStanding reads, for callers that already select the team row. */
export const STANDING_COLUMNS = {
  suspendedAt: schema.teams.suspendedAt,
  suspensionReason: schema.teams.suspensionReason,
  suspensionNote: schema.teams.suspensionNote,
  broadcastsPausedByOperatorAt: schema.teams.broadcastsPausedByOperatorAt,
  dailySendCeiling: schema.teams.dailySendCeiling,
} as const;

export function teamStandingOf(row: {
  suspendedAt: Date | null;
  suspensionReason: SuspensionReason | null;
  suspensionNote: string | null;
  broadcastsPausedByOperatorAt: Date | null;
  dailySendCeiling: number | null;
}): TeamStanding {
  return {
    suspended:
      row.suspendedAt && row.suspensionReason
        ? { at: row.suspendedAt, reason: row.suspensionReason, note: row.suspensionNote }
        : null,
    broadcastsPausedByOperatorAt: row.broadcastsPausedByOperatorAt,
    dailySendCeiling: row.dailySendCeiling,
  };
}

/** A team's operator overrides; null when the team does not exist. */
export async function fetchTeamStanding(db: Db, teamId: string): Promise<TeamStanding | null> {
  const [row] = await db
    .select(STANDING_COLUMNS)
    .from(schema.teams)
    .where(eq(schema.teams.id, teamId));
  return row ? teamStandingOf(row) : null;
}

/**
 * Read per send rather than carried on the API key: a suspension must bite
 * on the next message, not the next authentication.
 */
export async function isTeamSuspended(db: Db, teamId: string): Promise<boolean> {
  const [row] = await db
    .select({ suspendedAt: schema.teams.suspendedAt })
    .from(schema.teams)
    .where(eq(schema.teams.id, teamId));
  return row?.suspendedAt != null;
}

/** Why a team may not take new mail right now. */
export type SendRefusal =
  | { reason: "team_suspended" }
  | { reason: "sending_paused"; pause: DeliverabilityReason };

/**
 * The team-level admission every accept path applies (acceptEmail, and
 * broadcast initiation beside its broadcast-only holds): an operator
 * suspension, then the deliverability pause, a trailing rate at SES's own
 * review line ("warning" never blocks). Null when the team may send.
 */
export async function sendRefusal(db: Db, teamId: string): Promise<SendRefusal | null> {
  if (await isTeamSuspended(db, teamId)) return { reason: "team_suspended" };
  const health = await fetchDeliverabilityHealth(db, teamId);
  const pause = health.reasons.find((r) => r.tier === "paused");
  return pause ? { reason: "sending_paused", pause } : null;
}

/** The refusal in words for the API and the SMTP relay; the dashboard words it from its catalogs. */
export function sendRefusalMessage(refusal: SendRefusal): string {
  if (refusal.reason === "team_suspended") {
    return "This team is suspended by the instance operator. Sending is disabled until it is reinstated.";
  }
  const { metric, rate, windowDays } = refusal.pause;
  const limit = metric === "bounce" ? PAUSE_BOUNCE_RATE : PAUSE_COMPLAINT_RATE;
  return `Sending is paused: your ${metric === "bounce" ? "hard bounce" : "complaint"} rate of ${(rate * 100).toFixed(2)}% over the last ${windowDays} days is at or above the ${(limit * 100).toFixed(2)}% limit. Lower it before sending again.`;
}

/**
 * Whether the deliverability pause holds mail a team already has waiting,
 * at send time and in the drain: what was accepted before the team crossed
 * the line (a schedule can sit 30 days) must not reach SES while it is past
 * it. The instance's own (system) team is exempt: its account mail must go
 * out whatever its rates.
 */
export async function deliverabilityHold(db: Db, teamId: string): Promise<boolean> {
  const [team] = await db
    .select({ plan: schema.teams.plan })
    .from(schema.teams)
    .where(eq(schema.teams.id, teamId));
  if (!team || team.plan === "system") return false;
  return (await fetchDeliverabilityHealth(db, teamId)).status === "paused";
}
