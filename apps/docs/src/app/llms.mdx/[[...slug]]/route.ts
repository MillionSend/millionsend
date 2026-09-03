import { readFile } from "node:fs/promises";
import { notFound } from "next/navigation";
import { getLLMText } from "@/lib/get-llm-text";
import { i18n, isLocale } from "@/lib/i18n";
import { absoluteUrl } from "@/lib/site";
import { source } from "@/lib/source";

export const revalidate = false;

/** Agent prompts under content/prompts, one file per locale (`<name>.md`, `<name>.pt-BR.md`). */
const PROMPTS = ["migrate-from-resend"] as const;

async function promptText(name: string, locale: string): Promise<string | null> {
  if (!(PROMPTS as readonly string[]).includes(name)) return null;
  const suffix = locale === i18n.defaultLanguage ? "" : `.${locale}`;
  // cwd-relative like the rest of the docs build (apps/docs).
  return readFile(`./content/prompts/${name}${suffix}.md`, "utf8").catch(() => null);
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ slug?: string[] }> },
): Promise<Response> {
  const { slug = [] } = await ctx.params;
  // Mirrors page URLs: /pt-BR/quickstart.md → ["pt-BR", "quickstart"]; the
  // default locale is unprefixed.
  const locale = isLocale(slug[0]) ? slug[0] : i18n.defaultLanguage;
  const rest = isLocale(slug[0]) ? slug.slice(1) : slug;
  if (rest[0] === "prompts" && rest.length === 2) {
    const prompt = await promptText(rest[1] ?? "", locale);
    if (prompt === null) notFound();
    return new Response(prompt, {
      headers: { "Content-Type": "text/markdown; charset=utf-8" },
    });
  }
  // "/index.md" (or "/pt-BR.md" → []) is the markdown URL of the root page.
  const slugs = rest.length === 1 && rest[0] === "index" ? [] : rest;
  const page = source.getPage(slugs, locale);
  if (!page) notFound();

  return new Response(await getLLMText(page), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      // The markdown rendition is the HTML page's duplicate for search engines.
      Link: `<${absoluteUrl(page.url)}>; rel="canonical"`,
    },
  });
}

export function generateStaticParams() {
  const prefix = (language: string) => (language === i18n.defaultLanguage ? [] : [language]);
  return source.getLanguages().flatMap(({ language, pages }) => [
    ...pages.map((page) => ({
      slug:
        language === i18n.defaultLanguage
          ? page.slugs.length > 0
            ? page.slugs
            : ["index"]
          : [language, ...page.slugs],
    })),
    ...PROMPTS.map((name) => ({ slug: [...prefix(language), "prompts", name] })),
  ]);
}
