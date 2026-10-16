export { escapeHtml } from "@millionsend/core/html";

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
 * Derive readable plain text from HTML: drop comments (Outlook's conditional
 * blocks included), the head, script and style outright, read the source's own
 * line breaks and indentation as plain spaces, keep link URLs as "text (url)",
 * end a block with a blank line and a list item or table row with a newline,
 * mark list items with "- ", strip the rest, decode entities and drop the
 * invisible padding exported emails carry. Merge tokens ({{{NAME}}}) are not
 * markup, so they pass through untouched.
 */
export function htmlToText(html: string): string {
  return (
    html
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<(head|script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(/\s+/g, " ")
      .replace(
        /<a\b[^>]*\bhref=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
        (_m, href: string, inner: string) => linkText(inner.replace(/<[^>]+>/g, ""), href),
      )
      .replace(/<br\s*\/?>/gi, "\n")
      // An editor wraps each list item's text in a paragraph: it ends with the item.
      .replace(/<\/p>\s*<\/li>/gi, "</li>")
      .replace(/<li\b[^>]*>/gi, "- ")
      .replace(/<\/(li|tr)>/gi, "\n")
      .replace(/<\/(p|div|h[1-6]|table|ul|ol|blockquote)>/gi, "\n\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#(\d+);|&#x([0-9a-f]+);/gi, (raw, dec?: string, hex?: string) =>
        numericEntity(dec === undefined ? Number.parseInt(hex ?? "", 16) : Number(dec), raw),
      )
      .replace(/&(zwnj|zwj|shy|lrm|rlm);/gi, "")
      // Ampersand last so `&amp;lt;` decodes to the literal `&lt;`, not `<`.
      .replace(/&amp;/gi, "&")
      // Soft hyphens, zero-width characters and the like: preheader padding.
      .replace(/[\u00ad\u200b-\u200f\u2060\ufeff]|\u034f/g, "")
      // Non-breaking and typographic spaces: button padding, for one.
      .replace(/[\u00a0\u2000-\u200a\u202f\u205f]/g, " ")
      .replace(/ {2,}/g, " ")
      .replace(/ ?\n ?/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/** A link as text: its label, then its URL unless that adds nothing. */
function linkText(label: string, href: string): string {
  return href === "" || href === "#" || label.trim() === href ? label : `${label} (${href})`;
}

/** The character a numeric entity names, or the entity as written when it names none. */
function numericEntity(code: number, raw: string): string {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : raw;
}

/**
 * The HTML with every class attribute removed: an editor's own classes mean
 * nothing in a sent email. Parsed with the DOM, so text that merely looks
 * like an attribute is left alone. Browser only.
 */
export function withoutClasses(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  for (const element of template.content.querySelectorAll("[class]")) {
    element.removeAttribute("class");
  }
  return template.innerHTML;
}
