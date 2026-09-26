import { recordSupportViewRead, type WebhookEnqueue } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { getDb } from "@millionsend/db";
import { initTRPC, TRPCError } from "@trpc/server";
import { cookies } from "next/headers";
import superjson from "superjson";
import { getAuth } from "./auth";
import { isInstanceOperator } from "./instance-operator";
import { ACTIVE_TEAM_COOKIE, getActiveMembership, type SessionRole } from "./membership";
import { enqueueEmailSend, enqueueWebhookDeliveries, getQueue } from "./queue";
import { resolveSupportView, SUPPORT_VIEW_COOKIE } from "./support-view";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

/**
 * Structural subset of Better Auth's session payload — kept minimal so
 * tests can fake an authenticated context without constructing real
 * sessions.
 */
export interface AuthSession {
  user: SessionUser;
  /** The session row; optional so tests can fake a context without one. */
  session?: { id: string; createdAt?: Date };
}

/** The read-only view a request runs under: the team is the grant's and the role is viewer. */
export interface SupportViewContext {
  grantId: string;
  expiresAt: Date;
}

export interface Context {
  db: Db;
  session: AuthSession | null;
  teamId: string | null;
  role: SessionRole | null;
  /** Set only while the session user's own live grant names the team; every mutation is refused. */
  supportView?: SupportViewContext | undefined;
  /** Persists the team selection (ACTIVE_TEAM_COOKIE). Absent outside HTTP requests (tests). */
  setActiveTeamCookie?: (teamId: string) => void;
  /** Names the live grant (SUPPORT_VIEW_COOKIE), or clears it with null. Absent in tests. */
  setSupportViewCookie?: (grant: { id: string; expiresAt: Date } | null) => void;
  /**
   * Hands a scheduled broadcast to the fan-out queue (same optional seam as
   * the API's ApiDeps.enqueueBroadcastSend). Absent in tests; without it a
   * send still commits and the broadcasts.reconcile sweep picks it up.
   */
  enqueueBroadcastSend?: (broadcastId: string, opts?: { startAfter?: Date }) => Promise<void>;
  /** Hands an accepted email to the send queue (the onboarding send). Absent in tests. */
  enqueueEmailSend?: (emailId: string) => Promise<void>;
  /**
   * Hands a webhook delivery row to the delivery queue, for the contact and
   * suppression events the routers publish. Absent in tests; the
   * webhooks.reconcile sweep sends rows nobody enqueued.
   */
  enqueueWebhookDeliveries?: WebhookEnqueue;
}

const enqueueBroadcastSend = async (
  broadcastId: string,
  opts?: { startAfter?: Date },
): Promise<void> => {
  const queue = await getQueue();
  await queue.send(
    "broadcast.send",
    { broadcastId },
    { dedupeKey: broadcastId, ...(opts?.startAfter ? { startAfter: opts.startAfter } : {}) },
  );
};

export async function createContext({ headers }: { headers: Headers }): Promise<Context> {
  const db = getDb();
  const session = await getAuth().api.getSession({ headers });
  if (!session) return { db, session: null, teamId: null, role: null };
  const cookieStore = await cookies();
  const secure = process.env.NODE_ENV === "production";
  const shared = {
    db,
    session,
    enqueueBroadcastSend,
    enqueueEmailSend,
    enqueueWebhookDeliveries,
    setActiveTeamCookie: (teamId: string) =>
      cookieStore.set(ACTIVE_TEAM_COOKIE, teamId, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure,
        maxAge: 60 * 60 * 24 * 365,
      }),
    setSupportViewCookie: (grant: { id: string; expiresAt: Date } | null) =>
      grant
        ? cookieStore.set(SUPPORT_VIEW_COOKIE, grant.id, {
            httpOnly: true,
            sameSite: "lax",
            path: "/",
            secure,
            expires: grant.expiresAt,
          })
        : cookieStore.delete(SUPPORT_VIEW_COOKIE),
  };
  const viewCookie = cookieStore.get(SUPPORT_VIEW_COOKIE)?.value;
  const view = await resolveSupportView(db, session.user.id, viewCookie);
  if (view) {
    return {
      ...shared,
      teamId: view.teamId,
      role: "viewer",
      supportView: { grantId: view.grantId, expiresAt: view.expiresAt },
    };
  }
  // A cookie that no longer names a live grant of this user is dropped, so
  // the browser stops sending it; the request falls back to the membership.
  if (viewCookie) cookieStore.delete(SUPPORT_VIEW_COOKIE);
  const membership = await getActiveMembership(
    db,
    session.user.id,
    cookieStore.get(ACTIVE_TEAM_COOKIE)?.value,
  );
  return { ...shared, teamId: membership?.teamId ?? null, role: membership?.role ?? null };
}

const t = initTRPC.context<Context>().create({ transformer: superjson });

export const router = t.router;
export const createCallerFactory = t.createCallerFactory;

/**
 * The procedures a live view may still reach, by exact path: the operator
 * ending their own session, the banner asking whether it still holds, and
 * the operator's own language switch, which writes only their user row.
 * Named one by one rather than by prefix, so a procedure added to the
 * support router later does not inherit the exemption.
 */
const SUPPORT_VIEW_PASS: ReadonlySet<string> = new Set([
  "support.end",
  "support.current",
  "settings.locale.set",
]);

/**
 * Read-only support view, enforced once for every procedure: a mutation is
 * refused whatever the router hides or disables, and each read is counted
 * on the grant by procedure path. The console's own procedures pass
 * untouched and uncounted — the operator is still the operator, and a
 * console read is not a read of the team — and so do the procedures above,
 * which are about the operator rather than the team's data.
 */
const supportViewGuard = t.middleware(async ({ ctx, type, path, next }) => {
  const view = ctx.supportView;
  if (!view || path.startsWith("console.") || SUPPORT_VIEW_PASS.has(path)) return next();
  if (type === "mutation") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Read-only support view" });
  }
  if (type === "query") await recordSupportViewRead(ctx.db, view.grantId, path);
  return next();
});

export const publicProcedure = t.procedure.use(supportViewGuard);

export const protectedProcedure = publicProcedure.use(({ ctx, next }) => {
  if (!ctx.session) throw new TRPCError({ code: "UNAUTHORIZED" });
  return next({ ctx: { session: ctx.session } });
});

/**
 * Membership-scoped procedures: teamId/role derive exclusively from the
 * session's teamMembers row (never from client input) and are non-null in
 * downstream ctx. Every db query in a teamProcedure must filter by
 * ctx.teamId.
 */
export const teamProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (!ctx.teamId || !ctx.role) throw new TRPCError({ code: "FORBIDDEN" });
  return next({ ctx: { teamId: ctx.teamId, role: ctx.role } });
});

/**
 * Team administration: secrets, external sinks, and sending identities.
 * An allow-list, not a deny-list: a role added to SessionRole later must be
 * admitted here on purpose rather than by default.
 */
export const adminProcedure = teamProcedure.use(({ ctx, next }) => {
  if (ctx.role !== "owner" && ctx.role !== "admin") throw new TRPCError({ code: "FORBIDDEN" });
  return next();
});

/**
 * The instance console: only the first registered user, re-checked on every
 * call. Anyone else gets the same NOT_FOUND a route that does not exist
 * would give, signed-in members included — the console is not a thing
 * they can see. No team scope: the console reads across every team.
 */
export const operatorProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  if (!(await isInstanceOperator(ctx.db, ctx.session.user.id))) {
    throw new TRPCError({ code: "NOT_FOUND" });
  }
  return next({ ctx: { operator: ctx.session.user } });
});
