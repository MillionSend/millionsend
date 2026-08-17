import { source } from "@/lib/source";

// Origin comes from the incoming request so links stay correct on any
// deployment (docs.millionsend.com, a self-host, localhost) — never cached at
// build time.
export const dynamic = "force-dynamic";

export function GET(request: Request): Response {
  const origin = new URL(request.url).origin;
  const lines = source.getPages().map((page) => {
    const md = page.url === "/" ? "/index.md" : `${page.url}.md`;
    const description = page.data.description ? `: ${page.data.description}` : "";
    return `- [${page.data.title}](${origin}${md})${description}`;
  });

  const body = [
    "# MillionSend Docs",
    "",
    "> MillionSend is an open-source, self-hostable, Resend-compatible email platform that sends through your own AWS SES.",
    "",
    "Every page is available as raw markdown by appending `.md` to its URL.",
    `The full documentation in one file: ${origin}/llms-full.txt`,
    `The API's OpenAPI 3.1 spec (generated from code): ${origin}/openapi.json`,
    "",
    "## Pages",
    "",
    ...lines,
    "",
  ].join("\n");

  return new Response(body, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}
