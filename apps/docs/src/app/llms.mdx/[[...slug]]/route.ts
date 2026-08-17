import { notFound } from "next/navigation";
import { getLLMText } from "@/lib/get-llm-text";
import { source } from "@/lib/source";

export const revalidate = false;

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ slug?: string[] }> },
): Promise<Response> {
  const { slug = [] } = await ctx.params;
  // "/index.md" is the markdown URL of the root page (slugs []).
  const slugs = slug.length === 1 && slug[0] === "index" ? [] : slug;
  const page = source.getPage(slugs);
  if (!page) notFound();

  return new Response(await getLLMText(page), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}

export function generateStaticParams() {
  return source.generateParams();
}
