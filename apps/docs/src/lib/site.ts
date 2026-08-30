import type { InferPageType } from "fumadocs-core/source";
import type { Metadata } from "next";
import { i18n } from "@/lib/i18n";
import { source } from "@/lib/source";

type DocsPage = InferPageType<typeof source>;

// Every absolute URL (metadata, sitemap, llms.txt) derives from this rather
// than the incoming request: the production proxy forwards Host as
// localhost:<port>, so request.url would leak that into public links.
export const DOCS_ORIGIN = "https://docs.millionsend.com";

export function absoluteUrl(path: string): string {
  return new URL(path, DOCS_ORIGIN).href;
}

/**
 * A non-default-locale route without a translated file serves the default
 * locale's content (loader fallback) and its file path carries no locale
 * marker. Such routes are duplicates for search engines: they canonicalise to
 * the original and stay out of the sitemap and hreflang sets.
 */
export function isTranslated(page: DocsPage): boolean {
  const locale = page.locale ?? i18n.defaultLanguage;
  return locale === i18n.defaultLanguage || page.path.includes(`.${locale}.`);
}

/** Translated versions of a page, keyed by locale, as absolute URLs. */
export function translations(page: DocsPage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const lang of i18n.languages) {
    const variant = source.getPage(page.slugs, lang);
    if (variant && isTranslated(variant)) out[lang] = absoluteUrl(variant.url);
  }
  return out;
}

export function pageAlternates(page: DocsPage): NonNullable<Metadata["alternates"]> {
  const languages = translations(page);
  const original = languages[i18n.defaultLanguage] ?? absoluteUrl(page.url);
  return {
    canonical: isTranslated(page) ? absoluteUrl(page.url) : original,
    languages: { ...languages, "x-default": original },
  };
}

export function ogImagePath(page: DocsPage): string {
  return `/og/${page.locale ?? i18n.defaultLanguage}/${[...page.slugs, "image.png"].join("/")}`;
}
