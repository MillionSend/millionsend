/** True when `pathname` is `href` or nested under it ("/emails/123" → "/emails"). */
export function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
