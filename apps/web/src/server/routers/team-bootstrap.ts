import { randomBytes } from "node:crypto";
import { env, supportViewEnabled } from "@millionsend/config";
import {
  ALL_TEAMS_GRANT,
  endSupportView,
  fetchBestOwnedPlan,
  fetchTeamStanding,
  liveSupportViewForTeam,
  PLAN_TEAM_LIMIT,
} from "@millionsend/core";
import { schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { isUniqueViolation } from "@/lib/db-errors";
import { slugify } from "@/lib/slug";
import { recordAudit } from "../audit";
import { listMemberships } from "../membership";
import { belongsToSilentlySuspendedTeam, suspensionLockError } from "../suspension-lock";
import {
  type AuthSession,
  adminProcedure,
  type Context,
  protectedProcedure,
  router,
  teamProcedure,
} from "../trpc";

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

  /** The operator's read-only look at the active team, for the owner's Support access card. */
  supportView: router({
    current: adminProcedure.query(async ({ ctx }) => {
      const enabled = supportViewEnabled();
      const live = enabled ? await liveSupportViewForTeam(ctx.db, ctx.teamId) : null;
      // To the team the view is MillionSend's: the operator's name, email and id stay out.
      return {
        enabled,
        live: live
          ? {
              id: live.id,
              reason: live.reason,
              reference: live.reference,
              startedAt: live.createdAt,
              expiresAt: live.expiresAt,
            }
          : null,
      };
    }),

    /** The owner (or an admin) ends the session; the grant records who did. */
    end: adminProcedure.mutation(async ({ ctx }) => {
      const live = await liveSupportViewForTeam(ctx.db, ctx.teamId);
      if (!live) return { ended: false };
      await endSupportView(ctx.db, live, { by: "owner", userId: ctx.session.user.id });
      return { ended: true };
    }),
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
    .input(z.object({ name: z.string().trim().min(1).max(80) }))
    .mutation(async ({ ctx, input }) => {
      if (await belongsToSilentlySuspendedTeam(ctx.db, ctx.session.user.id)) {
        throw await suspensionLockError("unavailable");
      }
      if (env.IS_CLOUD) {
        const userId = ctx.session.user.id;
        const [memberships, bestPlan] = await Promise.all([
          listMemberships(ctx.db, userId),
          fetchBestOwnedPlan(ctx.db, userId),
        ]);
        const owned = memberships.filter((m) => m.role === "owner").length;
        if (owned >= PLAN_TEAM_LIMIT[bestPlan]) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Team limit reached." });
        }
      }
      const base = slugify(input.name) || "team";
      for (let attempt = 0; attempt < 3; attempt++) {
        const slug = attempt === 0 ? base : `${base}-${randomBytes(3).toString("hex")}`;
        try {
          const created = await ctx.db.transaction(async (tx) => {
            const [team] = await tx
              .insert(schema.teams)
              .values({ name: input.name.trim(), slug })
              .returning({ id: schema.teams.id });
            if (!team) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
            await tx.insert(schema.teamMembers).values({
              teamId: team.id,
              userId: ctx.session.user.id,
              role: "owner",
            });
            return { teamId: team.id };
          });
          // A freshly created team becomes the active one.
          await selectTeam(ctx, created.teamId);
          await recordAudit(
            { ...ctx, teamId: created.teamId },
            {
              action: "team.created",
              target: { type: "team", id: created.teamId },
              metadata: { name: input.name.trim() },
            },
          );
          return created;
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
        }
      }
      throw new TRPCError({ code: "CONFLICT", message: "could not allocate a unique team slug" });
    }),
});
