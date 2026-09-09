/** Escape a string for safe interpolation into HTML text or a "-quoted attribute. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Inverse of escapeHtml, plus the numeric references other escapers emit
 * (Handlebars writes `=` as `&#x3D;`, React `'` as `&#x27;`). Ampersand
 * last so `&amp;lt;` decodes to the literal `&lt;`, not `<`.
 */
export function unescapeHtml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");
}

/**
 * Wordmark for system emails, hosted by the product site rather than the
 * instance: most self-hosted deployments sit on private or loopback hosts
 * that recipients' mail clients cannot fetch from.
 */
export const EMAIL_WORDMARK_URL = "https://millionsend.com/email/wordmark.png";
