/**
 * Tells a person's open apart from a tracking-image fetch a machine made
 * before anyone looked: Apple Mail Privacy Protection downloads every image
 * in the background, Gmail pre-fetches while the inbox is already open, and
 * security gateways scan a message within seconds of delivery. Rules run in
 * order and the first match wins; a fetch none of them claims is a person.
 * Gmail's and Yahoo's image proxies fetch when the message is rendered, so
 * they count as people unless the timing says otherwise.
 */

/**
 * Why a fetch was classed a prefetch. "burst" is applied by the click
 * recorder, which sees the other links of the message; the rest here.
 */
export const PREFETCH_REASONS = [
  "apple_mpp",
  "gmail_prefetch",
  "scanner",
  "spoofed_ua",
  "before_delivery",
  "timing",
  "burst",
] as const;
export type PrefetchReason = (typeof PREFETCH_REASONS)[number];

export type OpenVerdict = { prefetched: false } | { prefetched: true; reason: PrefetchReason };

/** Apple's proxy strips the user agent down to exactly this; no mail client sends it bare. */
const APPLE_MPP_USER_AGENT = "Mozilla/5.0";

/** The fixed user agent Gmail's image pre-fetch has carried since 2021. */
const GMAIL_PREFETCH_MARKERS = ["Chrome/42.0.2311.135", "Edge/12.246"] as const;

/**
 * Scanner, crawler and link-preview tokens, matched case-insensitively as
 * substrings. Deliberately absent: GoogleImageProxy, YahooMailProxy and
 * ms-office — those fetch on behalf of a person reading the message. "bot"
 * is matched only with the delimiter crawlers put after it: bare "bot" is
 * also inside Cubot handsets' user agents.
 */
const SCANNER_TOKENS = [
  "bot/",
  "bot;",
  "bot)",
  "crawler",
  "spider",
  "scanner",
  "preview",
  "python",
  "curl",
  "wget",
  "java/",
  "okhttp",
  "go-http-client",
  "libwww",
  "headless",
  "barracuda",
  "proofpoint",
  "mimecast",
  "symantec",
  "messagelabs",
  "trendmicro",
  "ironport",
  "sophos",
  "fireeye",
  "zscaler",
  "forcepoint",
  "urldefense",
  "safelinks",
  "slackbot",
  "facebookexternalhit",
] as const;

/**
 * Chrome's user-agent reduction (from Chrome 107 on desktop, 110 on Android)
 * froze the minor.build.patch to 0.0.0: the full build now travels only in
 * client hints. A desktop Chrome user agent that still carries one is a
 * string copied from a fingerprint list, which is how security gateways'
 * link scanners present themselves. The margin above 107 covers the staged
 * rollout. Electron apps keep the full build and name themselves.
 */
const REDUCED_UA_FROM_MAJOR = 113;
const DESKTOP_PLATFORM = /\b(?:Windows NT|Macintosh|X11)\b/;
const CHROME_FULL_BUILD = /\bChrome\/(\d+)\.(\d+\.\d+\.\d+)\b/;

function isSpoofedDesktopChrome(userAgent: string): boolean {
  if (!DESKTOP_PLATFORM.test(userAgent) || userAgent.includes("Electron/")) return false;
  const match = CHROME_FULL_BUILD.exec(userAgent);
  if (!match) return false;
  return Number(match[1]) >= REDUCED_UA_FROM_MAJOR && match[2] !== "0.0.0";
}

export function classifyOpen(hit: {
  userAgent: string | null;
  at: Date;
  /**
   * What the fetch is measured against: the delivery when it has been
   * reported, else the send. Null when neither moment is known, which turns
   * the timing rules off for this fetch.
   */
  anchor: { at: Date; delivered: boolean } | null;
  /** Fetches closer than this to the anchor are prefetches; 0 disables the rule. */
  windowMs: number;
}): OpenVerdict {
  const userAgent = (hit.userAgent ?? "").trim();
  if (userAgent === APPLE_MPP_USER_AGENT) return { prefetched: true, reason: "apple_mpp" };
  if (GMAIL_PREFETCH_MARKERS.every((marker) => userAgent.includes(marker))) {
    return { prefetched: true, reason: "gmail_prefetch" };
  }
  const lower = userAgent.toLowerCase();
  if (userAgent === "" || SCANNER_TOKENS.some((token) => lower.includes(token))) {
    return { prefetched: true, reason: "scanner" };
  }
  if (isSpoofedDesktopChrome(userAgent)) return { prefetched: true, reason: "spoofed_ua" };
  if (hit.anchor) {
    const delta = hit.at.getTime() - hit.anchor.at.getTime();
    if (hit.anchor.delivered && delta < 0) return { prefetched: true, reason: "before_delivery" };
    if (hit.windowMs > 0 && delta < hit.windowMs) return { prefetched: true, reason: "timing" };
  }
  return { prefetched: false };
}
