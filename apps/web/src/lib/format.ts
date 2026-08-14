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

/** Ledger timestamp: UTC ISO-8601 to the second ("2026-08-13 14:02:11Z"). */
export function formatUtcTimestamp(date: Date | string | number): string {
  return `${new Date(date).toISOString().slice(0, 19).replace("T", " ")}Z`;
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
