const MINUTE = 60;
const HOUR = 3_600;
const DAY = 86_400;
const MONTH = 2_592_000;
const YEAR = 31_536_000;

/**
 * Compact relative timestamp ("24 min. ago", "1h ago"). Localized via
 * Intl.RelativeTimeFormat instead of the message catalogs so the unit
 * grammar stays correct in every locale.
 */
export function formatRelative(
  date: Date | string | number,
  locale: string,
  now: Date = new Date(),
): string {
  const diffSec = Math.round((new Date(date).getTime() - now.getTime()) / 1000);
  const abs = Math.abs(diffSec);
  const rtf = new Intl.RelativeTimeFormat(locale, { style: "narrow" });
  if (abs < MINUTE) return rtf.format(diffSec, "second");
  if (abs < HOUR) return rtf.format(Math.trunc(diffSec / MINUTE), "minute");
  if (abs < DAY) return rtf.format(Math.trunc(diffSec / HOUR), "hour");
  if (abs < MONTH) return rtf.format(Math.trunc(diffSec / DAY), "day");
  if (abs < YEAR) return rtf.format(Math.trunc(diffSec / MONTH), "month");
  return rtf.format(Math.trunc(diffSec / YEAR), "year");
}

/** Short day label ("Aug 13" / "13 de ago."). */
export function formatDay(date: Date | string | number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(new Date(date));
}

/** Mail-client header date ("Aug 14, 2026, 6:53 PM" / "14 de ago. de 2026 18:53"). */
export function formatMailDate(date: Date | string | number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(date));
}

/** Ledger timestamp: UTC ISO-8601 to the second ("2026-08-13 14:02:11Z"). */
export function formatUtcTimestamp(date: Date | string | number): string {
  return `${new Date(date).toISOString().slice(0, 19).replace("T", " ")}Z`;
}

/** Event-canvas timestamp: UTC to the millisecond ("2026-08-12 14:03:20.208 UTC"). */
export function formatUtcTimestampMs(date: Date | string | number): string {
  return `${new Date(date).toISOString().slice(0, 23).replace("T", " ")} UTC`;
}

/** Coarse UTC stamp to the minute ("2026-08-12 06:02 UTC"). */
export function formatUtcMinute(date: Date | string | number): string {
  return `${new Date(date).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** Trims trailing zeros from a fixed-decimal rendering ("2.30" → "2.3"). */
function trimFixed(value: number, decimals: number): string {
  return value.toFixed(decimals).replace(/\.?0+$/, "");
}

/**
 * Compact duration for event deltas and mastheads: "21 ms", "1.92 s",
 * "6.4 m", "1.2 h", "3 d" — the unit always spaced, mono-friendly.
 */
/** Countdown rendering ("5h 32m", "48m") for quota-reset banners. */
export function formatHoursMinutes(ms: number): string {
  const totalMinutes = Math.max(0, Math.ceil(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export function formatDurationShort(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${trimFixed(ms / 1000, 2)} s`;
  if (ms < 3_600_000) return `${trimFixed(ms / 60_000, 1)} m`;
  if (ms < 86_400_000) return `${trimFixed(ms / 3_600_000, 1)} h`;
  return `${trimFixed(ms / 86_400_000, 1)} d`;
}

/**
 * Middle truncation preserving both ends ("p=MIGfMA…QIDAQAB"). Returns null
 * when the value fits — callers render the gap as a dim […] token and must
 * keep the full value behind a copy affordance.
 */
export function midTruncateParts(value: string, max = 32): { head: string; tail: string } | null {
  if (value.length <= max) return null;
  const keep = Math.floor((max - 3) / 2);
  return { head: value.slice(0, keep), tail: value.slice(-keep) };
}

/**
 * "ms_live_••••••••abcd" — drops the 6 indexed secret chars the stored
 * tokenPrefix carries; the mask shows only the scheme and the last 4.
 * The scheme is matched structurally, not by splitting on the last "_":
 * the secret chars are base64url, which itself contains "_".
 */
export function maskApiKey(tokenPrefix: string, last4: string): string {
  const scheme = /^ms_(?:live|test)_/.exec(tokenPrefix)?.[0] ?? tokenPrefix;
  return `${scheme}••••••••${last4}`;
}
