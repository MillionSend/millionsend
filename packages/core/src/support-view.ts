import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, isNull, type SQL, sql } from "drizzle-orm";
import { auditRow, recordAudit } from "./audit.js";
import { SUPPORT_VIEW_REASONS, type SupportViewReason } from "./support-view-reasons.js";

export { SUPPORT_VIEW_REASONS, type SupportViewReason };

/** How long one read-only look at a team's dashboard lasts, server-enforced on every request. */
export const SUPPORT_VIEW_MINUTES = 30;

/**
 * How recent the operator's sign-in must be to start a view, so a stolen
 * long-lived session cannot open one.
 * ponytail: a recent sign-in stands in for step-up auth; require a second
 * factor once the instance has one.
 */
export const SUPPORT_VIEW_SIGN_IN_MINUTES = 15;

export type SupportViewEndedBy = (typeof schema.supportViewEndedByEnum.enumValues)[number];
export type SupportViewGrant = typeof schema.supportViewGrants.$inferSelect;

const g = schema.supportViewGrants;

/** A live grant with the operator behind it, as the owner's card and the console dialog show it. */
export interface LiveSupportView extends SupportViewGrant {
  operator: { name: string; email: string };
}

async function liveWhere(
  db: Db,
  where: SQL | undefined,
  now: Date,
): Promise<LiveSupportView | null> {
  const [row] = await db
    .select({ grant: g, name: schema.user.name, email: schema.user.email })
    .from(g)
    .innerJoin(schema.user, eq(schema.user.id, g.operatorUserId))
    .where(and(where, isNull(g.endedAt)))
    .limit(1);
  if (!row) return null;
  // Expiry has no cron: the first request past it ends the grant.
  if (row.grant.expiresAt <= now) {
    await endSupportView(db, row.grant, { by: "expiry" }, now);
    return null;
  }
  return { ...row.grant, operator: { name: row.name, email: row.email } };
}

/**
 * The grant a cookie names, when it is this operator's and still live. A
 * missing, foreign, ended or expired id all read as "no view": the answer
 * never confirms that a grant or a team exists.
 */
export async function findLiveSupportView(
  db: Db,
  grantId: string,
  operatorUserId: string,
  now: Date = new Date(),
): Promise<LiveSupportView | null> {
  // Both halves are in the lookup: a grant id belonging to someone else must
  // not even reach the lazy expiry below, which writes to the row it finds.
  return liveWhere(db, and(eq(g.id, grantId), eq(g.operatorUserId, operatorUserId)), now);
}

export function liveSupportViewForTeam(
  db: Db,
  teamId: string,
  now: Date = new Date(),
): Promise<LiveSupportView | null> {
  return liveWhere(db, eq(g.teamId, teamId), now);
}

export function liveSupportViewOfOperator(
  db: Db,
  operatorUserId: string,
  now: Date = new Date(),
): Promise<LiveSupportView | null> {
  return liveWhere(db, eq(g.operatorUserId, operatorUserId), now);
}

/**
 * Opens a view on `teamId` for the operator, ending the one they may still
 * hold (one live view per operator, and no nesting). Records the start in
 * the audit log with the team set, so the team's own trail shows it at once.
 */
export async function startSupportView(
  db: Db,
  input: {
    teamId: string;
    operatorUserId: string;
    reason: SupportViewReason;
    reference: string | null;
    note: string | null;
  },
  now: Date = new Date(),
): Promise<SupportViewGrant> {
  const previous = await liveSupportViewOfOperator(db, input.operatorUserId, now);
  if (previous) await endSupportView(db, previous, { by: "operator" }, now);
  const expiresAt = new Date(now.getTime() + SUPPORT_VIEW_MINUTES * 60_000);
  // The start row is the owner's only record of the session, so it commits
  // with the grant or the view does not open; recordAudit would swallow a
  // failed write.
  return db.transaction(async (tx) => {
    const [grant] = await tx
      .insert(g)
      .values({ ...input, createdAt: now, expiresAt })
      .returning();
    if (!grant) throw new Error("support view insert returned no row");
    await tx.insert(schema.auditLog).values(
      auditRow({
        teamId: grant.teamId,
        actor: { userId: grant.operatorUserId },
        action: "support.view_started",
        target: { type: "support_view", id: grant.id },
        metadata: {
          reason: grant.reason,
          reference: grant.reference,
          minutes: SUPPORT_VIEW_MINUTES,
        },
      }),
    );
    return grant;
  });
}

/**
 * Ends a grant once; false when it had already ended. The audit row names
 * who ended it and how many distinct procedures were read, never which
 * rows they returned. Expiry is dated at the deadline, not at the request
 * that noticed it.
 */
export async function endSupportView(
  db: Db,
  grant: Pick<SupportViewGrant, "id" | "teamId" | "operatorUserId" | "createdAt" | "expiresAt">,
  ended: { by: "operator" | "expiry" } | { by: "owner"; userId: string },
  now: Date = new Date(),
): Promise<boolean> {
  const endedAt = ended.by === "expiry" ? grant.expiresAt : now;
  const [row] = await db
    .update(g)
    .set({ endedAt, endedBy: ended.by })
    .where(and(eq(g.id, grant.id), isNull(g.endedAt)))
    .returning({ procedures: g.procedures });
  if (!row) return false;
  await recordAudit(db, {
    teamId: grant.teamId,
    actor:
      ended.by === "expiry"
        ? "system"
        : { userId: ended.by === "owner" ? ended.userId : grant.operatorUserId },
    action: "support.view_ended",
    target: { type: "support_view", id: grant.id },
    metadata: {
      by: ended.by,
      minutes: Math.round((endedAt.getTime() - grant.createdAt.getTime()) / 60_000),
      procedures: Object.keys(row.procedures).length,
    },
  });
  return true;
}

/** Counts one read of `path` on the grant: procedure names and counts, nothing of what they returned. */
export async function recordSupportViewRead(db: Db, grantId: string, path: string): Promise<void> {
  await db
    .update(g)
    .set({
      procedures: sql`jsonb_set(${g.procedures}, array[${path}::text], (coalesce((${g.procedures} ->> ${path}::text)::int, 0) + 1)::text::jsonb)`,
    })
    .where(eq(g.id, grantId));
}
