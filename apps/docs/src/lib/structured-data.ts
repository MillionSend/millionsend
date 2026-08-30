import { getBreadcrumbItems } from "fumadocs-core/breadcrumb";
import type { InferPageType } from "fumadocs-core/source";
import { i18n } from "@/lib/i18n";
import { absoluteUrl, DOCS_ORIGIN } from "@/lib/site";
import { source } from "@/lib/source";

type DocsPage = InferPageType<typeof source>;

const WEBSITE = {
  "@type": "WebSite",
  name: "MillionSend Docs",
  url: DOCS_ORIGIN,
  inLanguage: i18n.languages,
};

const PUBLISHER = {
  "@type": "Organization",
  name: "MillionSend",
  url: "https://millionsend.com",
};

/** schema.org entities for a page: WebSite on the home, TechArticle + BreadcrumbList elsewhere. */
export function structuredData(page: DocsPage, lang: string): Record<string, unknown>[] {
  if (page.slugs.length === 0) return [{ "@context": "https://schema.org", ...WEBSITE }];

  // Folders only get a URL when they own an index page; url-less crumbs are
  // dropped because every list item but the last must resolve to a page.
  const home = source.getPage([], lang);
  const trail = [
    ...(home ? [{ name: home.data.title, url: home.url }] : []),
    ...getBreadcrumbItems(page.url, source.getPageTree(lang)).filter(
      (crumb): crumb is { name: string; url: string } =>
        typeof crumb.name === "string" && crumb.url !== undefined,
    ),
    { name: page.data.title, url: page.url },
  ];

  return [
    {
      "@context": "https://schema.org",
      "@type": "TechArticle",
      headline: page.data.title,
      description: page.data.description,
      inLanguage: lang,
      url: absoluteUrl(page.url),
      isPartOf: WEBSITE,
      publisher: PUBLISHER,
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: trail.map((crumb, index) => ({
        "@type": "ListItem",
        position: index + 1,
        name: crumb.name,
        item: absoluteUrl(crumb.url),
      })),
    },
  ];
}
