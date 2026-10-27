import { BlockList, isIP, isIPv4, isIPv6 } from "node:net";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import {
  and,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  notExists,
  or,
} from "drizzle-orm";
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

/**
 * New accounts one network may open in a day on the cloud: an IPv4 address,
 * or an IPv6 /64, the prefix one subscriber's line gets.
 */
export const SIGNUPS_PER_NETWORK_PER_DAY = 3;

/** IPv4 addresses written as IPv6 (::ffff:a.b.c.d): one address each, never a shared /64. */
const MAPPED_IPV4 = new BlockList();
MAPPED_IPV4.addSubnet("::ffff:0:0", 96, "ipv6");

/**
 * Sign-ups from `ip`'s network in the 24 hours before `now`, accounts
 * deleted since included, as their records outlive them. Matched here, not
 * as inet in SQL, which refuses a stored address that carries a zone id.
 */
export async function signupsFromNetwork(
  db: Db,
  ip: string,
  now: Date = new Date(),
): Promise<number> {
  const network = new BlockList();
  if (isIPv4(ip)) network.addAddress(ip, "ipv4");
  else if (isIPv6(ip)) network.addSubnet(ip, MAPPED_IPV4.check(ip, "ipv6") ? 128 : 64, "ipv6");
  else return 0;
  const s = schema.accountSignups;
  // ponytail: reads the whole day's sign-ups (created_at has no index); index
  // it if a day ever holds thousands.
  const rows = await db
    .select({ ip: s.ip })
    .from(s)
    .where(and(isNotNull(s.ip), gt(s.createdAt, new Date(now.getTime() - DAY_MS))));
  return rows.filter(
    (row) => row.ip !== null && network.check(row.ip, isIPv6(row.ip) ? "ipv6" : "ipv4"),
  ).length;
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
