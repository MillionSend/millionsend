import { randomBytes } from "node:crypto";
import { isCloudDeployment } from "@millionsend/config";
import {
  ALL_TEAMS_GRANT,
  auditRow,
  DAY_MS,
  encodeAuditActor,
  fetchBestOwnedPlan,
  fetchTeamStanding,
  flagImitatedBrand,
  linkTeam,
  PLAN_TEAM_LIMIT,
  slugify,
  TEAM_CREATE_WINDOW_DAYS,
} from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { and, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { isUniqueViolation } from "@/lib/db-errors";
import { settleTeamSubdomain } from "../inboxes";
import { listMemberships } from "../membership";
import { belongsToSilentlySuspendedTeam, suspensionLockError } from "../suspension-lock";
import { teamNameSchema } from "../team-name";
import { type AuthSession, type Context, protectedProcedure, router, teamProcedure } from "../trpc";

/**
 * Records the active-team selection in both places that read it: the cookie
 * (dashboard requests) and the session row (the OAuth consent flow, which
 * binds a grant to session.activeTeamId). Callers validate membership first.
 */
async function selectTeam(
  ctx: Pick<Context, "db"> & {
    session: AuthSession;
    setActiveTeamCookie: Context["setActiveTeamCookie"] | undefined;
  },
  teamId: string,
): Promise<void> {
  ctx.setActiveTeamCookie?.(teamId);
  if (ctx.session.session) {
    await ctx.db
      .update(schema.session)
      .set({ activeTeamId: teamId })
      .where(eq(schema.session.id, ctx.session.session.id));
  }
}

/**
 * Refuses a new team past the user's cap on Cloud (PLAN_TEAM_LIMIT, by the
 * best plan among the teams they own). On Free, the teams they created in
 * the last TEAM_CREATE_WINDOW_DAYS count beside the ones they own, deleted
 * ones included, so deleting and creating again never mints a fresh team.
 */
async function assertTeamRoom(db: Db, userId: string): Promise<void> {
  const [memberships, bestPlan] = await Promise.all([
    listMemberships(db, userId),
    fetchBestOwnedPlan(db, userId),
  ]);
  const counted = new Set(memberships.filter((m) => m.role === "owner").map((m) => m.teamId));
  if (bestPlan === "free") {
    const a = schema.auditLog;
    const since = new Date(Date.now() - TEAM_CREATE_WINDOW_DAYS * DAY_MS);
    const recent = await db
      .select({ teamId: a.teamId })
      .from(a)
      .where(
        and(
          eq(a.action, "team.created"),
          eq(a.actorId, encodeAuditActor({ userId })),
          gt(a.createdAt, since),
        ),
      );
    for (const row of recent) if (row.teamId) counted.add(row.teamId);
  }
  if (counted.size >= PLAN_TEAM_LIMIT[bestPlan]) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Team limit reached." });
  }
}

export const teamBootstrapRouter = router({
  /** All of the caller's memberships plus which one the session resolved as active. */
  list: protectedProcedure.query(async ({ ctx }) => ({
    teams: await listMemberships(ctx.db, ctx.session.user.id),
    activeTeamId: ctx.teamId,
  })),

  /** The operator overrides on the active team, for the dashboard's notices. */
  standing: teamProcedure.query(async ({ ctx }) => {
    const standing = await fetchTeamStanding(ctx.db, ctx.teamId);
    if (!standing) return null;
    // A pause the content monitor applied reads as "pending review" to the
    // team; the reason behind it stays on the operator's side.
    const [monitor] = await ctx.db
      .select({ pausedAt: schema.teamMonitor.broadcastsPausedAt })
      .from(schema.teamMonitor)
      .where(eq(schema.teamMonitor.teamId, ctx.teamId));
    const pendingReview = Boolean(standing.broadcastsPausedByOperatorAt && monitor?.pausedAt);
    // The note is written for the owner only on a manual suspension; on the
    // other reasons it is the operator's own record.
    return standing.suspended && standing.suspended.reason !== "manual"
      ? { ...standing, pendingReview, suspended: { ...standing.suspended, note: null } }
      : { ...standing, pendingReview };
  }),

  /**
   * Selects an active team. The cookie is a selection, not authorization:
   * the target must be one of the caller's own memberships, and every later
   * request re-validates it in getActiveMembership.
   */
  switch: protectedProcedure
    .input(z.object({ teamId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const memberships = await listMemberships(ctx.db, ctx.session.user.id);
      if (!memberships.some((m) => m.teamId === input.teamId)) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      await selectTeam(ctx, input.teamId);
      return { teamId: input.teamId };
    }),

  /**
   * Binds the pending OAuth consent to a team — or to ALL_TEAMS_GRANT for an
   * all-teams grant. Writes only the session row (what consentReferenceId
   * reads), never the dashboard cookie: authorizing an app must not switch
   * the team the user is working in.
   */
  grantTeam: protectedProcedure
    .input(z.object({ teamId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const memberships = await listMemberships(ctx.db, ctx.session.user.id);
      const allowed =
        input.teamId === ALL_TEAMS_GRANT
          ? memberships.length > 0
          : memberships.some((m) => m.teamId === input.teamId);
      if (!allowed) throw new TRPCError({ code: "FORBIDDEN" });
      if (ctx.session.session) {
        await ctx.db
          .update(schema.session)
          .set({ activeTeamId: input.teamId })
          .where(eq(schema.session.id, ctx.session.session.id));
      }
      return { teamId: input.teamId };
    }),

  createTeam: protectedProcedure
    .input(z.object({ name: teamNameSchema }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      if (await belongsToSilentlySuspendedTeam(ctx.db, userId)) {
        throw await suspensionLockError("unavailable");
      }
      const cloud = isCloudDeployment();
      const name = input.name.trim();
      const base = slugify(input.name) || "team";
      let created: { teamId: string } | undefined;
      // Only the insert retries: a unique violation after it would add a second team.
      for (let attempt = 0; attempt < 3 && !created; attempt++) {
        const slug = attempt === 0 ? base : `${base}-${randomBytes(3).toString("hex")}`;
        try {
          created = await ctx.db.transaction(async (tx) => {
            const txDb = tx as unknown as Db;
            if (cloud) {
              // One user's creations queue here, so two at once cannot both
              // fit under the cap, and each counts the ones before it.
              await tx.execute(
                sql`select pg_advisory_xact_lock(hashtext(${`team.create:${userId}`}))`,
              );
              await assertTeamRoom(txDb, userId);
            }
            const [team] = await tx
              .insert(schema.teams)
              .values({ name, slug, poolOwnerId: cloud ? userId : null })
              .returning({ id: schema.teams.id });
            if (!team) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
            await tx.insert(schema.teamMembers).values({ teamId: team.id, userId, role: "owner" });
            // In the transaction, not after it: the Free cap counts these rows.
            await tx.insert(schema.auditLog).values(
              auditRow({
                teamId: team.id,
                actor: { userId },
                action: "team.created",
                target: { type: "team", id: team.id },
                metadata: { name },
              }),
            );
            return { teamId: team.id };
          });
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
        }
      }
      if (!created) {
        throw new TRPCError({ code: "CONFLICT", message: "could not allocate a unique team slug" });
      }
      // A freshly created team becomes the active one.
      await selectTeam(ctx, created.teamId);
      await linkTeam(ctx.db, { teamId: created.teamId, trigger: "team" });
      await flagImitatedBrand(ctx.db, created.teamId, name);
      await settleTeamSubdomain(ctx.db, created.teamId);
      return created;
    }),
});
