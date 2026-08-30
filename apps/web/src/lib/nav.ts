/**
 * A post-auth redirect target taken from a query param, constrained to an
 * in-app path so a crafted `?next=` can never bounce a signed-in user to an
 * external origin. The check is parse-based rather than a prefix test: the
 * URL parser strips ASCII tab/newline and treats "\" as "/", so "/\t//host"
 * or "/\host" would otherwise pass a "single leading slash" test and still
 * navigate off-site. Control characters are rejected outright; anything else
 * must resolve to the same origin, and the normalized path is returned.
 * Encoded forms (%2f, %5c) stay literal in the path and never decode to a
 * second leading slash, so they are ordinary same-origin paths.
 */
export function safeNextPath(next: string | null | undefined, fallback: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the control range is exactly what must be rejected
  if (!next?.startsWith("/") || /[\u0000-\u001f\u007f]/.test(next)) return fallback;
  const base = "http://next.invalid";
  let url: URL;
  try {
    url = new URL(next, base);
  } catch {
    return fallback;
  }
  if (url.origin !== base) return fallback;
  return url.pathname + url.search + url.hash;
}

/** True when `pathname` is `href` or nested under it ("/emails/123" → "/emails"). */
export function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * The longest href in `hrefs` that `pathname` is active under, or undefined.
 * Longest wins so nested section hrefs (/audience/segments) beat their parent
 * (/audience) instead of both lighting up.
 */
export function pickActive(pathname: string, hrefs: readonly string[]): string | undefined {
  return hrefs.filter((href) => isActive(pathname, href)).sort((a, b) => b.length - a.length)[0];
}
