export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const numberFormat = new Intl.NumberFormat("en-US");

/** 12847 → "12,847". Every count the tool prints is exact, never rounded. */
export const formatNumber = (n: number): string => numberFormat.format(n);

/** Consecutive slices of at most `size` items, in order. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** "12 s" under a minute, "about 4 min" above. */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`;
  return `about ${Math.round(seconds / 60)} min`;
}

/** JSON with object keys sorted at every depth, so equal values hash and compare equal. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : v,
  );
}

/** Lowercased domain of `user@domain` or `Name <user@domain>`; null when no address is found. */
export function senderDomain(from: string): string | null {
  const address = /<([^<>]+)>\s*$/.exec(from)?.[1] ?? from;
  const at = address.lastIndexOf("@");
  if (at === -1) return null;
  const domain = address
    .slice(at + 1)
    .trim()
    .toLowerCase();
  return domain === "" ? null : domain;
}

/** "free" → "Free". */
export const capitalize = (s: string): string => `${s[0]?.toUpperCase() ?? ""}${s.slice(1)}`;

/** `pluralize(1, "domain")` → "1 domain", `pluralize(3, "domain")` → "3 domains". */
export const pluralize = (n: number, noun: string, plural = `${noun}s`): string =>
  `${formatNumber(n)} ${n === 1 ? noun : plural}`;

// CSI and OSC sequences first: a lone ESC also matches the C0 class, which
// would leave the `[2J` / `]52;…` tail behind as visible junk.
const CONTROL_RE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the control bytes are the target
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|[\x00-\x08\x0b-\x1f\x7f]/g;

/**
 * Drops C0 controls (tab and newline kept), DEL, CSI and OSC sequences. Names,
 * keys and API messages come from the source account and are never allowed to
 * drive the terminal (clear screen, set clipboard, restyle output).
 */
export const stripControl = (s: string): string => s.replace(CONTROL_RE, "");

/** `stripControl` over every string in a JSON-shaped value. */
export const stripControlDeep = <T>(value: T): T =>
  JSON.parse(
    JSON.stringify(value, (_key, v: unknown) => (typeof v === "string" ? stripControl(v) : v)),
  ) as T;

/** `s` cut to at most `width` characters, the last one an ellipsis when anything was cut. */
export function truncate(s: string, width: number): string {
  const chars = [...s];
  if (chars.length <= width) return s;
  return `${chars.slice(0, Math.max(0, width - 1)).join("")}…`;
}
