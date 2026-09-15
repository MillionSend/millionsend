import { DAY_MS, utcDay } from "@millionsend/core";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

export const PERIOD_KEYS = ["24h", "7d", "30d", "90d"] as const;
export type PeriodKey = (typeof PERIOD_KEYS)[number];

// A round trip through Date rejects the impossible dates the shape lets through (02-31).
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const t = Date.parse(`${s}T00:00:00Z`);
    return !Number.isNaN(t) && utcDay(t) === s;
  });

/** A preset window or a custom UTC date range (inclusive, whole days). */
export const periodSchema = z.union([
  z.enum(PERIOD_KEYS),
  z.object({ from: isoDate, to: isoDate }),
]);
export type PeriodInput = z.infer<typeof periodSchema>;

export interface ResolvedPeriod {
  from: Date;
  to: Date;
  /** Hourly points for a day, daily points for anything longer. */
  grain: "hour" | "day";
  /** Probe history bucket, sized so a chart never carries more than a few hundred points. */
  bucketSeconds: number;
}

const HOUR_S = 3_600;

export function resolvePeriod(period: PeriodInput, now: Date = new Date()): ResolvedPeriod {
  if (period === "24h") {
    // Hour-aligned: the hourly counters are keyed by hour start, and a window
    // starting mid-hour would drop its first bucket.
    const from = new Date(now.getTime() - DAY_MS);
    from.setUTCMinutes(0, 0, 0);
    return { from, to: now, grain: "hour", bucketSeconds: 300 };
  }
  if (typeof period === "string") {
    const days = { "7d": 7, "30d": 30, "90d": 90 }[period];
    const from = new Date(`${utcDay(now.getTime() - (days - 1) * DAY_MS)}T00:00:00Z`);
    return {
      from,
      to: now,
      grain: "day",
      bucketSeconds: days <= 7 ? HOUR_S : days <= 30 ? 6 * HOUR_S : 24 * HOUR_S,
    };
  }
  const from = new Date(`${period.from}T00:00:00Z`);
  const end = new Date(`${period.to}T23:59:59.999Z`);
  if (end < from) throw new TRPCError({ code: "BAD_REQUEST", message: "invalid_period" });
  const to = end < now ? end : now;
  const days = Math.round((end.getTime() - from.getTime()) / DAY_MS) + 1;
  return {
    from,
    to,
    grain: "day",
    bucketSeconds: days <= 7 ? HOUR_S : days <= 60 ? 6 * HOUR_S : 24 * HOUR_S,
  };
}

/** The window of the same length that ends where `period` starts: whole days for a day grain, a day for an hour grain. */
export function previousPeriod(period: ResolvedPeriod): ResolvedPeriod {
  const span = period.grain === "hour" ? DAY_MS : dayKeys(period.from, period.to).length * DAY_MS;
  return {
    ...period,
    from: new Date(period.from.getTime() - span),
    to: new Date(period.from.getTime() - 1),
  };
}

/** Every UTC day key from `from` to `to`, inclusive. */
export function dayKeys(from: Date, to: Date): string[] {
  const out: string[] = [];
  for (let t = Date.parse(utcDay(from)); t <= to.getTime(); t += DAY_MS) out.push(utcDay(t));
  return out;
}

/** Every UTC hour start from `from` (floored) to `to`, as ISO strings. */
export function hourKeys(from: Date, to: Date): string[] {
  const out: string[] = [];
  const start = new Date(from);
  start.setUTCMinutes(0, 0, 0);
  for (let t = start.getTime(); t <= to.getTime(); t += HOUR_S * 1000) {
    out.push(new Date(t).toISOString());
  }
  return out;
}
