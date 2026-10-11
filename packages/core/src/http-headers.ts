/**
 * A `Content-Disposition: attachment` value naming `filename` both ways RFC
 * 6266 allows: an ASCII fallback with quotes, backslashes and everything
 * non-printable replaced, and the UTF-8 `filename*` browsers prefer. The
 * name may come from a stranger's email, so nothing in it reaches the header
 * unencoded.
 */
export function attachmentDisposition(filename: string): string {
  // Lone surrogates would make encodeURIComponent throw.
  const wellFormed = filename.replace(/\p{Cs}/gu, "\uFFFD");
  const ascii = wellFormed.replace(/[^\x20-\x7e]|["\\]/g, "_");
  // encodeURIComponent leaves these four as is; RFC 8187 attr-char does not allow them.
  const encoded = encodeURIComponent(wellFormed).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
