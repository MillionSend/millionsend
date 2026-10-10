import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, isNull, sql } from "drizzle-orm";

export type SuspensionReason = (typeof schema.suspensionReasonEnum.enumValues)[number];
export const SUSPENSION_REASONS = schema.suspensionReasonEnum.enumValues;

/**
 * Suspensions the team must not learn of: no automated mail about it goes
 * out, billing included, and its people cannot start another team. Plain
 * strings, so the content monitor's `review` hold applies as soon as the
 * schema has that reason.
 */
export const SILENT_SUSPENSIONS: readonly string[] = ["phishing", "review"];

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

/**
 * Whether the team's links in mail already delivered stop leading anywhere:
 * tracked clicks, and the hosted unsubscribe page's hop to the team's site.
 * An unpaid invoice says nothing about the mail, so it leaves them working.
 */
export function linksDisabled(standing: TeamStanding): boolean {
  return standing.suspended !== null && standing.suspended.reason !== "non_payment";
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
  const changed = await db
    .update(t)
    .set({
      suspendedAt: sql`coalesce(${t.suspendedAt}, ${input.now ?? new Date()})`,
      suspensionReason: input.reason,
      suspensionNote: input.note ?? null,
    })
    .where(and(eq(t.id, input.teamId), input.ifNotSuspended ? isNull(t.suspendedAt) : undefined))
    .returning({ id: t.id });
  return changed.length > 0;
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
