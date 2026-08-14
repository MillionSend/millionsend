export const WARN_RATIO = 0.8;
export const DANGER_RATIO = 0.95;

export function meterClass(ratio: number): string {
  if (ratio >= DANGER_RATIO) return "ms-meter-danger";
  if (ratio >= WARN_RATIO) return "ms-meter-warn";
  return "";
}

const DAY_MS = 86_400_000;

/** "6h 12m" until the next UTC midnight — when daily quota counters reset. */
export function formatUtcDayReset(now = Date.now()): string {
  const left = DAY_MS - (now % DAY_MS);
  const h = Math.floor(left / 3_600_000);
  const m = Math.floor((left % 3_600_000) / 60_000);
  return `${h}h ${m}m`;
}
