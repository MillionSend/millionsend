import { i18n } from "@/lib/i18n";
import { absoluteUrl } from "@/lib/site";
import { source } from "@/lib/source";

export const revalidate = false;

export function GET(): Response {
  // Serves the default locale (English — the source of truth) only. Agents
  // reach pt-BR pages via their locale-prefixed .md URLs (/pt-BR/<page>.md).
  const lines = source.getPages(i18n.defaultLanguage).map((page) => {
    const md = page.url === "/" ? "/index.md" : `${page.url}.md`;
    const description = page.data.description ? `: ${page.data.description}` : "";
    return `- [${page.data.title}](${absoluteUrl(md)})${description}`;
  });

  const body = [
    "# MillionSend Docs",
    "",
    "> MillionSend is an open-source, Resend-compatible email platform — hosted at millionsend.com (API: api.millionsend.com) or self-hosted on your own AWS SES.",
    "",
    "Every page is available as raw markdown by appending `.md` to its URL.",
    `The full documentation in one file: ${absoluteUrl("/llms-full.txt")}`,
    `The API's OpenAPI 3.1 spec (generated from code): ${absoluteUrl("/openapi.json")}`,
    `Moving an account from Resend: \`npx @millionsend/cli migrate --from resend\` (read-only against Resend; reference at ${absoluteUrl("/cli.md")}).`,
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
