import { isIP } from "node:net";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, exists, inArray, isNull, lt, ne, notExists, or } from "drizzle-orm";
import { errorSummary } from "./error-summary.js";
import { ABUSE_SUSPENSIONS } from "./team-standing.js";
import { DAY_MS } from "./utc-day.js";

/** Days a deleted account's sign-up record is kept, as the privacy policy keeps account data. */
export const SIGNUP_RETENTION_DAYS = 90;
/** The same for an account that sat in a team suspended for abuse. */
export const SIGNUP_ABUSE_RETENTION_DAYS = 365;

const USER_AGENT_MAX = 512;

/** The sign-up's address and browser, as its request carried them. Never fails a sign-up. */
export async function recordSignup(
  db: Db,
  input: { userId: string; email: string; ip: string | null; userAgent: string | null },
): Promise<void> {
  try {
    await db
      .insert(schema.accountSignups)
      .values({
        userId: input.userId,
        email: input.email,
        ip: input.ip && isIP(input.ip) !== 0 ? input.ip.toLowerCase() : null,
        userAgent: input.userAgent?.slice(0, USER_AGENT_MAX) || null,
      })
      .onConflictDoNothing();
  } catch (error) {
    console.error(`account sign-up record for ${input.userId} not written: ${errorSummary(error)}`);
  }
}

/** Membership in a team suspended for abuse, other than `exceptTeamId` when given. */
function inAbuseTeam(db: Db, exceptTeamId?: string) {
  const m = schema.teamMembers;
  const t = schema.teams;
  return db
    .select({ userId: m.userId })
    .from(m)
    .innerJoin(t, eq(t.id, m.teamId))
    .where(
      and(
        eq(m.userId, schema.accountSignups.userId),
        inArray(t.suspensionReason, [...ABUSE_SUSPENSIONS]),
        exceptTeamId ? ne(m.teamId, exceptTeamId) : undefined,
      ),
    );
}

/**
 * The retention sweep. A record whose account is gone is stamped deleted
 * now; a live account in a team suspended for abuse gets the abuse mark
 * (suspendTeam sets it at once, and only a reinstatement takes it away);
 * then every record past its window goes: 90 days after deletion, or 12
 * months for an account with the mark. Returns how many were deleted.
 */
export async function purgeAccountSignups(db: Db, now: Date = new Date()): Promise<number> {
  const s = schema.accountSignups;
  await db
    .update(s)
    .set({ deletedAt: now })
    .where(
      and(
        isNull(s.deletedAt),
        notExists(
          db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.id, s.userId)),
        ),
      ),
    );
  await db
    .update(s)
    .set({ abuseSuspended: true })
    .where(and(isNull(s.deletedAt), eq(s.abuseSuspended, false), exists(inAbuseTeam(db))));
  const before = (days: number) => new Date(now.getTime() - days * DAY_MS);
  const purged = await db
    .delete(s)
    .where(
      or(
        and(eq(s.abuseSuspended, false), lt(s.deletedAt, before(SIGNUP_RETENTION_DAYS))),
        lt(s.deletedAt, before(SIGNUP_ABUSE_RETENTION_DAYS)),
      ),
    )
    .returning({ userId: s.userId });
  return purged.length;
}

/**
 * A reinstated team's people lose the abuse mark, unless another team of
 * theirs is suspended for abuse. An account deleted while the team was
 * suspended keeps it: nothing ties its record to the team any more.
 */
export async function clearAbuseMarks(db: Db, teamId: string): Promise<void> {
  const s = schema.accountSignups;
  const m = schema.teamMembers;
  await db
    .update(s)
    .set({ abuseSuspended: false })
    .where(
      and(
        eq(s.abuseSuspended, true),
        inArray(s.userId, db.select({ userId: m.userId }).from(m).where(eq(m.teamId, teamId))),
        notExists(inAbuseTeam(db, teamId)),
      ),
    );
}
