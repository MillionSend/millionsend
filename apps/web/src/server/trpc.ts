import type { WebhookEnqueue } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { getDb } from "@millionsend/db";
import { initTRPC, TRPCError } from "@trpc/server";
import { cookies } from "next/headers";
import superjson from "superjson";
import { getAuth } from "./auth";
import { ACTIVE_TEAM_COOKIE, getActiveMembership, type TeamRole } from "./membership";
import {
  enqueueEmailSend,
  enqueueRecipientErase,
  enqueueWebhookDeliveries,
  getQueue,
} from "./queue";

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

export interface Context {
  db: Db;
  session: AuthSession | null;
  teamId: string | null;
  role: TeamRole | null;
  /** Persists the team selection (ACTIVE_TEAM_COOKIE). Absent outside HTTP requests (tests). */
  setActiveTeamCookie?: (teamId: string) => void;
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
  /**
   * Scrubs a deleted contact's address from the team's history in the
   * worker. Absent in tests, where the routers erase inline instead.
   */
  enqueueRecipientErase?: (teamId: string, address: string) => Promise<void>;
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
  const membership = await getActiveMembership(
    db,
    session.user.id,
    cookieStore.get(ACTIVE_TEAM_COOKIE)?.value,
  );
  return {
    db,
    session,
    teamId: membership?.teamId ?? null,
    role: membership?.role ?? null,
    enqueueBroadcastSend,
    enqueueEmailSend,
    enqueueWebhookDeliveries,
    enqueueRecipientErase,
    setActiveTeamCookie: (teamId) =>
      cookieStore.set(ACTIVE_TEAM_COOKIE, teamId, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: process.env.NODE_ENV === "production",
        maxAge: 60 * 60 * 24 * 365,
      }),
  };
}

const t = initTRPC.context<Context>().create({ transformer: superjson });

export const router = t.router;
export const createCallerFactory = t.createCallerFactory;
export const publicProcedure = t.procedure;

export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
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

/** Team administration: secrets, external sinks, and sending identities. */
export const adminProcedure = teamProcedure.use(({ ctx, next }) => {
  if (ctx.role === "member") throw new TRPCError({ code: "FORBIDDEN" });
  return next();
});
