import {
  CHECKS,
  computeAccountScore,
  contentFactorImpact,
  DAY_MS,
  fetchAccountScore,
  fetchAccountScoreInput,
  fetchContentFactors,
  fetchDeliverabilityHealth,
  MIN_OUTCOME_SENDS,
  PAUSE_BOUNCE_RATE,
  PAUSE_COMPLAINT_RATE,
  utcDay,
  WARN_BOUNCE_RATE,
  WARN_COMPLAINT_RATE,
} from "@millionsend/core";
import { counterComplaintSent } from "@millionsend/core/deliverability";
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
      const utcToday = utcDay(now);
      const utcDayList = Array.from({ length: windowDays }, (_, i) =>
        utcDay(now - (windowDays - 1 - i) * DAY_MS),
      );

      const h = schema.usageCountersHourly;
      const c = schema.usageCounters;
      // Grouped by position: the same expression bound twice would carry two
      // parameter numbers and read as two different expressions.
      const localDate = sql`((${h.hour} at time zone ${tz}::text)::date)::text`;
      // The first local day's midnight, as an instant.
      const rangeStart = sql`(${firstDay}::text::date::timestamp at time zone ${tz}::text)`;
      const [rows, [allTime], complaintRows, [lifted]] = await Promise.all([
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
          .where(and(eq(h.teamId, ctx.teamId), gte(h.hour, rangeStart)))
          .groupBy(sql`1`)
          .orderBy(sql`1`),
        // ::bigint — the all-time sum of int columns overflows int4 for large
        // senders. The driver returns bigint as a string; Number() below is
        // exact up to 2^53 deliveries.
        ctx.db
          .select({ delivered: sql<string>`coalesce(sum(${c.delivered}), 0)::bigint` })
          .from(c)
          .where(eq(c.teamId, ctx.teamId)),
        // The complaint card divides by the sends that could draw a
        // complaint, as the guardrail does, and only the daily table counts
        // them: its days are UTC days.
        ctx.db
          .select({
            day: c.day,
            sent: c.sent,
            complaintSent: sql<number>`(${counterComplaintSent})::int`,
            complained: c.complained,
          })
          .from(c)
          .where(and(eq(c.teamId, ctx.teamId), gte(c.day, utcDayList[0] ?? utcToday))),
        // ponytail: the totals sum hourly rows into the viewer's local days,
        // but a lift's snapshot lives on the daily (UTC) rows only, so this
        // sums every UTC day the local range touches and can run a few hours
        // past its edges; an hourly snapshot column would match exactly.
        ctx.db
          .select({ hardBounced: sql<number>`coalesce(sum(${c.excludedHardBounced}), 0)::int` })
          .from(c)
          .where(
            and(
              eq(c.teamId, ctx.teamId),
              gte(c.day, sql`(${rangeStart} at time zone 'UTC')::date`),
            ),
          ),
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

      const complaintsByDay = new Map(complaintRows.map((r) => [r.day, r]));
      const sum = (key: "sent" | "complaintSent" | "complained") =>
        complaintRows.reduce((acc, r) => acc + r[key], 0);

      // The window always ends on the viewer's current day, which is still
      // being counted: charts draw it as in progress.
      return {
        days,
        totals,
        allTimeDelivered: Number(allTime?.delivered ?? 0),
        // Hard bounces pause lifts left out of the guardrail; totals keep them.
        liftedHardBounced: lifted?.hardBounced ?? 0,
        today,
        complaints: {
          days: utcDayList.map((day) => ({
            day,
            complaintSent: complaintsByDay.get(day)?.complaintSent ?? 0,
            complained: complaintsByDay.get(day)?.complained ?? 0,
          })),
          sent: sum("sent"),
          complaintSent: sum("complaintSent"),
          complained: sum("complained"),
          today: utcToday,
        },
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
      complaintsJudged: input.complaintSent >= MIN_OUTCOME_SENDS,
      bouncesJudged: input.bounceSent >= MIN_OUTCOME_SENDS,
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
