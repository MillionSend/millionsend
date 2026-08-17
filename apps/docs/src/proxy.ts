import { createI18nMiddleware } from "fumadocs-core/i18n/middleware";
import { isMarkdownPreferred } from "fumadocs-core/negotiation";
import { type NextFetchEvent, type NextRequest, NextResponse } from "next/server";
import { i18n } from "@/lib/i18n";

// hideLocale "default-locale": English paths (/quickstart) are rewritten to
// /en/* internally; /en/* itself redirects to the unprefixed form; /pt-BR/*
// passes through.
const i18nMiddleware = createI18nMiddleware(i18n);

/**
 * Content negotiation runs first: a client whose Accept header prefers
 * text/markdown gets the page's markdown from the page URL itself — for both
 * locales, since the locale prefix is part of the pathname forwarded to
 * /llms.mdx. Explicit-extension URLs (.md, .txt, .json, assets) are left to
 * their own routes.
 */
export default function proxy(request: NextRequest, event: NextFetchEvent) {
  const { pathname } = request.nextUrl;
  if (pathname.includes(".")) return NextResponse.next();
  if (isMarkdownPreferred(request)) {
    const target = pathname === "/" ? "/llms.mdx/index" : `/llms.mdx${pathname}`;
    return NextResponse.rewrite(new URL(target, request.nextUrl), {
      // Two representations share one URL; caches must key on Accept.
      headers: { Vary: "Accept" },
    });
  }
  return i18nMiddleware(request, event);
}

export const config = {
  // "api/" (not "api") — /api-reference/* pages need the locale rewrite.
  matcher: ["/((?!_next|api/|llms.mdx).*)"],
};
