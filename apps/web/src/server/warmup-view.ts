import {
  nextUtcDayStart,
  SES_QUOTA_SLOT_MS,
  WARMUP_SLICES_PER_DAY,
  warmupSignalFigure,
} from "@millionsend/core";
import type { WarmupSignals } from "@millionsend/db/schema";
import { WARMUP_SIGNAL_KEYS, type WarmupSignalView } from "@/lib/warmup";

/** A checked day's signals as the dashboard reads them, each with the figure it was judged on. */
export function signalViews(signals: WarmupSignals | null): WarmupSignalView[] | null {
  return signals
    ? WARMUP_SIGNAL_KEYS.map((key) => ({
        key,
        result: signals[key].result,
        figure: warmupSignalFigure(signals, key),
        gmail: signals[key].gmail,
        other: signals[key].other,
      }))
    : null;
}

/**
 * Today's sending window at the drain's pace, a 48th of the allowance per
 * 15-minute run: when it started, read back from what went out, and when
 * `left` more have gone. Null when nothing is left for today.
 */
export function warmupTodayWindow(
  today: { day: string; allowance: number; sent: number },
  left: number,
  now: Date,
): { startsAt: Date; endsAt: Date } | null {
  if (left <= 0) return null;
  const slice = Math.ceil(today.allowance / WARMUP_SLICES_PER_DAY);
  const runs = (n: number) => Math.ceil(n / slice) * SES_QUOTA_SLOT_MS;
  return {
    startsAt: new Date(
      Math.max(Date.parse(`${today.day}T00:00:00Z`), now.getTime() - runs(today.sent)),
    ),
    endsAt: new Date(Math.min(nextUtcDayStart(now).getTime(), now.getTime() + runs(left))),
  };
}
