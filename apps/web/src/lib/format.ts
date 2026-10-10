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

/** Exact local stamp for hover details ("Sep 2, 2026, 8:15:32 PM"). */
export function formatDateTime(date: Date | string | number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
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

/**
 * DKIM TXT value for display: every RSA-2048 public key opens with the same
 * 44 characters of SPKI header and closes with the exponent's "IDAQAB", so an
 * end-ellipsized chip shows two domains' keys as identical. Keep the tag, a
 * slice from where keys actually differ, and the tail; the full value copies.
 */
export function abbreviateDkim(value: string): string {
  const match = /p=([A-Za-z0-9+/=]{60,})/.exec(value);
  if (!match?.[1]) return value;
  const key = match[1];
  return value.replace(key, `${key.slice(0, 4)}…${key.slice(44, 60)}…${key.slice(-6)}`);
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

/** A countdown as mm:ss, floored at 00:00. */
export function formatMmSs(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
}

export function formatDurationShort(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${trimFixed(ms / 1000, 2)} s`;
  if (ms < 3_600_000) return `${trimFixed(ms / 60_000, 1)} m`;
  if (ms < 86_400_000) return `${trimFixed(ms / 3_600_000, 1)} h`;
  return `${trimFixed(ms / 86_400_000, 1)} d`;
}

/** Cents as US dollars with a bare "$" in every locale ("$20", "$0.30", pt-BR "$0,30"
    rather than "US$ 0,30"): whole dollars drop the decimals. */
export function formatUsd(cents: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })
    .formatToParts(cents / 100)
    .map((part) => (part.type === "currency" ? "$" : part.type === "literal" ? "" : part.value))
    .join("");
}

/** Payload size label ("512 B", "12.4 KB", "1.2 MB"): 1024-based, trailing zeros trimmed. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${trimFixed(bytes / 1024, 1)} KB`;
  return `${trimFixed(bytes / 1_048_576, 1)} MB`;
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
/** The bare address inside a From header value: `Acme <a@acme.dev>` → `a@acme.dev`. */
export function addrSpec(from: string): string {
  const inner = /<([^>]+)>/.exec(from);
  return (inner?.[1] ?? from).trim();
}

/** The domain part of an address, lowercased; "" when there is none. */
export function mailDomain(address: string): string {
  const at = address.lastIndexOf("@");
  return at < 0
    ? ""
    : address
        .slice(at + 1)
        .trim()
        .toLowerCase();
}

export function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

/**
 * An address, URL or domain name rather than prose or a figure: one token,
 * with an "@" or a "/" in it, or dot-separated labels with a letter in them.
 */
export function isAddressLike(text: string): boolean {
  if (/[ \t\n]/.test(text)) return false;
  return /[@/]/.test(text) || (/^[\w-]+(\.[\w-]+)+$/.test(text) && /[a-z]/i.test(text));
}

/**
 * A " · "-joined value cut into its parts, each but the last keeping its "·"
 * behind a no-break space, so the dot never starts a line.
 */
export function dotParts(text: string): string[] {
  const parts = text.split(" · ");
  return parts.map((part, i) => (i < parts.length - 1 ? `${part}\u00a0·` : part));
}

const QUARTER_HOUR_MS = 15 * 60_000;

/** The instant when it is less than a day old, else null. */
export function withinLastDay(at: Date | string | null): Date | null {
  if (!at) return null;
  const then = new Date(at);
  return Date.now() - then.getTime() < 24 * 3_600_000 ? then : null;
}

/** A forecast rounded up to the next quarter hour: what every surface prints as "about". */
export function roundUpToQuarterHour(date: Date | string | number): Date {
  return new Date(Math.ceil(new Date(date).getTime() / QUARTER_HOUR_MS) * QUARTER_HOUR_MS);
}

/** Weekday and date of a send step ("Fri, Sep 18" / "sex., 18 de set."). */
export function formatStepDay(date: Date | string | number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(date));
}

/** A clock time with the zone's abbreviation ("10:30 AM GMT-3"), so a forecast is unambiguous. */
export function formatStepTime(date: Date | string | number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(date));
}

/** "Fri, Sep 18, 10:30 AM GMT-3": the finish stamp of a paced send. */
export function formatFinishAbout(date: Date | string | number, locale: string): string {
  return `${formatStepDay(date, locale)}, ${formatStepTime(date, locale)}`;
}

/** Whether two instants fall on the same local calendar day. */
export function sameLocalDay(a: Date | string | number, b: Date | string | number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

export interface SendDay {
  startsAt: Date;
  endsAt: Date;
  count: number;
}

export interface SendingDay extends SendDay {
  /** Rows of the day already out. */
  sent: number;
  state: "done" | "now" | "next";
}

/**
 * A sending broadcast's days on the local calendar: what already went out
 * plus the planner's releases still to come, each day marked done, today,
 * or ahead.
 */
export function sendingDays(
  sent: readonly { at: Date | string; count: number }[],
  releases: readonly { at: Date | string; endsAt: Date | string; count: number }[],
  now: Date,
): SendingDay[] {
  const past = sent.map((s) => ({ at: s.at, endsAt: s.at, count: s.count }));
  const sentDays = groupReleasesByDay(past);
  return groupReleasesByDay([...past, ...releases]).map((day) => {
    const out = sentDays.find((d) => sameLocalDay(d.startsAt, day.startsAt))?.count ?? 0;
    const state = sameLocalDay(day.startsAt, now) ? "now" : day.startsAt < now ? "done" : "next";
    return { ...day, sent: out, state };
  });
}

/** Whether two instants fall on the same UTC day: the day a daily plan cap resets on. */
export function sameUtcDay(a: Date | string | number, b: Date | string | number): boolean {
  return new Date(a).toISOString().slice(0, 10) === new Date(b).toISOString().slice(0, 10);
}

/**
 * A send's releases grouped by the day they start on, in order: the local
 * day for capacity waves, the UTC day when a daily plan cap paces them (its
 * reset is UTC midnight, so a row per reset needs UTC days).
 */
export function groupReleasesByDay(
  releases: readonly { at: Date | string; endsAt: Date | string; count: number }[],
  day: "local" | "utc" = "local",
): SendDay[] {
  const same = day === "utc" ? sameUtcDay : sameLocalDay;
  const days: SendDay[] = [];
  for (const release of releases) {
    const startsAt = new Date(release.at);
    const endsAt = new Date(release.endsAt);
    const last = days[days.length - 1];
    if (last && same(last.startsAt, startsAt)) {
      last.count += release.count;
      if (endsAt > last.endsAt) last.endsAt = endsAt;
    } else {
      days.push({ startsAt, endsAt, count: release.count });
    }
  }
  return days;
}
