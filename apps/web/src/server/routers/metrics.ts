import {
  DAY_MS,
  fetchAccountScore,
  fetchDeliverabilityHealth,
  PAUSE_BOUNCE_RATE,
  PAUSE_COMPLAINT_RATE,
  utcDay,
  WARN_BOUNCE_RATE,
  WARN_COMPLAINT_RATE,
} from "@millionsend/core";
import { schema } from "@millionsend/db";
import { and, asc, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { router, teamProcedure } from "../trpc";

const COUNTS = {
  accepted: 0,
  sent: 0,
  delivered: 0,
  bounced: 0,
  hardBounced: 0,
  complained: 0,
  opened: 0,
  clicked: 0,
};
type Counts = typeof COUNTS;

export const metricsRouter = router({
  window: teamProcedure
    .input(z.object({ days: z.number().int().min(1).max(30).default(15) }).optional())
    .query(async ({ ctx, input }) => {
      const windowDays = input?.days ?? 15;
      const now = Date.now();
      const since = utcDay(now - (windowDays - 1) * DAY_MS);

      const c = schema.usageCounters;
      const [rows, [allTime]] = await Promise.all([
        ctx.db
          .select({
            day: c.day,
            accepted: c.accepted,
            sent: c.sent,
            delivered: c.delivered,
            bounced: c.bounced,
            hardBounced: c.hardBounced,
            complained: c.complained,
            opened: c.opened,
            clicked: c.clicked,
          })
          .from(c)
          .where(and(eq(c.teamId, ctx.teamId), gte(c.day, since)))
          .orderBy(asc(c.day)),
        // ::bigint — the all-time sum of int columns overflows int4 for large
        // senders. The driver returns bigint as a string; Number() below is
        // exact up to 2^53 deliveries.
        ctx.db
          .select({ delivered: sql<string>`coalesce(sum(${c.delivered}), 0)::bigint` })
          .from(c)
          .where(eq(c.teamId, ctx.teamId)),
      ]);

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
          hardBounced: acc.hardBounced + d.hardBounced,
          complained: acc.complained + d.complained,
          opened: acc.opened + d.opened,
          clicked: acc.clicked + d.clicked,
        }),
        { ...COUNTS },
      );

      return { days, totals, allTimeDelivered: Number(allTime?.delivered ?? 0) };
    }),

  /**
   * Current deliverability standing plus the thresholds it was judged against,
   * so the banner and the send guard read one source (never a re-hardcoded
   * rate). Rates come from the same trailing-window usage_counters sum the
   * chart reads.
   */
  health: teamProcedure.query(async ({ ctx }) => {
    const health = await fetchDeliverabilityHealth(ctx.db, ctx.teamId);
    return {
      ...health,
      thresholds: {
        warnBounce: WARN_BOUNCE_RATE,
        warnComplaint: WARN_COMPLAINT_RATE,
        pauseBounce: PAUSE_BOUNCE_RATE,
        pauseComplaint: PAUSE_COMPLAINT_RATE,
      },
    };
  }),

  /** Rolling 30-day account score (content + outcome sub-scores). */
  accountScore: teamProcedure.query(({ ctx }) => fetchAccountScore(ctx.db, ctx.teamId)),
});
