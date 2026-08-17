import { getLLMText } from "@/lib/get-llm-text";
import { source } from "@/lib/source";

export const revalidate = false;

export async function GET(): Promise<Response> {
  // Default locale (English) only — it is the source of truth; per-locale
  // markdown lives at the locale-prefixed .md URLs.
  const pages = await Promise.all(source.getPages().map(getLLMText));

  return new Response(pages.join("\n\n"), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}
