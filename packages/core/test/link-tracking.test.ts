import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { rewriteForTracking } from "../src/link-tracking.js";
import { verifyClickToken, verifyOpenToken } from "../src/tracking.js";

const key = randomBytes(32);
const emailId = "b7f9c9a2-1234-4cde-9f00-0123456789ab";
const trackingBaseUrl = "https://track.example.com";
const html =
  '<html><body><p>Hi</p><a href="https://acme.example/welcome">Welcome</a>' +
  '<a href="https://acme.example/docs?x=1&amp;y=2">Docs</a></body></html>';

function opts(over: Partial<Parameters<typeof rewriteForTracking>[1]> = {}) {
  return { emailId, trackingBaseUrl, click: false, open: false, secretKey: key, ...over };
}

describe("rewriteForTracking — clean-links guarantee", () => {
  it("returns html byte-for-byte UNCHANGED when both tracking toggles are off", () => {
    // The whole point of app-layer tracking: a domain with tracking off ships
    // the raw link and no pixel. Any mutation here is a defect.
    expect(rewriteForTracking(html, opts({ click: false, open: false }))).toBe(html);
  });
});

describe("rewriteForTracking — click", () => {
  it("routes every http(s) anchor through the redirect endpoint with a verifiable token", () => {
    const out = rewriteForTracking(html, opts({ click: true }));
    const tokens = [...out.matchAll(/track\.example\.com\/t\/c\/([^"']+)/g)].map((m) => m[1]);
    expect(tokens).toHaveLength(2);
    expect(verifyClickToken(tokens[0] as string, key)).toEqual({
      emailId,
      url: "https://acme.example/welcome",
    });
    // The raw destination is gone from the body — the redirect owns it now.
    expect(out).not.toContain('href="https://acme.example/welcome"');
  });

  it("leaves mailto:, tel:, relative, and unexpanded {{{...}}} hrefs intact", () => {
    const src =
      '<a href="mailto:a@b.com">m</a><a href="tel:+15551234">t</a>' +
      '<a href="/relative">r</a><a href="{{{UNSUBSCRIBE_URL}}}">u</a>' +
      '<a href="https://x.example/{{{TOKEN}}}">templated</a>';
    const out = rewriteForTracking(src, opts({ click: true }));
    expect(out).toBe(src);
  });

  it("does not break a {{{UNSUBSCRIBE_URL}}} link while rewriting a real one beside it", () => {
    const src = '<a href="https://acme.example/go">go</a><a href="{{{UNSUBSCRIBE_URL}}}">unsub</a>';
    const out = rewriteForTracking(src, opts({ click: true }));
    expect(out).toContain('href="{{{UNSUBSCRIBE_URL}}}"');
    expect(out).toContain("/t/c/");
  });

  it("leaves an already-expanded unsubscribe link under skipHrefPrefix un-wrapped, still wrapping ordinary links", () => {
    // Broadcast path: {{{UNSUBSCRIBE_URL}}} was substituted to a real https URL
    // before encryption, so the {{{-token guard no longer covers it — the prefix
    // must exclude it from /t/c to avoid a bogus click and an extra redirect hop.
    const unsub = "https://app.example.com/unsubscribe/abc.def";
    const src = `<a href="https://acme.example/go">go</a><a href="${unsub}">unsub</a>`;
    const out = rewriteForTracking(
      src,
      opts({ click: true, skipHrefPrefix: "https://app.example.com/unsubscribe/" }),
    );
    expect(out).toContain(`href="${unsub}"`);
    expect(out).toContain("/t/c/"); // the ordinary link is still wrapped
    // The unsubscribe href never passes through the redirect.
    expect(out).not.toMatch(/t\/c\/[^"']*unsubscribe/);
  });
});

describe("rewriteForTracking — open pixel", () => {
  it("injects a hidden 1x1 pixel before </body> with a verifiable open token", () => {
    const out = rewriteForTracking(html, opts({ open: true }));
    const token = out.match(/t\/o\/([^"']+)/)?.[1];
    expect(token).toBeDefined();
    expect(verifyOpenToken(token as string, key)).toEqual({ emailId });
    expect(out).toMatch(/<img [^>]*style="display:none"[^>]*><\/body>/);
    // Anchors untouched when only open tracking is on.
    expect(out).toContain('href="https://acme.example/welcome"');
  });

  it("appends the pixel at the end when there is no </body>", () => {
    const out = rewriteForTracking("<p>no body tag</p>", opts({ open: true }));
    expect(out).toMatch(/<p>no body tag<\/p><img [^>]*\/t\/o\//);
  });

  it("normalizes a trailing slash on the tracking base (no double slash)", () => {
    const out = rewriteForTracking(
      "<p>x</p>",
      opts({ open: true, trackingBaseUrl: "https://t.example/" }),
    );
    expect(out).toContain("https://t.example/t/o/");
    expect(out).not.toContain("t.example//t/o/");
  });
});
