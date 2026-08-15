/**
 * A post-auth redirect target taken from a query param, constrained to an
 * in-app path so a crafted `?next=` can never bounce a signed-in user to an
 * external origin. Protocol-relative "//host" and anything not starting with a
 * single "/" fall back to `fallback`.
 */
export function safeNextPath(next: string | null | undefined, fallback: string): string {
  return next?.startsWith("/") && !next.startsWith("//") ? next : fallback;
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
