import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/layouts/docs/page";
import { createRelativeLink } from "fumadocs-ui/mdx";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { OpenAPIPage } from "@/components/api-page";
import { getMDXComponents } from "@/components/mdx";
import { openapi } from "@/lib/openapi";
import { absoluteUrl, ogImagePath, pageAlternates } from "@/lib/site";
import { source } from "@/lib/source";
import { structuredData } from "@/lib/structured-data";

interface PageParams {
  params: Promise<{ lang: string; slug?: string[] }>;
}

export default async function Page(props: PageParams) {
  const { lang, slug } = await props.params;
  const page = source.getPage(slug, lang);
  if (!page) notFound();

  const MDX = page.data.body;
  // "<" is escaped so no title or description can close the script element.
  const jsonLd = JSON.stringify(structuredData(page, lang)).replace(/</g, "\\u003c");

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD built from our own frontmatter, escaped above */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} />
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <MDX
          components={getMDXComponents({
            a: createRelativeLink(source, page),
            OpenAPIPage: async (props) => (
              <OpenAPIPage {...(await openapi.preloadOpenAPIPage(page))} {...props} />
            ),
          })}
        />
      </DocsBody>
    </DocsPage>
  );
}

export async function generateStaticParams() {
  return source.generateParams();
}

// Unknown slugs 404 statically; on-demand rendering would try to persist the
// 404 into .next, which fails on a read-only rootfs.
export const dynamicParams = false;

export async function generateMetadata(props: PageParams): Promise<Metadata> {
  const { lang, slug } = await props.params;
  const page = source.getPage(slug, lang);
  if (!page) notFound();

  return {
    title: page.data.title,
    description: page.data.description,
    alternates: pageAlternates(page),
    // Page-level openGraph replaces the layout's wholesale, so the image
    // rides along here or vanishes from article pages.
    openGraph: {
      siteName: "MillionSend Docs",
      type: "article",
      locale: lang === "pt-BR" ? "pt_BR" : "en_US",
      url: absoluteUrl(page.url),
      title: page.data.title,
      description: page.data.description,
      images: ogImagePath(page),
    },
  };
}
