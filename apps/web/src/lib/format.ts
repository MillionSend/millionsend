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

/**
 * Short day label for a UTC day key ("2026-08-13" → "Aug 13"), pinned to UTC —
 * local-zone formatting would shift the day in negative-offset timezones.
 */
export function formatDayUtc(day: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${day}T00:00:00Z`));
}

/** Natural day+time stamp ("Aug 16, 8:12 PM" / "16 de ago., 20:12"). */
export function formatDayTime(date: Date | string | number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  }).format(new Date(date));
}

/** Exact local stamp for hover details ("Sep 2, 2026, 8:15:32 PM GMT-3"). */
export function formatDateTime(date: Date | string | number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
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
 * "ms_••••••••abcd" — drops the 6 indexed secret chars the stored
 * tokenPrefix carries; the mask shows only the scheme and the last 4.
 */
export function maskApiKey(tokenPrefix: string, last4: string): string {
  const scheme = tokenPrefix.startsWith("ms_") ? "ms_" : tokenPrefix;
  return `${scheme}••••••••${last4}`;
}

/**
 * URL for display surfaces (chips, table cells, headings): the scheme is
 * noise there — endpoints are https-only, so it carries no information.
 * Copy affordances must still copy the full URL; pass this only as the
 * visible text.
 */
export function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//, "");
}
