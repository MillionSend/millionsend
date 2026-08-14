import type { Db } from "@millionsend/db";
import { getDb } from "@millionsend/db";
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { getAuth } from "./auth";
import { getActiveMembership, type TeamRole } from "./membership";

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
}

export interface Context {
  db: Db;
  session: AuthSession | null;
  teamId: string | null;
  role: TeamRole | null;
}

export async function createContext({ headers }: { headers: Headers }): Promise<Context> {
  const db = getDb();
  const session = await getAuth().api.getSession({ headers });
  if (!session) return { db, session: null, teamId: null, role: null };
  const membership = await getActiveMembership(db, session.user.id);
  return {
    db,
    session,
    teamId: membership?.teamId ?? null,
    role: membership?.role ?? null,
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
