import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { recordContactActivity } from "./contact-activities.js";
import { unsubscribeSuspendedMembers } from "./system-contacts.js";

export type SuspensionReason = (typeof schema.suspensionReasonEnum.enumValues)[number];
export const SUSPENSION_REASONS = schema.suspensionReasonEnum.enumValues;

/**
 * Suspensions the team must not learn of: no automated mail about it goes
 * out, billing included, and its people cannot start another team. Plain
 * strings, so the content monitor's `review` hold applies as soon as the
 * schema has that reason.
 */
export const SILENT_SUSPENSIONS: readonly string[] = ["phishing", "review"];

/**
 * Suspensions over the rules, which take the team's people off the
 * instance's own contact list. A review hold is still pending a verdict, and
 * non_payment is a billing state.
 */
export const UNSUBSCRIBING_SUSPENSIONS: readonly string[] = ["manual", "reputation", "phishing"];

/** Whether the team row is under a silent suspension. */
export function isSilentlySuspended(team: {
  suspendedAt: Date | null;
  suspensionReason: string | null;
}): boolean {
  return team.suspendedAt !== null && SILENT_SUSPENSIONS.includes(team.suspensionReason ?? "");
}

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

/**
 * Suspends a team; every send surface reads the row per send. A standing
 * suspension keeps its original suspended_at and takes the new reason,
 * unless `ifNotSuspended` leaves it as it is. True when the row changed; the
 * audit, mail, flag and SES tenant are the caller's.
 *
 * Moving into a suspension over the rules unsubscribes the team's people in
 * the same transaction, so a retry after a failure never finds the team
 * suspended and its people still subscribed. A suspension already over the
 * rules has done it once: a person who opted back in since stays in.
 */
export async function suspendTeam(
  db: Db,
  input: {
    teamId: string;
    reason: SuspensionReason;
    note?: string | null | undefined;
    now?: Date | undefined;
    ifNotSuspended?: boolean | undefined;
  },
): Promise<boolean> {
  const t = schema.teams;
  const timeline = await db.transaction(async (tx) => {
    const [before] = await tx
      .select({ reason: t.suspensionReason })
      .from(t)
      .where(eq(t.id, input.teamId))
      .for("update");
    const changed = await tx
      .update(t)
      .set({
        suspendedAt: sql`coalesce(${t.suspendedAt}, ${input.now ?? new Date()})`,
        suspensionReason: input.reason,
        suspensionNote: input.note ?? null,
      })
      .where(and(eq(t.id, input.teamId), input.ifNotSuspended ? isNull(t.suspendedAt) : undefined))
      .returning({ id: t.id });
    if (changed.length === 0) return null;
    return UNSUBSCRIBING_SUSPENSIONS.includes(input.reason) &&
      !UNSUBSCRIBING_SUSPENSIONS.includes(before?.reason ?? "")
      ? unsubscribeSuspendedMembers(tx as unknown as Db, input.teamId)
      : [];
  });
  if (!timeline) return false;
  await recordContactActivity(db, timeline);
  return true;
}

/**
 * What a refused API or SMTP send says while the team is suspended. A review
 * hold reads as a neutral pause: the team may be innocent, and a phisher
 * learns nothing about what was judged.
 */
export function suspendedSendRefusal(reason: SuspensionReason): {
  code: "team_suspended" | "sending_paused";
  message: string;
} {
  return reason === "review"
    ? {
        code: "sending_paused",
        message:
          "Sending is paused pending review. Sends are refused until the review is complete.",
      }
    : {
        code: "team_suspended",
        message:
          "This team is suspended by the instance operator. Sending is disabled until it is reinstated.",
      };
}
