import type { Period } from "@/components/console/chart-dialog";

/**
 * Pure helpers for the operator console. The plan ladder lives in
 * @millionsend/core/plans, whose barrel is server-only; the few facts the
 * console dialogs print (prices, daily limits, the volume format) are
 * restated here and must match PLAN_RUNGS.
 */

const DAY_MS = 86_400_000;

/** A ratio as a percentage with exactly `decimals` places ("98.5%" / "98,5%"). */
export function formatPercent(value: number, locale: string, decimals: number): string {
  return new Intl.NumberFormat(locale, {
    style: "percent",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

/** A delta ratio with its sign ("+8.1%", "-2.0%"). */
export function formatSignedPercent(value: number, locale: string, decimals: number): string {
  return new Intl.NumberFormat(locale, {
    style: "percent",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    signDisplay: "exceptZero",
  }).format(value);
}

/** Local wall-clock label for an hourly point ("14:00" / "2:00 PM"). */
export function formatHourMinute(date: Date | string | number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(
    new Date(date),
  );
}

export type DurationUnit = "seconds" | "minutes" | "hours" | "days";

/** The largest whole unit a duration in seconds reads in, for the console.common.duration.* catalog. */
export function durationUnit(seconds: number): { unit: DurationUnit; n: number } {
  if (seconds < 60) return { unit: "seconds", n: Math.round(seconds) };
  if (seconds < 3_600) return { unit: "minutes", n: Math.round(seconds / 60) };
  if (seconds < 86_400) return { unit: "hours", n: Math.round(seconds / 3_600) };
  return { unit: "days", n: Math.round(seconds / 86_400) };
}

function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * The UTC day keys a console period spans, oldest first. Mirrors the
 * server's resolvePeriod + dayKeys (apps/web/src/server/console/periods.ts)
 * so a per-day series can be zero-filled on the client.
 */
export function periodDayKeys(period: Period, now: Date = new Date()): string[] {
  let from: number;
  let to = now.getTime();
  if (period === "24h") {
    from = to - DAY_MS;
  } else if (typeof period === "string") {
    const days = { "7d": 7, "30d": 30, "90d": 90 }[period];
    from = Date.parse(`${utcDay(to - (days - 1) * DAY_MS)}T00:00:00Z`);
  } else {
    from = Date.parse(`${period.from}T00:00:00Z`);
    to = Math.min(to, Date.parse(`${period.to}T23:59:59.999Z`));
  }
  const out: string[] = [];
  for (let t = Date.parse(utcDay(from)); t <= to; t += DAY_MS) out.push(utcDay(t));
  return out;
}

/** "100K", "1M", "1.5M": mirrors formatVolume in @millionsend/core/plans. */
export function formatVolume(n: number): string {
  if (n >= 1_000_000) return `${n / 1_000_000}M`;
  if (n >= 1_000) return `${n / 1_000}K`;
  return String(n);
}

/** Monthly price in cents per plan rung key. */
export const RUNG_PRICE_CENTS: Record<string, number> = {
  starter: 900,
  pro_100k: 2_000,
  pro_200k: 3_500,
  scale_500k: 7_500,
  scale_1m: 14_000,
  scale_1_5m: 20_000,
  scale_2_5m: 33_000,
};

/** Emails per day on the daily-capped plans. */
export const PLAN_DAY_LIMIT: Record<string, number> = {
  free: 100,
  starter: 1_500,
};

/** "Pro 100K" on a monthly rung, the bare (already translated) plan name otherwise. */
export function planLabel(name: string, planQuota: number | null): string {
  return planQuota ? `${name} ${formatVolume(planQuota)}` : name;
}

/** Plan pill tone: info for system, success for paid, neutral for free and unknown values. */
export function planTone(plan: string): "info" | "success" | "neutral" {
  if (plan === "system") return "info";
  if (plan === "starter" || plan === "pro" || plan === "scale") return "success";
  return "neutral";
}
