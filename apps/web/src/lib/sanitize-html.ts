/**
 * Defense-in-depth HTML sanitizer for the author paste / Custom-HTML / raw-code
 * path of the email editor. Authors are authenticated team members, so this is
 * a second line rather than the primary trust boundary: it removes executable
 * and document-metadata elements plus event-handler and javascript: attributes,
 * leaving the presentational markup email clients accept.
 *
 * ponytail: regex sanitizer, known ceiling — no real HTML parse, no CSS
 * expression()/url(javascript:) stripping, no SVG-vector coverage. If untrusted
 * authors ever reach this path, replace with a parser-based pass (DOMPurify).
 */

const PAIRED_WITH_CONTENT =
  /<(script|style|iframe|object|embed|form|noscript)\b[\s\S]*?<\/\1\s*>/gi;
const STRAY_UNSAFE_TAGS =
  /<\/?(script|style|iframe|object|embed|form|noscript|link|meta|base)\b[^>]*>/gi;
const EVENT_HANDLER_ATTRS = /\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const JS_URL_ATTRS =
  /\s(href|src|xlink:href|action|formaction)\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s>]+)/gi;

export function sanitizeHtml(html: string): string {
  return html
    .replace(PAIRED_WITH_CONTENT, "")
    .replace(STRAY_UNSAFE_TAGS, "")
    .replace(EVENT_HANDLER_ATTRS, "")
    .replace(JS_URL_ATTRS, "");
}
