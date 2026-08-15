import DOMPurify from "isomorphic-dompurify";

/**
 * HTML sanitizer for the author paste / Custom-HTML / raw-code path of the email
 * editor. A real HTML parse (DOMPurify over a DOM) rather than regex, so
 * attribute-boundary tricks (`<img/onerror=x src=y>`, `<img src="x"/onerror=x>`,
 * `<a/href=javascript:...>`) cannot smuggle handlers or js:/data: URLs past it.
 * Output is rendered via dangerouslySetInnerHTML and emitted into email HTML, so
 * it must survive SSR: isomorphic-dompurify supplies a DOM on the server too.
 *
 * The allowlist is the presentational + table markup email clients accept; svg,
 * math, script/style/iframe and unknown tags are dropped by exclusion, and
 * DOMPurify strips event handlers, javascript:/data: URLs, and unsafe style
 * declarations. Merge tokens ({{{NAME}}}) are plain text and pass through.
 */

const ALLOWED_TAGS = [
  "a",
  "b",
  "strong",
  "i",
  "em",
  "u",
  "s",
  "strike",
  "span",
  "p",
  "br",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "blockquote",
  "pre",
  "code",
  "small",
  "sub",
  "sup",
  "hr",
  "center",
  "font",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
  "caption",
  "colgroup",
  "col",
  "img",
];

const ALLOWED_ATTR = [
  "href",
  "src",
  "alt",
  "title",
  "width",
  "height",
  "align",
  "valign",
  "border",
  "cellpadding",
  "cellspacing",
  "colspan",
  "rowspan",
  "style",
  "bgcolor",
  "color",
  "target",
  "role",
  "dir",
  "face",
  "size",
];

export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR });
}
