import { unescapeHtml } from "./html.js";
import { scanHtml } from "./links.js";
import { makeClickToken, makeOpenToken } from "./tracking.js";

/**
 * Rewrites an outgoing HTML body for app-layer engagement tracking. When both
 * toggles are off the html is returned byte-for-byte unchanged — a domain with
 * tracking disabled ships the raw links and no pixel, which is the whole point
 * of owning tracking ourselves instead of letting SES rewrite the mail.
 *
 * With click on, every anchor pointing at an http(s) URL is routed through our
 * redirect endpoint carrying a signed click token; with open on, a 1x1 pixel
 * pointing at our open endpoint is appended before </body>.
 */
export interface RewriteOptions {
  emailId: string;
  /** The sending team, signed into every click token. */
  teamId: string;
  /** Origin of the tracking endpoints (app host or the domain's CNAME'd subdomain). */
  trackingBaseUrl: string;
  click: boolean;
  open: boolean;
  secretKey: Buffer;
  /**
   * Any href equal to or under this prefix is left un-wrapped by click
   * tracking. For broadcasts the in-body unsubscribe link is already expanded
   * to its real URL before encryption (the {{{-token guard no longer applies),
   * so wrapping it through /t/c would record a bogus click and add a hop —
   * pass the `/unsubscribe/` prefix to exclude it.
   */
  skipHrefPrefix?: string;
}

/**
 * Only sign absolute http(s) destinations. mailto:/tel:/relative links have no
 * redirect to protect, and an href still holding an unexpanded mustache token
 * ({{{UNSUBSCRIBE_URL}}} and friends) must pass through untouched — signing the
 * literal template string would break the link once merged.
 */
function isTrackableHref(url: string): boolean {
  return /^https?:\/\//i.test(url) && !url.includes("{{{");
}

export function rewriteForTracking(html: string, opts: RewriteOptions): string {
  if (!opts.click && !opts.open) return html;

  const base = opts.trackingBaseUrl.replace(/\/$/, "");
  let out = html;

  if (opts.click) {
    // Only the href of a real <a> or <area>, found as the browser finds it:
    // never a form's action, and never a look-alike inside another
    // attribute's quotes. Each value is swapped in place, so the rest of the
    // markup stays byte for byte.
    const parts: string[] = [];
    let cursor = 0;
    scanHtml(html, {
      tag(tag) {
        if (tag.closing || (tag.name !== "a" && tag.name !== "area")) return;
        const href = tag.attrs.find((attr) => attr.name === "href");
        if (!href || href.start === -1) return;
        // The attribute is HTML: "&amp;" between query parameters is one "&" to
        // the browser, and the redirect must follow the URL the browser would.
        const url = unescapeHtml(href.value);
        if (!isTrackableHref(url)) return;
        if (opts.skipHrefPrefix && url.startsWith(opts.skipHrefPrefix)) return;
        const token = makeClickToken({
          emailId: opts.emailId,
          teamId: opts.teamId,
          url,
          secretKey: opts.secretKey,
        });
        const q = href.quote || '"';
        parts.push(html.slice(cursor, href.start), `${q}${base}/t/c/${token}${q}`);
        cursor = href.end;
      },
    });
    if (cursor > 0) out = parts.join("") + html.slice(cursor);
  }

  if (opts.open) {
    const token = makeOpenToken({ emailId: opts.emailId, secretKey: opts.secretKey });
    const pixel = `<img src="${base}/t/o/${token}" width="1" height="1" alt="" style="display:none">`;
    const closing = out.search(/<\/body>/i);
    out = closing === -1 ? out + pixel : out.slice(0, closing) + pixel + out.slice(closing);
  }

  return out;
}
