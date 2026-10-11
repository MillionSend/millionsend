import { ipGeolocationEnabled } from "@millionsend/config";
import { type IpGeo, lookupIpGeo, type SuspensionReason } from "@millionsend/core";
import { schema } from "@millionsend/db";
import { and, asc, desc, eq, inArray, isNotNull, ne, notInArray } from "drizzle-orm";
import { z } from "zod";
import { disposableAddressTest } from "../../disposable-email";
import { operatorProcedure, router } from "../../trpc";

/** Other accounts listed per team at most, the ones in suspended teams first. */
const OTHERS_MAX = 20;

/** The order a person's several suspended teams are reported in: the worst first. */
const SUSPENSION_ORDER: SuspensionReason[] = [
  "phishing",
  "manual",
  "reputation",
  "review",
  "non_payment",
];

export const consoleAccountsRouter = router({
  /**
   * The team's people as the operator investigates them: where each signed
   * up from, the IP of their latest session, and every other account seen
   * on one of those IPs, at sign-up or in a session, deleted ones included.
   */
  members: operatorProcedure.input(z.object({ teamId: z.uuid() })).query(async ({ ctx, input }) => {
    const m = schema.teamMembers;
    const u = schema.user;
    const su = schema.accountSignups;
    const s = schema.session;
    const members = await ctx.db
      .select({
        userId: m.userId,
        name: u.name,
        email: u.email,
        role: m.role,
        signupIp: su.ip,
        userAgent: su.userAgent,
        signedUpAt: su.createdAt,
      })
      .from(m)
      .innerJoin(u, eq(u.id, m.userId))
      .leftJoin(su, eq(su.userId, m.userId))
      .where(eq(m.teamId, input.teamId))
      .orderBy(asc(m.createdAt));
    const ids = members.map((row) => row.userId);
    const latest =
      ids.length > 0
        ? await ctx.db
            .selectDistinctOn([s.userId], { userId: s.userId, ip: s.ipAddress, at: s.updatedAt })
            .from(s)
            .where(and(inArray(s.userId, ids), isNotNull(s.ipAddress), ne(s.ipAddress, "")))
            .orderBy(s.userId, desc(s.updatedAt))
        : [];
    const lastSeen = new Map(latest.map((row) => [row.userId, { ip: row.ip, at: row.at }]));
    const ips = [
      ...new Set([
        ...members.flatMap((row) => (row.signupIp ? [row.signupIp] : [])),
        ...latest.flatMap((row) => (row.ip ? [row.ip] : [])),
      ]),
    ];

    const others = new Map<
      string,
      {
        userId: string;
        email: string;
        ip: string;
        seen: "signup" | "session";
        deleted: boolean;
        abuseSuspended: boolean;
      }
    >();
    if (ips.length > 0) {
      const outside = ids.length > 0 ? notInArray(su.userId, ids) : undefined;
      for (const row of await ctx.db
        .select({
          userId: su.userId,
          email: su.email,
          ip: su.ip,
          deletedAt: su.deletedAt,
          abuseSuspended: su.abuseSuspended,
        })
        .from(su)
        .where(and(inArray(su.ip, ips), outside))
        .orderBy(desc(su.createdAt))
        .limit(OTHERS_MAX)) {
        others.set(row.userId, {
          userId: row.userId,
          email: row.email,
          ip: row.ip ?? "",
          seen: "signup",
          deleted: row.deletedAt !== null,
          abuseSuspended: row.abuseSuspended,
        });
      }
      for (const row of await ctx.db
        .selectDistinctOn([s.userId], { userId: s.userId, email: u.email, ip: s.ipAddress })
        .from(s)
        .innerJoin(u, eq(u.id, s.userId))
        .where(
          and(inArray(s.ipAddress, ips), ids.length > 0 ? notInArray(s.userId, ids) : undefined),
        )
        .orderBy(s.userId, desc(s.updatedAt))
        .limit(OTHERS_MAX)) {
        if (others.has(row.userId) || !row.ip) continue;
        others.set(row.userId, {
          userId: row.userId,
          email: row.email,
          ip: row.ip,
          seen: "session",
          deleted: false,
          abuseSuspended: false,
        });
      }
    }
    const suspensions = new Map<string, SuspensionReason>();
    if (others.size > 0) {
      const t = schema.teams;
      const rows = await ctx.db
        .select({ userId: m.userId, reason: t.suspensionReason })
        .from(m)
        .innerJoin(t, eq(t.id, m.teamId))
        .where(and(inArray(m.userId, [...others.keys()]), isNotNull(t.suspendedAt)));
      for (const row of rows) {
        if (!row.reason) continue;
        const held = suspensions.get(row.userId);
        if (!held || SUSPENSION_ORDER.indexOf(row.reason) < SUSPENSION_ORDER.indexOf(held)) {
          suspensions.set(row.userId, row.reason);
        }
      }
    }

    const geoOn = ipGeolocationEnabled();
    const geo: Map<string, IpGeo> = geoOn
      ? await lookupIpGeo(
          ctx.db,
          members.flatMap((row) => (row.signupIp ? [row.signupIp] : [])),
        )
      : new Map();
    // Tagged, never locked out: the block applies to new addresses only.
    const disposable = await disposableAddressTest(ctx.db);
    const rank = (other: { userId: string; deleted: boolean; abuseSuspended: boolean }) => {
      const reason = suspensions.get(other.userId);
      if (reason) return SUSPENSION_ORDER.indexOf(reason);
      return other.abuseSuspended ? SUSPENSION_ORDER.length : SUSPENSION_ORDER.length + 1;
    };
    return {
      geo: geoOn,
      members: members.map((row) => ({
        userId: row.userId,
        name: row.name,
        email: row.email,
        disposable: disposable(row.email),
        role: row.role,
        signup:
          row.signedUpAt === null
            ? null
            : {
                ip: row.signupIp,
                userAgent: row.userAgent,
                at: row.signedUpAt,
                geo: row.signupIp ? (geo.get(row.signupIp) ?? null) : null,
              },
        lastSeen: lastSeen.get(row.userId) ?? null,
      })),
      others: [...others.values()]
        .sort((a, b) => rank(a) - rank(b) || a.email.localeCompare(b.email))
        .slice(0, OTHERS_MAX)
        .map((other) => ({
          email: other.email,
          disposable: disposable(other.email),
          ip: other.ip,
          seen: other.seen,
          deleted: other.deleted,
          suspension: suspensions.get(other.userId) ?? null,
          abuseSuspended: other.abuseSuspended,
        })),
    };
  }),
});
