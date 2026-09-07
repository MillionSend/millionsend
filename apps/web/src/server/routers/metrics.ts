import {
  CHECKS,
  computeAccountScore,
  contentFactorImpact,
  DAY_MS,
  fetchAccountScore,
  fetchAccountScoreInput,
  fetchContentFactors,
  fetchDeliverabilityHealth,
  PAUSE_BOUNCE_RATE,
  PAUSE_COMPLAINT_RATE,
  utcDay,
  WARN_BOUNCE_RATE,
  WARN_COMPLAINT_RATE,
} from "@millionsend/core";
import { schema } from "@millionsend/db";
import { and, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { canonicalTimeZone } from "@/lib/time-zone";
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
  prefetched: 0,
};
type Counts = typeof COUNTS;

/** The calendar date an instant falls on in `tz`, as YYYY-MM-DD. */
function localDay(at: number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

export const metricsRouter = router({
  /**
   * One row per calendar day of the viewer's timezone, summed from the hourly
   * counters: two teammates in different zones each see their own days from
   * the same rows, and "today" is the viewer's today. Quota and the
   * guardrails keep their UTC days; only this chart follows the viewer.
   */
  window: teamProcedure
    .input(
      z
        .object({
          days: z.number().int().min(1).max(30).default(15),
          tz: z
            .string()
            .default("UTC")
            .transform((tz, ctx) => {
              const canonical = canonicalTimeZone(tz);
              if (canonical === null) ctx.addIssue({ code: "custom", message: "unknown timezone" });
              return canonical ?? z.NEVER;
            }),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const windowDays = input?.days ?? 15;
      const tz = input?.tz ?? "UTC";
      const now = Date.now();
      const today = localDay(now, tz);
      // Calendar days of the window, stepped as dates from the viewer's today
      // (Date.parse of YYYY-MM-DD is UTC midnight, so this is pure calendar
      // arithmetic): stepping 24h instants would skip a 23-hour DST day and
      // list a 25-hour one twice.
      const dayList = Array.from({ length: windowDays }, (_, i) =>
        utcDay(Date.parse(today) - (windowDays - 1 - i) * DAY_MS),
      );
      const firstDay = dayList[0] ?? today;

      const h = schema.usageCountersHourly;
      const c = schema.usageCounters;
      // Grouped by position: the same expression bound twice would carry two
      // parameter numbers and read as two different expressions.
      const localDate = sql`((${h.hour} at time zone ${tz}::text)::date)::text`;
      const [rows, [allTime]] = await Promise.all([
        ctx.db
          .select({
            day: sql<string>`${localDate}`,
            accepted: sql<number>`sum(${h.accepted})::int`,
            sent: sql<number>`sum(${h.sent})::int`,
            delivered: sql<number>`sum(${h.delivered})::int`,
            bounced: sql<number>`sum(${h.bounced})::int`,
            hardBounced: sql<number>`sum(${h.hardBounced})::int`,
            complained: sql<number>`sum(${h.complained})::int`,
            opened: sql<number>`sum(${h.opened})::int`,
            clicked: sql<number>`sum(${h.clicked})::int`,
            prefetched: sql<number>`sum(${h.prefetched})::int`,
          })
          .from(h)
          .where(
            and(
              eq(h.teamId, ctx.teamId),
              // From the first local day's midnight, as an instant.
              gte(h.hour, sql`(${firstDay}::text::date::timestamp at time zone ${tz}::text)`),
            ),
          )
          .groupBy(sql`1`)
          .orderBy(sql`1`),
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
      const days = dayList.map((day) => byDay.get(day) ?? { day, ...COUNTS });

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
          prefetched: acc.prefetched + d.prefetched,
        }),
        { ...COUNTS },
      );

      // The window always ends on the viewer's current day, which is still
      // being counted: charts draw it as in progress.
      return {
        days,
        totals,
        allTimeDelivered: Number(allTime?.delivered ?? 0),
        today,
      };
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

  /**
   * The score opened up: the same computation plus every failing check
   * priced by what it costs and what fixing it alone would gain.
   */
  accountScoreDetails: teamProcedure.query(async ({ ctx }) => {
    const [input, factors] = await Promise.all([
      fetchAccountScoreInput(ctx.db, ctx.teamId),
      fetchContentFactors(ctx.db, ctx.teamId),
    ]);
    return {
      ...computeAccountScore(input),
      checksTotal: CHECKS.length,
      factors: factors.map((factor) => ({
        id: factor.id,
        severity: factor.severity,
        emails: factor.emails,
        recipients: factor.recipients,
        ...contentFactorImpact(input, factor),
      })),
    };
  }),
});
