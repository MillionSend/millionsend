/**
 * True when the URL's host can only be reached from its own machine.
 * Mirrored client-side at apps/web/src/lib/url.ts — restated there because
 * this package's entry point is server-only.
 */
export function isLoopbackUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return (
      host === "localhost" ||
      host === "::1" ||
      host === "[::1]" ||
      host.startsWith("127.") ||
      host.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}

/**
 * A Postgres URL as node-postgres must receive it to read `sslmode` the way
 * libpq and postgres.js do: without `uselibpqcompat=true` it verifies the
 * certificate on `prefer` and `require` too. `verify-ca` is left as written,
 * since node-postgres's libpq mode refuses it without an `sslrootcert`. A
 * repeated `sslmode` counts by its last value, as in both drivers.
 * Never hand the result to postgres.js: it passes unknown parameters on to
 * the server, which rejects them.
 */
export function withLibpqSslmode(databaseUrl: string): string {
  const params = URL.parse(databaseUrl)?.searchParams;
  const mode = params?.getAll("sslmode").at(-1);
  return (mode === "require" || mode === "prefer") && !params?.has("uselibpqcompat")
    ? `${databaseUrl}&uselibpqcompat=true`
    : databaseUrl;
}

/** Proofpoint URL Defense v3 runs: "**A" stands for 2 hidden characters, "**B" for 3, and so on. */
const PROOFPOINT_RUNS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Google's own hosts: google.com and its country domains, never a name that merely starts with google. */
const GOOGLE_HOST = /^(?:www\.)?google\.(?:com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/;

/** Wrappers that carry the destination in a query parameter, by exact host. */
const QUERY_WRAPPERS = new Map<string, { path?: RegExp; params: string[] }>([
  ["l.facebook.com", { path: /^\/l\.php$/, params: ["u"] }],
  ["lm.facebook.com", { path: /^\/l\.php$/, params: ["u"] }],
  ["l.messenger.com", { path: /^\/l\.php$/, params: ["u"] }],
  ["l.instagram.com", { params: ["u"] }],
  ["www.youtube.com", { path: /^\/redirect$/, params: ["q"] }],
  ["youtube.com", { path: /^\/redirect$/, params: ["q"] }],
  ["m.youtube.com", { path: /^\/redirect$/, params: ["q"] }],
  ["out.reddit.com", { params: ["url"] }],
  ["www.linkedin.com", { path: /^\/(?:redir\/redirect|safety\/go)\/?$/, params: ["url"] }],
  ["linkedin.com", { path: /^\/(?:redir\/redirect|safety\/go)\/?$/, params: ["url"] }],
  ["slack-redir.net", { path: /^\/link$/, params: ["url"] }],
  ["vk.com", { path: /^\/away\.php$/, params: ["to"] }],
  ["m.vk.com", { path: /^\/away\.php$/, params: ["to"] }],
  ["steamcommunity.com", { path: /^\/linkfilter\/?$/, params: ["url", "u"] }],
  ["duckduckgo.com", { path: /^\/l\/?$/, params: ["uddg"] }],
  ["linkprotect.cudasvc.com", { path: /^\/url$/, params: ["a"] }],
]);

function decodePercent(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

function proofpoint(href: string, url: URL): string | null {
  const version = /^\/v(\d)\//.exec(url.pathname)?.[1];
  if (version === "1") return url.searchParams.get("u");
  if (version === "2") {
    const u = url.searchParams.get("u");
    return u === null ? null : decodePercent(u.replaceAll("-", "%").replaceAll("_", "/"));
  }
  if (version !== "3") return null;
  // v3 keeps the URL in the path, each character it could not carry there
  // swapped for "*" and kept, base64url, between "__;" and "!". Found with
  // indexOf: a /__(.+?)__;([^!]*)!/ pattern backtracks quadratically on a
  // long href with "__;" and no "!".
  const start = href.indexOf("/v3/__");
  const mid = start < 0 ? -1 : href.indexOf("__;", start + 7);
  const bang = mid < 0 ? -1 : href.indexOf("!", mid + 3);
  if (bang < 0) return null;
  const path = href.slice(start + 6, mid);
  const encoded = decodePercent(path) ?? path;
  const hidden = [...Buffer.from(href.slice(mid + 3, bang), "base64url").toString("utf8")];
  let next = 0;
  return encoded.replace(/\*(\*.)?/g, (_, run: string | undefined) => {
    const n = run ? PROOFPOINT_RUNS.indexOf(run[1] as string) + 2 : 1;
    const chars = hidden.slice(next, next + n).join("");
    next += n;
    return chars;
  });
}

function wrappedTarget(href: string, url: URL): string | null {
  const host = url.hostname;
  const param = (names: string[]) => {
    for (const name of names) {
      const value = url.searchParams.get(name);
      if (value) return value;
    }
    return null;
  };
  if (GOOGLE_HOST.test(host)) {
    if (url.pathname === "/url") return param(["q", "url"]);
    // The AMP viewer: /amp/s/<host>/<path> for https, /amp/<host>/<path> for http.
    const amp = /^\/amp\/(s\/)?(.+)$/.exec(url.pathname);
    return amp ? `${amp[1] ? "https" : "http"}://${amp[2]}${url.search}` : null;
  }
  if (host.endsWith(".safelinks.protection.outlook.com")) return param(["url"]);
  if (host === "urldefense.proofpoint.com" || host === "urldefense.com")
    return proofpoint(href, url);
  // Mimecast names only the destination's domain.
  if (/^protect(?:-[a-z0-9]+)?\.mimecast\.com$/.test(host)) {
    const domain = url.searchParams.get("domain");
    return domain && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain) ? `https://${domain}/` : null;
  }
  const wrapper = QUERY_WRAPPERS.get(host);
  return wrapper && (!wrapper.path || wrapper.path.test(url.pathname))
    ? param(wrapper.params)
    : null;
}

/**
 * The destination a well-known redirect wrapper (Google's /url, Facebook's
 * l.php, Outlook Safe Links, Proofpoint URL Defense and the like) carries in
 * its own URL: decoded one level, never visited, so a single-use link is
 * never spent. A destination written relative to the wrapper (//host/path)
 * resolves against it, as its redirect would. Any other URL, or a wrapper
 * whose destination is no http(s) URL, comes back as written. Hosts match
 * exactly: on any other host the parameters say nothing about where the
 * link goes.
 */
export function unwrapRedirect(href: string): string {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return href;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return href;
  const target = wrappedTarget(href, url);
  if (!target) return href;
  try {
    const out = new URL(target, url);
    return out.protocol === "https:" || out.protocol === "http:" ? out.href : href;
  } catch {
    return href;
  }
}
