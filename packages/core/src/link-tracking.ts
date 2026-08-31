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

// ponytail: naive attribute regex — a quoted `>` inside an <a> tag would fool
// it, but that does not occur in real email HTML. Upgrade to a parser only if a
// broken template surfaces it. Shared with email-insights so both sides see
// the exact same set of anchors.
export const ANCHOR_HREF = /(<a\b[^>]*?\shref=)(["'])(.*?)\2/gi;

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
    out = out.replace(ANCHOR_HREF, (match, prefix: string, quote: string, url: string) => {
      if (!isTrackableHref(url)) return match;
      if (opts.skipHrefPrefix && url.startsWith(opts.skipHrefPrefix)) return match;
      const token = makeClickToken({ emailId: opts.emailId, url, secretKey: opts.secretKey });
      return `${prefix}${quote}${base}/t/c/${token}${quote}`;
    });
  }

  if (opts.open) {
    const token = makeOpenToken({ emailId: opts.emailId, secretKey: opts.secretKey });
    const pixel = `<img src="${base}/t/o/${token}" width="1" height="1" alt="" style="display:none">`;
    const closing = out.search(/<\/body>/i);
    out = closing === -1 ? out + pixel : out.slice(0, closing) + pixel + out.slice(closing);
  }

  return out;
}
