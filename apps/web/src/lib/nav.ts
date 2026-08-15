/**
 * A post-auth redirect target taken from a query param, constrained to an
 * in-app path so a crafted `?next=` can never bounce a signed-in user to an
 * external origin. Accepted only when it starts with a single "/" whose next
 * char is neither "/" nor "\": browsers treat both "//host" and "/\host" as
 * protocol-relative and would navigate off-site. Encoded forms (%2f, %5c) stay
 * literal in the path and never decode to a second leading slash, so they fall
 * through to `fallback` as ordinary non-matching paths.
 */
export function safeNextPath(next: string | null | undefined, fallback: string): string {
  return next?.startsWith("/") && !/^\/[/\\]/.test(next) ? next : fallback;
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
