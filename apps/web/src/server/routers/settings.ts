import { PLAN_DAILY_LIMIT } from "@millionsend/core";
import { schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, gte } from "drizzle-orm";
import { z } from "zod";
import { router, teamProcedure } from "../trpc";

const DAY_MS = 86_400_000;

/** UTC day string ("YYYY-MM-DD") — must match the day key quota reservation writes. */
function utcDay(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

export const settingsRouter = router({
  team: router({
    get: teamProcedure.query(async ({ ctx }) => {
      const [team] = await ctx.db
        .select({ name: schema.teams.name, slug: schema.teams.slug, plan: schema.teams.plan })
        .from(schema.teams)
        .where(eq(schema.teams.id, ctx.teamId));
      if (!team) throw new TRPCError({ code: "NOT_FOUND" });
      return { ...team, planDailyLimit: PLAN_DAILY_LIMIT[team.plan] };
    }),

    rename: teamProcedure
      .input(z.object({ name: z.string().trim().min(1).max(80) }))
      .mutation(async ({ ctx, input }) => {
        if (ctx.role === "member") throw new TRPCError({ code: "FORBIDDEN" });
        await ctx.db
          .update(schema.teams)
          .set({ name: input.name })
          .where(eq(schema.teams.id, ctx.teamId));
        return { name: input.name };
      }),
  }),

  members: router({
    list: teamProcedure.query(({ ctx }) =>
      ctx.db
        .select({
          name: schema.user.name,
          email: schema.user.email,
          role: schema.teamMembers.role,
        })
        .from(schema.teamMembers)
        .innerJoin(schema.user, eq(schema.user.id, schema.teamMembers.userId))
        .where(eq(schema.teamMembers.teamId, ctx.teamId))
        .orderBy(asc(schema.teamMembers.createdAt)),
    ),
  }),

  usage: router({
    recent: teamProcedure
      .input(z.object({ days: z.number().int().min(1).max(30).optional() }).optional())
      .query(async ({ ctx, input }) => {
        const days = input?.days ?? 15;
        const today = utcDay(Date.now());
        const since = utcDay(Date.now() - (days - 1) * DAY_MS);

        const [team] = await ctx.db
          .select({ plan: schema.teams.plan })
          .from(schema.teams)
          .where(eq(schema.teams.id, ctx.teamId));
        if (!team) throw new TRPCError({ code: "NOT_FOUND" });

        const c = schema.usageCounters;
        const rows = await ctx.db
          .select({
            day: c.day,
            accepted: c.accepted,
            sent: c.sent,
            delivered: c.delivered,
            bounced: c.bounced,
            complained: c.complained,
          })
          .from(c)
          .where(and(eq(c.teamId, ctx.teamId), gte(c.day, since)))
          .orderBy(desc(c.day));

        return {
          rows,
          today: {
            accepted: rows.find((r) => r.day === today)?.accepted ?? 0,
            limit: PLAN_DAILY_LIMIT[team.plan],
          },
        };
      }),
  }),
});
