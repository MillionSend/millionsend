import { notFound } from "next/navigation";
import { getLLMText } from "@/lib/get-llm-text";
import { i18n, isLocale } from "@/lib/i18n";
import { source } from "@/lib/source";

export const revalidate = false;

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ slug?: string[] }> },
): Promise<Response> {
  const { slug = [] } = await ctx.params;
  // Mirrors page URLs: /pt-BR/quickstart.md → ["pt-BR", "quickstart"]; the
  // default locale is unprefixed.
  const locale = isLocale(slug[0]) ? slug[0] : i18n.defaultLanguage;
  const rest = isLocale(slug[0]) ? slug.slice(1) : slug;
  // "/index.md" (or "/pt-BR.md" → []) is the markdown URL of the root page.
  const slugs = rest.length === 1 && rest[0] === "index" ? [] : rest;
  const page = source.getPage(slugs, locale);
  if (!page) notFound();

  return new Response(await getLLMText(page), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}

export function generateStaticParams() {
  return source.getLanguages().flatMap(({ language, pages }) =>
    pages.map((page) => ({
      slug:
        language === i18n.defaultLanguage
          ? page.slugs.length > 0
            ? page.slugs
            : ["index"]
          : [language, ...page.slugs],
    })),
  );
}
