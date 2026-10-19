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
 * An http(s) redirect URI's origin, or any other URI as the URL parser
 * serializes it: percent-encoded, so the invisible, bidi and look-alike
 * characters a registrant can put in a custom-scheme URI show as escapes.
 */
export function redirectTarget(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : url.href;
  } catch {
    return value;
  }
}

/**
 * Custom schemes whose OAuth redirect URIs may carry a host, as Cursor's
 * cursor://anysphere.cursor-mcp/oauth/callback does. The provider accepts
 * any such scheme (smb://, search-ms://, intent://…) and redirects to a
 * registered URI on some errors before anyone signs in, so open registration
 * would let a link to this origin launch that scheme's local handler.
 */
const HOST_REDIRECT_SCHEMES = new Set(["cursor:"]);

/** A non-http(s) URI that carries a host, under a scheme not listed above. */
export function isUnlistedHostRedirect(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol !== "http:" &&
      url.protocol !== "https:" &&
      url.host !== "" &&
      !HOST_REDIRECT_SCHEMES.has(url.protocol)
    );
  } catch {
    return false;
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
