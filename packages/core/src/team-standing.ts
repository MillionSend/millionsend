import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { eq } from "drizzle-orm";

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
