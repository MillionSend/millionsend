/** True for a parseable absolute http: or https: URL. */
export function isHttpUrl(value: string): boolean {
  return httpOrigin(value) !== null;
}

/** Origin ("https://host[:port]") of an absolute http(s) URL, else null. */
export function httpOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * Whether a state-changing request was issued by a page on another origin.
 * Browsers attach Sec-Fetch-Site and Origin to every cross-origin non-GET
 * request and scripts cannot forge either, so this is the CSRF backstop
 * behind SameSite cookies. Same-origin navigations and non-browser callers
 * (no Origin) pass.
 */
export function isCrossOriginMutation(request: Request, origin: string): boolean {
  if (request.method === "GET" || request.method === "HEAD") return false;
  if (request.headers.get("sec-fetch-site") === "cross-site") return true;
  const from = request.headers.get("origin");
  return from !== null && from !== origin;
}
