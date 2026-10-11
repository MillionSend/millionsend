import { isIP } from "node:net";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, isNull, lt, notExists, or, sql } from "drizzle-orm";
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
    console.error(`account sign-up record for ${input.userId} not written`, error);
  }
}

/**
 * The retention sweep. A record whose account is gone is stamped deleted
 * now; a live account's abuse mark follows its teams; then every record past
 * its window goes: 90 days after deletion, or 12 months for an account that
 * sat in a team suspended for phishing, manual or reputation reasons.
 * Returns how many were deleted.
 * ponytail: the abuse mark is refreshed by this hourly sweep, so an account
 * deleted within the hour of its team's suspension keeps the 90-day window.
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
  const inAbuseTeam = sql<boolean>`exists (select 1 from ${schema.teamMembers} m join ${schema.teams} t on t.id = m.team_id where m.user_id = ${s.userId} and t.suspension_reason in ('phishing', 'manual', 'reputation'))`;
  await db
    .update(s)
    .set({ abuseSuspended: inAbuseTeam })
    .where(and(isNull(s.deletedAt), sql`${s.abuseSuspended} <> ${inAbuseTeam}`));
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
