/**
 * The one reading of a contact property as a date. API writes and the
 * dashboard call parsePropertyDate, and segments and the warm-up read the
 * same patterns in SQL (propertyDateSql in segment-filter.ts). Imports
 * nothing, so the browser reads a value the way the server does.
 *
 * Trimmed of spaces, a value reads as a date when it is an ISO 8601 date
 * (UTC midnight), an ISO 8601 date-time with T or a space, optional seconds
 * and fraction and an optional zone (UTC when it names none), or a bare
 * number that is Unix time from 2000 to 2100 in seconds or milliseconds,
 * so a count like "3" never reads as 1970. Years run from 1 to 9999.
 */

// [0-9], not \d: under some locales Postgres counts other scripts' digits as \d.
const DATE = "([0-9]{4})-([0-9]{2})-([0-9]{2})";
// At most 9 fraction digits, so JS never reads a long fraction Postgres refuses.
const TIME = "[T ]([01][0-9]|2[0-3]):([0-5][0-9])(?::([0-5][0-9])(?:\\.([0-9]{1,9}))?)?";
const ZONE = "(Z|[+-](?:0[0-9]|1[0-4])(?::?[0-5][0-9])?)";

/** The shapes a date may take, as regexes Postgres and JS read alike. */
export const PROPERTY_DATE_PATTERNS = {
  // A fraction is kept: Date.now() / 1000 and time.time() write one.
  epoch: "^[0-9]+(?:\\.[0-9]+)?$",
  date: `^${DATE}$`,
  zoned: `^${DATE}${TIME}${ZONE}$`,
  local: `^${DATE}${TIME}$`,
} as const;

/** The most days a segment's in_last_days and not_in_last_days take: a hundred years. */
export const SEGMENT_FILTER_MAX_DAYS = 36_500;

/** Whether `value` is a day count in_last_days and not_in_last_days take. */
export const isSegmentDayCount = (value: string | null): boolean =>
  value !== null && /^[1-9][0-9]*$/.test(value) && Number(value) <= SEGMENT_FILTER_MAX_DAYS;

/** Unix seconds a bare number may hold, 2000-01-01 to 2100-01-01, or a thousand times these in milliseconds. */
export const PROPERTY_EPOCH_SECONDS = { from: 946_684_800, to: 4_102_444_800 } as const;

const EPOCH = new RegExp(PROPERTY_DATE_PATTERNS.epoch);
const DATE_TIME = new RegExp(`^${DATE}(?:${TIME}${ZONE}?)?$`);

/** `value` read as a date, or null when it is not one. */
export function parsePropertyDate(value: string): Date | null {
  const text = value.replace(/^ +| +$/g, "");
  if (EPOCH.test(text)) {
    const n = Number(text);
    const { from, to } = PROPERTY_EPOCH_SECONDS;
    if (n >= from && n <= to) return new Date(n * 1000);
    if (n >= from * 1000 && n <= to * 1000) return new Date(n);
    return null;
  }
  const m = DATE_TIME.exec(text);
  if (!m) return null;
  const part = (i: number) => Number(m[i] ?? 0);
  const [year, month, day] = [part(1), part(2), part(3)];
  const at = new Date(0);
  // setUTCFullYear, not Date.UTC: Date.UTC reads years 0 to 99 as 1900 to 1999.
  at.setUTCFullYear(year, month - 1, day);
  if (year < 1 || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) return null;
  at.setUTCHours(part(4), part(5), part(6), Number((m[7] ?? "").slice(0, 3).padEnd(3, "0")));
  const zone = m[8]?.replace(":", "") ?? "Z";
  const offset =
    zone === "Z"
      ? 0
      : (zone[0] === "-" ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3) || 0));
  return new Date(at.getTime() - offset * 60_000);
}
