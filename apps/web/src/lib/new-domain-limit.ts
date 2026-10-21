import type { NewDomainLimit } from "@millionsend/core";
import { limitSpent } from "@millionsend/core/limit-rules";
import type { RailStep } from "@/components/step-rail";
import { formatDay, formatStepDay, formatTime, sameUtcDay } from "@/lib/format";
import { utcDayInstant } from "@/lib/warmup";

export type LimitTranslate = (key: string, values?: Record<string, string | number>) => string;

type DayFigures = Pick<NewDomainLimit, "cap" | "used" | "pool">;

/** The limits a domains list carries on its rows, or undefined while it loads. */
export function domainLimits(
  rows: readonly { limit: NewDomainLimit | null }[] | undefined,
): NewDomainLimit[] | undefined {
  return rows?.flatMap((row) => (row.limit ? [row.limit] : []));
}

/** The figures that hold mail back: the shared volume's once it is spent, else the domain's own. */
export function bindingFigures(limit: DayFigures): { cap: number; used: number } {
  return limitSpent(limit) === "pool" && limit.pool ? limit.pool : limit;
}

/** When a held email goes out: at the next drain, after the next reset, or on a later day. */
export function releaseWhen(
  at: { sendsAfter: Date | string; resetsAt: Date | string },
  now: Date = new Date(),
): "soon" | "next" | "later" {
  const sends = new Date(at.sendsAfter).getTime();
  if (sends <= now.getTime()) return "soon";
  return sends === new Date(at.resetsAt).getTime() ? "next" : "later";
}

/**
 * When a list row the limit holds goes out: at its own place in its domain's
 * line when the list knows it, else as the domain's day stands (the next
 * reset once the day is spent, the next drain while it has room).
 */
export function rowRelease(
  sendsAfter: Date | string | null | undefined,
  limit: DayFigures & { resetsAt: Date | string },
  now: Date = new Date(),
): { at: Date | string; when: "soon" | "next" | "later" } {
  const at = sendsAfter ?? (limitSpent(limit) ? limit.resetsAt : now);
  return { at, when: releaseWhen({ sendsAfter: at, resetsAt: limit.resetsAt }, now) };
}

/**
 * The schedule in one sentence of volumes and dates ("Up to 300 emails a day
 * until Oct 24, then 2,000 a day until Nov 16, then no limit"), from the
 * "domains" namespace; null for an unknown age, which has no schedule.
 */
export function limitSchedule(
  limit: Pick<NewDomainLimit, "steps">,
  t: LimitTranslate,
  locale: string,
): string | null {
  const { steps } = limit;
  if (steps.length < 2) return null;
  const nf = new Intl.NumberFormat(locale);
  const parts = steps.map((step, i) => {
    const next = steps[i + 1];
    if (step.cap === null || !next) return t("list.limit.end");
    const values = { cap: nf.format(step.cap), date: formatDay(next.from, locale) };
    return t(i === 0 ? "list.limit.first" : "list.limit.then", values);
  });
  return parts.join(", ");
}

/**
 * The days ahead as rail rows, from the "domains" namespace: today against
 * what binds it, the next reset while mail waits for it, then each step of
 * the schedule. The reset reads as its UTC day, the day the counters keep,
 * and a step that starts on that day sets the cap its row shows, so each
 * date appears once. With room left today, held mail goes at the next drain
 * and no reset row is needed.
 */
export function limitRailSteps(
  limit: NewDomainLimit,
  t: LimitTranslate,
  locale: string,
): RailStep[] {
  const nf = new Intl.NumberFormat(locale);
  const today = bindingFigures(limit);
  const spent = limitSpent(limit) !== null;
  const resetsAt = new Date(limit.resetsAt);
  const stepRow = (step: NewDomainLimit["steps"][number]): RailStep => ({
    key: new Date(step.from).toISOString(),
    when: formatStepDay(step.from, locale),
    what:
      step.cap === null
        ? t("detail.limit.railNoLimit")
        : t("detail.limit.railUpTo", { cap: nf.format(step.cap) }),
  });
  const later = limit.steps.slice(1);
  const byReset = later.filter(
    (step) => new Date(step.from) <= resetsAt || sameUtcDay(step.from, resetsAt),
  );
  const capAtReset = byReset.at(-1)?.cap ?? limit.cap;
  const todayRow: RailStep = {
    key: "today",
    when: t("detail.limit.railToday"),
    what: t("detail.limit.railTodayWhat", {
      cap: nf.format(today.cap),
      used: nf.format(today.used),
    }),
    sub:
      limit.waiting === 0
        ? undefined
        : t(spent ? "detail.limit.railTodayMore" : "detail.limit.railTodaySoon", {
            count: limit.waiting,
          }),
    state: "now",
    progress: today.used / Math.max(1, today.cap),
  };
  if (limit.waiting === 0 || !spent || capAtReset === null) {
    return [todayRow, ...later.map(stepRow)];
  }
  return [
    todayRow,
    ...later.filter((step) => new Date(step.from) < resetsAt).map(stepRow),
    {
      key: "reset",
      when: formatStepDay(utcDayInstant(resetsAt.toISOString().slice(0, 10)), locale),
      what: t("detail.limit.railUpTo", { cap: nf.format(capAtReset) }),
      sub: t("detail.limit.railWaitingFirst", { count: limit.waiting }),
    },
    ...later.filter((step) => !byReset.includes(step)).map(stepRow),
  ];
}

/** One email the limit holds, as the email page reads it. */
export interface LimitHold {
  domain: string;
  cap: number;
  used: number;
  pool: NewDomainLimit["pool"];
  ahead: number;
  sendsAfter: Date | string;
  resetsAt: Date | string;
}

/**
 * The email page's copy for a held email, from the "emails" namespace: the
 * header's tail, the banner's body, and the two dashed nodes (what holds
 * it, then when it is expected to go).
 */
export function limitHoldCopy(
  hold: LimitHold,
  t: LimitTranslate,
  locale: string,
  now = new Date(),
) {
  const nf = new Intl.NumberFormat(locale);
  const when = releaseWhen(hold, now);
  const spent = limitSpent(hold);
  const figures = bindingFigures(hold);
  const time = formatTime(hold.sendsAfter, locale);
  const date = formatDay(hold.sendsAfter, locale);
  return {
    subtitle:
      when === "soon"
        ? t("detail.goesOutSoon")
        : t(when === "next" ? "detail.goesOutAfter" : "detail.goesOutOn", { time, date }),
    banner: [
      spent === "pool"
        ? t("detail.limitBanner.spentPool", { cap: nf.format(figures.cap) })
        : spent
          ? t("detail.limitBanner.spentDomain", { cap: nf.format(hold.cap) })
          : null,
      t(`detail.limitBanner.${when}`, { time, date }),
      t("detail.limitBanner.nothingToDo"),
    ]
      .filter(Boolean)
      .join(" "),
    used: t(
      spent === "pool"
        ? "detail.pending.newDomainLimitPoolUsed"
        : "detail.pending.newDomainLimitUsed",
      { used: nf.format(figures.used), cap: nf.format(figures.cap) },
    ),
    body: t("detail.pending.newDomainLimitBody", { domain: hold.domain, ahead: hold.ahead }),
    expectedWhen:
      when === "soon"
        ? t("detail.pending.expectedSoon")
        : when === "next"
          ? t("detail.pending.expectedNext")
          : formatStepDay(hold.sendsAfter, locale),
    expectedBody:
      when === "soon"
        ? t("detail.pending.expectedSoonBody")
        : t("detail.pending.expectedBody", { time }),
  };
}
