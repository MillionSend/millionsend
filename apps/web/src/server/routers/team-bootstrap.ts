import { randomBytes } from "node:crypto";
import { schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { isUniqueViolation } from "@/lib/db-errors";
import { slugify } from "@/lib/slug";
import { protectedProcedure, router } from "../trpc";

export const teamBootstrapRouter = router({
  createTeam: protectedProcedure
    .input(z.object({ name: z.string().trim().min(1).max(80) }))
    .mutation(async ({ ctx, input }) => {
      // Idempotent for already-onboarded users: MVP is single-team.
      if (ctx.teamId) return { teamId: ctx.teamId };
      const base = slugify(input.name) || "team";
      for (let attempt = 0; attempt < 3; attempt++) {
        const slug = attempt === 0 ? base : `${base}-${randomBytes(3).toString("hex")}`;
        try {
          return await ctx.db.transaction(async (tx) => {
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
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
        }
      }
      throw new TRPCError({ code: "CONFLICT", message: "could not allocate a unique team slug" });
    }),
});
