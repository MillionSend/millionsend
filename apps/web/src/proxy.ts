import { env } from "@millionsend/config";
import { type NextRequest, NextResponse } from "next/server";

/** Paths the hosted unsubscribe flow needs; nothing else answers on its host. */
const UNSUBSCRIBE_HOST_PATHS = ["/unsubscribe/", "/logo/", "/_next/", "/favicon.ico"];

/**
 * The hosted unsubscribe pages may live on their own host (UNSUBSCRIBE_BASE_URL)
 * so recipients and link scanners never touch the dashboard's origin. That
 * host then answers the unsubscribe flow and its assets only: the dashboard,
 * the auth pages and everything else 404 there. The dashboard's own host
 * keeps serving the flow too — links in mail already sent point at it.
 */
export function proxy(request: NextRequest): NextResponse {
  const own = env.UNSUBSCRIBE_BASE_URL;
  if (!own) return NextResponse.next();
  const host = request.headers.get("host")?.toLowerCase();
  if (host !== new URL(own).host.toLowerCase()) return NextResponse.next();
  const { pathname } = request.nextUrl;
  if (UNSUBSCRIBE_HOST_PATHS.some((prefix) => pathname === prefix || pathname.startsWith(prefix))) {
    return NextResponse.next();
  }
  return new NextResponse(null, { status: 404 });
}
