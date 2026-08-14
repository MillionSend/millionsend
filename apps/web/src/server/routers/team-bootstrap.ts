import { randomBytes } from "node:crypto";
import { schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { isUniqueViolation } from "@/lib/db-errors";
import { slugify } from "@/lib/slug";
import { listMemberships } from "../membership";
import { protectedProcedure, router } from "../trpc";

export const teamBootstrapRouter = router({
  /** All of the caller's memberships plus which one the session resolved as active. */
  list: protectedProcedure.query(async ({ ctx }) => ({
    teams: await listMemberships(ctx.db, ctx.session.user.id),
    activeTeamId: ctx.teamId,
  })),

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
      ctx.setActiveTeamCookie?.(input.teamId);
      return { teamId: input.teamId };
    }),

  createTeam: protectedProcedure
    .input(z.object({ name: z.string().trim().min(1).max(80) }))
    .mutation(async ({ ctx, input }) => {
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
          ctx.setActiveTeamCookie?.(created.teamId);
          return created;
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
        }
      }
      throw new TRPCError({ code: "CONFLICT", message: "could not allocate a unique team slug" });
    }),
});
