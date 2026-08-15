import { escapeHtml, unescapeHtml } from "@/lib/html";
import { MERGE_TOKEN_RE, makeMergeToken } from "@/lib/merge-fields";

/**
 * Bridges the two representations of a merge field:
 *   - stored `block.html` holds the literal {{{NAME|fallback}}} token
 *   - the tiptap editor holds a <span data-merge-field> the MergeField node
 *     parses into an inline chip
 * These pure transforms convert between them so tokens survive the editor
 * round-trip byte-for-byte (the transforms mirror the node's parseHTML /
 * renderHTML, and are what the round-trip test exercises). `unwrapParagraph`
 * keeps heading blocks storing inline-only html the serializer can drop inside
 * an <h*> tag.
 */

const NAME_ATTR = "data-merge-field";
const FALLBACK_ATTR = "data-merge-fallback";

/** tokens in author/stored html → parseable spans for setContent(). */
export function tokensToMergeSpans(html: string): string {
  return html.replace(MERGE_TOKEN_RE, (_m, name: string, fallback?: string) => {
    const fb =
      fallback != null && fallback !== "" ? ` ${FALLBACK_ATTR}="${escapeHtml(fallback)}"` : "";
    return `<span ${NAME_ATTR}="${escapeHtml(name)}"${fb}></span>`;
  });
}

const EMPTY_SPAN_RE = /<span\b([^>]*)><\/span>/gi;
const NAME_IN_ATTRS = new RegExp(`${NAME_ATTR}="([^"]*)"`, "i");
const FALLBACK_IN_ATTRS = new RegExp(`${FALLBACK_ATTR}="([^"]*)"`, "i");

/** editor getHTML() merge spans → literal tokens for storage; other spans kept. */
export function mergeSpansToTokens(html: string): string {
  return html.replace(EMPTY_SPAN_RE, (whole, attrs: string) => {
    const name = NAME_IN_ATTRS.exec(attrs);
    if (!name) return whole;
    const fallback = FALLBACK_IN_ATTRS.exec(attrs);
    return makeMergeToken(
      unescapeHtml(name[1] as string),
      fallback ? unescapeHtml(fallback[1] as string) : undefined,
    );
  });
}

/** Strip a single wrapping <p> so heading html stays inline-only. */
export function unwrapParagraph(html: string): string {
  const match = /^<p[^>]*>((?:(?!<\/?p\b)[\s\S])*)<\/p>$/i.exec(html.trim());
  return match ? (match[1] as string) : html;
}

export { FALLBACK_ATTR as MERGE_FALLBACK_ATTR, NAME_ATTR as MERGE_NAME_ATTR };
