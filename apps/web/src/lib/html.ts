/** Escape a string for safe interpolation into HTML text or a "-quoted attribute. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Inverse of escapeHtml: decode the five entities it emits. Ampersand last so
 * `&amp;lt;` decodes to the literal `&lt;`, not `<`. */
export function unescapeHtml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
/* Content that must not be re-flowed: verbatim between open and close tag. */
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "pre", "textarea"]);
/* One token per comment, declaration, tag (quoted attributes may hold ">"), text run, or stray "<". */
const HTML_TOKEN = /<!--[\s\S]*?-->|<![^>]*>|<\/?[A-Za-z](?:"[^"]*"|'[^']*'|[^'">])*>|[^<]+|</g;

/**
 * Indent HTML for reading — one tag or text run per line, nested by depth.
 * Display only: it re-flows whitespace between inline elements and trusts
 * that tags close, so a rendering must always come from the original source.
 */
export function formatHtml(html: string, indent = "  "): string {
  const lines: string[] = [];
  let depth = 0;
  let raw: string | null = null;
  let rawBuffer = "";
  for (const token of html.match(HTML_TOKEN) ?? []) {
    if (raw) {
      const close = /^<\/([A-Za-z][\w-]*)/.exec(token);
      if (close?.[1]?.toLowerCase() === raw) {
        const body = rawBuffer.replace(/^\n+|\s+$/g, "");
        if (body) lines.push(body);
        depth = Math.max(0, depth - 1);
        lines.push(indent.repeat(depth) + token);
        raw = null;
      } else {
        rawBuffer += token;
      }
      continue;
    }
    if (!token.startsWith("<")) {
      const text = token.replace(/\s+/g, " ").trim();
      if (text) lines.push(indent.repeat(depth) + text);
      continue;
    }
    if (token.startsWith("</")) {
      depth = Math.max(0, depth - 1);
      lines.push(indent.repeat(depth) + token);
      continue;
    }
    lines.push(indent.repeat(depth) + token.trim());
    const name = /^<([A-Za-z][\w-]*)/.exec(token)?.[1]?.toLowerCase();
    if (!name || VOID_ELEMENTS.has(name) || token.endsWith("/>")) continue;
    depth++;
    if (RAW_TEXT_ELEMENTS.has(name)) {
      raw = name;
      rawBuffer = "";
    }
  }
  return lines.join("\n");
}

/**
 * Derive readable plain text from HTML: drop script/style outright, keep link
 * URLs as "text (url)", turn block boundaries into newlines, strip the rest,
 * and decode the basic entities. Merge tokens ({{{NAME}}}) are not markup, so
 * they pass through untouched.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(
      /<a\b[^>]*\bhref=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
      (_m, href: string, inner: string) => `${inner.replace(/<[^>]+>/g, "")} (${href})`,
    )
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|table)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
