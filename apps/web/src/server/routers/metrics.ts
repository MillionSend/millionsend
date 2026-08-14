import { schema } from "@millionsend/db";
import { and, asc, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { router, teamProcedure } from "../trpc";

const DAY_MS = 86_400_000;

/** UTC day string ("YYYY-MM-DD") — must match the day key quota reservation writes. */
function utcDay(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

const COUNTS = { accepted: 0, sent: 0, delivered: 0, bounced: 0, complained: 0 };
type Counts = typeof COUNTS;

export const metricsRouter = router({
  window: teamProcedure
    .input(z.object({ days: z.number().int().min(1).max(30).default(15) }).optional())
    .query(async ({ ctx, input }) => {
      const windowDays = input?.days ?? 15;
      const now = Date.now();
      const since = utcDay(now - (windowDays - 1) * DAY_MS);

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
        .orderBy(asc(c.day));

      // Zero-fill so the chart always renders one bar per calendar day.
      const byDay = new Map(rows.map((r) => [r.day, r]));
      const days = Array.from({ length: windowDays }, (_, i) => {
        const day = utcDay(now - (windowDays - 1 - i) * DAY_MS);
        return byDay.get(day) ?? { day, ...COUNTS };
      });

      const totals = days.reduce<Counts>(
        (acc, d) => ({
          accepted: acc.accepted + d.accepted,
          sent: acc.sent + d.sent,
          delivered: acc.delivered + d.delivered,
          bounced: acc.bounced + d.bounced,
          complained: acc.complained + d.complained,
        }),
        { ...COUNTS },
      );

      const [allTime] = await ctx.db
        .select({ delivered: sql<number>`coalesce(sum(${c.delivered}), 0)::int` })
        .from(c)
        .where(eq(c.teamId, ctx.teamId));

      return { days, totals, allTimeDelivered: allTime?.delivered ?? 0 };
    }),
});
