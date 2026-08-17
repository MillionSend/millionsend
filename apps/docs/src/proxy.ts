import { isMarkdownPreferred } from "fumadocs-core/negotiation";
import { type NextRequest, NextResponse } from "next/server";

/**
 * Content negotiation: a client whose Accept header prefers text/markdown gets
 * the page's markdown from the page URL itself. Explicit-extension URLs
 * (.md, .txt, .json, assets) are left to their own routes.
 */
export default function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  if (pathname.includes(".") || !isMarkdownPreferred(request)) {
    return NextResponse.next();
  }
  const target = pathname === "/" ? "/llms.mdx/index" : `/llms.mdx${pathname}`;
  return NextResponse.rewrite(new URL(target, request.nextUrl), {
    // Two representations share one URL; caches must key on Accept.
    headers: { Vary: "Accept" },
  });
}

export const config = {
  matcher: ["/((?!_next|api|llms.mdx).*)"],
};
