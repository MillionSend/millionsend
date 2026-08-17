import type { InferPageType } from "fumadocs-core/source";
import type { source } from "@/lib/source";

/**
 * Markdown rendition of a page for agents (*.md routes and /llms-full.txt).
 * API reference pages are generated MDX whose body is just a component call,
 * so they get a pointer to the machine-readable spec instead of empty prose.
 */
export async function getLLMText(page: InferPageType<typeof source>): Promise<string> {
  const header = `# ${page.data.title} (${page.url})`;
  const description = page.data.description ? `\n\n${page.data.description}` : "";

  // includes(): the URL carries a locale prefix on non-default locales.
  if (page.url.includes("/api-reference/endpoints")) {
    return `${header}${description}\n\nThis page documents a MillionSend API operation. The full machine-readable spec is at /openapi.json (OpenAPI 3.1, generated from the server code).`;
  }

  const processed = await page.data.getText("processed");
  return `${header}${description}\n\n${processed.trimStart()}`;
}
