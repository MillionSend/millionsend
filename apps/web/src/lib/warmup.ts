import type { RailStep } from "@/components/step-rail";
import { formatStepDay } from "@/lib/format";

export const WARMUP_SIGNAL_KEYS = [
  "delays",
  "opens",
  "hardBounces",
  "mailboxFull",
  "complaints",
] as const;
export type WarmupSignalKey = (typeof WARMUP_SIGNAL_KEYS)[number];
export type WarmupSignalResult = "within" | "missed" | "severe" | "unknown";

/** One signal of a checked day as the dashboard gets it: the figure it was judged on, and each side. */
export interface WarmupSignalView {
  key: WarmupSignalKey;
  result: WarmupSignalResult;
  figure: number | null;
  gmail: number | null;
  other: number | null;
}

type Translate = (key: string, values?: Record<string, string>) => string;

export function formatWarmupPercent(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(
    value,
  );
}

/** The signals that missed or broke their line, severe first. */
function flagged(signals: readonly WarmupSignalView[]): WarmupSignalView[] {
  const rank = (r: WarmupSignalResult) => (r === "severe" ? 0 : 1);
  return signals
    .filter((s) => (s.result === "severe" || s.result === "missed") && s.figure !== null)
    .sort((a, b) => rank(a.result) - rank(b.result));
}

/** One sentence per flagged signal, from the "warmup" namespace's `signals`. */
export function warmupReasons(
  signals: readonly WarmupSignalView[],
  t: Translate,
  locale: string,
): string {
  return flagged(signals)
    .map((s) => t(`signals.${s.key}`, { pct: formatWarmupPercent(s.figure ?? 0, locale) }))
    .join(" ");
}

/** The worst flagged signal as a short note for a day's rail row, or null when all were within. */
export function warmupReasonShort(
  signals: readonly WarmupSignalView[],
  t: Translate,
  locale: string,
): string | null {
  const worst = flagged(signals)[0];
  return worst
    ? t(`signalsShort.${worst.key}`, { pct: formatWarmupPercent(worst.figure ?? 0, locale) })
    : null;
}

/** A UTC day ("2026-10-14") at noon, an instant every zone from UTC-11 to UTC+11 reads as that same date. */
export function utcDayInstant(day: string): Date {
  return new Date(`${day}T12:00:00Z`);
}

/** Days past this many show as their first three, one range row, then the last. */
const RAIL_MAX_ROWS = 5;

/**
 * A warm-up plan's days as rail rows: `labels` reads them as dates ("Now"
 * for a first day that is today) or as "Day n". The first row says the
 * most active go first, the second that it grows while delivery is healthy,
 * and `last` writes the final row.
 */
export function warmupPlanSteps(opts: {
  perDay: readonly { day: string; count: number }[];
  locale: string;
  t: Translate;
  labels: "dates" | "days";
  startsNow?: boolean;
  last: (count: string) => React.ReactNode;
}): RailStep[] {
  const { perDay, locale, t } = opts;
  const nf = new Intl.NumberFormat(locale);
  const when = (i: number) => {
    if (opts.labels === "days") return t("rail.day", { n: String(i + 1) });
    if (i === 0 && opts.startsNow) return t("rail.now");
    return formatStepDay(utcDayInstant(perDay[i]?.day ?? ""), locale);
  };
  const row = (i: number): RailStep => {
    const count = nf.format(perDay[i]?.count ?? 0);
    const isLast = i === perDay.length - 1;
    return {
      key: perDay[i]?.day,
      when: when(i),
      what: isLast
        ? opts.last(count)
        : t(i === 0 ? "rail.first" : i === 1 ? "rail.next" : "rail.more", { count }),
      state: i === 0 && opts.startsNow ? "now" : undefined,
    };
  };
  if (perDay.length <= RAIL_MAX_ROWS) return perDay.map((_, i) => row(i));
  const middle = perDay.slice(3, -1);
  const from = middle[0];
  const to = middle.at(-1);
  const counts = middle.map((d) => d.count);
  const range: RailStep = {
    key: "range",
    when:
      opts.labels === "days"
        ? t("rail.days", { from: "4", to: String(perDay.length - 1) })
        : new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).formatRange(
            utcDayInstant(from?.day ?? ""),
            utcDayInstant(to?.day ?? ""),
          ),
    what: t("rail.range", {
      from: nf.format(Math.min(...counts)),
      to: nf.format(Math.max(...counts)),
    }),
  };
  return [row(0), row(1), row(2), range, row(perDay.length - 1)];
}
