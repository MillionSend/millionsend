// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  DARK_CLIENT_SIM,
  emulateEmailScheme,
  linkDestination,
  lockDownReceivedHtml,
  prepareReceivedHtml,
  withoutTrailingQuote,
} from "./email-preview";

describe("emulateEmailScheme", () => {
  const html =
    "<style>@media screen and (prefers-color-scheme: dark){body{background:#000}} @media (prefers-color-scheme: light){body{color:#111}}</style><p>hi</p>";

  it("switches the message's own dark rules on and its light rules off for a dark client", () => {
    const out = emulateEmailScheme(html, "dark");
    expect(out).toContain("@media screen and (min-width: 0px){body{background:#000}}");
    expect(out).toContain("@media (min-width: 999999px){body{color:#111}}");
    expect(out).toContain("color-scheme:dark");
    // The message handles dark itself; no auto-darkening on top.
    expect(out).not.toContain(DARK_CLIENT_SIM);
  });

  it("does the reverse for a light client", () => {
    const out = emulateEmailScheme(html, "light");
    expect(out).toContain("@media screen and (min-width: 999999px){body{background:#000}}");
    expect(out).toContain("@media (min-width: 0px){body{color:#111}}");
    expect(out).toContain("color-scheme:light");
  });

  it("auto-darkens a message with no dark treatment of its own, and only then", () => {
    expect(emulateEmailScheme("<p>plain</p>", "dark")).toContain(DARK_CLIENT_SIM);
    expect(emulateEmailScheme("<p>plain</p>", "light")).not.toContain(DARK_CLIENT_SIM);
    expect(
      emulateEmailScheme(
        '<meta name="supported-color-schemes" content="light dark"><p>x</p>',
        "dark",
      ),
    ).not.toContain(DARK_CLIENT_SIM);
  });
});

describe("lockDownReceivedHtml", () => {
  const POLICY = '<meta http-equiv="Content-Security-Policy"';

  it("puts a no-network policy ahead of everything a stranger wrote", () => {
    const doc = lockDownReceivedHtml(
      '<html><head><link rel="stylesheet" href="https://x.example/a.css"></head></html>',
    );
    expect(doc.startsWith(POLICY)).toBe(true);
    expect(doc).toContain("default-src 'none'; img-src data:; style-src 'unsafe-inline'");
    expect(doc).toContain('<meta name="referrer" content="no-referrer">');
  });

  it("lets images, and only images, come from the network once the reader asks", () => {
    const doc = lockDownReceivedHtml("<p>hi</p>", { remoteImages: true });
    expect(doc.startsWith(POLICY)).toBe(true);
    expect(doc).toContain(
      "default-src 'none'; img-src data: https:; style-src 'unsafe-inline'; font-src data:",
    );
  });

  it("keeps the message's doctype first, so its rendering mode stays as sent", () => {
    expect(
      lockDownReceivedHtml("<!DOCTYPE html>\n<html><body>hi</body></html>").startsWith(
        `<!DOCTYPE html>${POLICY}`,
      ),
    ).toBe(true);
  });
});

describe("prepareReceivedHtml", () => {
  it("drops what would override the frame's own policy, keeping the message's color schemes", () => {
    const { full } = prepareReceivedHtml(
      '<html><head><meta http-equiv="refresh" content="0;url=https://x.example/"><base href="https://x.example/">' +
        '<meta name="referrer" content="unsafe-url"><link rel="preconnect" href="https://tracker.example">' +
        '<meta name="color-scheme" content="light dark"></head><body><a href="/a">a</a></body></html>',
    );
    expect(full.html).not.toMatch(/refresh|<base|unsafe-url|<link/);
    expect(full.html).toContain('<meta name="color-scheme" content="light dark">');
    expect(full.html).toContain('<a href="/a">a</a>');
  });

  it("tells a message that would load remote images from one that carries its own", () => {
    const remote = (html: string) => prepareReceivedHtml(html).full.remoteImages;
    expect(remote('<img src="https://cdn.example.com/a.png">')).toBe(true);
    expect(remote('<img src="//cdn.example.com/a.png">')).toBe(true);
    expect(
      remote('<img srcset="data:image/png;base64,AA== 1x, https://cdn.example.com/b.png 2x">'),
    ).toBe(true);
    expect(remote('<table background="https://cdn.example.com/bg.png"></table>')).toBe(true);
    expect(
      remote('<div style="background:url(&quot;https://cdn.example.com/bg.png&quot;)"></div>'),
    ).toBe(true);
    expect(
      remote("<style>.hero{background-image:url(https://cdn.example.com/h.png)}</style>"),
    ).toBe(true);
    expect(remote('<img src="data:image/png;base64,AA=="><img src="cid:logo@example.com">')).toBe(
      false,
    );
    // Written as text, a URL is no image.
    expect(remote("<p>see https://cdn.example.com/a.png</p>")).toBe(false);
  });

  it("folds the quoted history mail clients mark, and keeps it when it is all there is", () => {
    const trimmed = (html: string) => prepareReceivedHtml(html).trimmed?.html ?? null;
    const gmail =
      '<div dir="ltr">Sounds good.</div><div class="gmail_quote"><div class="gmail_attr">On Thu, Oct 16, 2026 at 10:00 AM Ana &lt;ana@example.com&gt; wrote:<br></div><blockquote class="gmail_quote">Old text</blockquote></div>';
    expect(trimmed(gmail)).toContain("Sounds good.");
    expect(trimmed(gmail)).not.toMatch(/wrote|Old text/);
    expect(prepareReceivedHtml(gmail).full.html).toContain("Old text");
    const apple =
      '<div>Yes.<br><blockquote type="cite"><div>On Oct 16, 2026, at 10:00, Ana wrote:</div>Old text</blockquote></div>';
    expect(trimmed(apple)).not.toContain("Old text");
    const thunderbird =
      '<p>Yes.</p><div class="moz-cite-prefix">On 10/16/26 10:00, Ana wrote:<br></div><blockquote type="cite">Old text</blockquote>';
    expect(trimmed(thunderbird)).not.toMatch(/wrote|Old text/);
    // Outlook: its marker, the rule above it and everything after are history.
    const outlook =
      '<div>Yes.</div><hr><div id="divRplyFwdMsg"><b>From:</b> Ana<br><b>Sent:</b> Thursday</div><div>Old text</div>';
    expect(trimmed(outlook)).toContain("Yes.");
    expect(trimmed(outlook)).not.toMatch(/<hr|From:|Old text/);
    expect(trimmed('<div class="yahoo_quoted">On Thursday Ana wrote: old</div>')).toBeNull();
    expect(trimmed('<p>Yes.</p><div class="protonmail_quote">Old text</div>')).not.toContain(
      "Old text",
    );
    expect(trimmed("<p>No quote here.</p>")).toBeNull();
  });

  it("never folds a forward, whose original is what the sender wants read", () => {
    expect(
      prepareReceivedHtml(
        '<div>FYI</div><div class="gmail_quote"><div class="gmail_attr">---------- Forwarded message ---------<br>From: Ana</div>Original</div>',
      ).trimmed,
    ).toBeNull();
    // A reply quoting an older forward still folds.
    expect(
      prepareReceivedHtml(
        '<div>Thanks</div><div class="gmail_quote">On Thu, Ana wrote:<br><blockquote class="gmail_quote"><div class="gmail_quote">---------- Forwarded message ---------<br>x</div></blockquote></div>',
      ).trimmed?.html,
    ).not.toContain("Forwarded");
  });

  it("says whether the folded body still asks for remote images", () => {
    const { full, trimmed } = prepareReceivedHtml(
      '<p>Thanks!</p><blockquote type="cite"><img src="https://cdn.example.com/logo.png"></blockquote>',
    );
    expect(full.remoteImages).toBe(true);
    expect(trimmed?.remoteImages).toBe(false);
  });
});

describe("withoutTrailingQuote", () => {
  it("cuts a reply's quoted tail, attribution included", () => {
    expect(
      withoutTrailingQuote(
        "Thanks, that worked!\n\n-- \nBruno\n\nOn Thu, Oct 16, 2026 at 10:00 AM Ana Souza <ana@example.com>\nwrote:\n> Try again?\n> Ana",
      ),
    ).toBe("Thanks, that worked!\n\n-- \nBruno");
    expect(withoutTrailingQuote("Done.\r\n\r\n> Can you check?\r\n> Ana\r\n")).toBe("Done.");
  });

  it("folds nothing when the quote is all there is, answers sit between quotes, or it is a forward", () => {
    expect(withoutTrailingQuote("No quote here.")).toBeNull();
    expect(withoutTrailingQuote("On Thu, Oct 16, 2026, Ana wrote:\n> Hi")).toBeNull();
    expect(
      withoutTrailingQuote("> Question one?\nAnswer one.\n> Question two?\nAnswer two."),
    ).toBeNull();
    expect(
      withoutTrailingQuote("FYI\n\n---------- Forwarded message ---------\nFrom: Ana\n\n> quoted"),
    ).toBeNull();
  });
});

it("names where a link leads: a mailto's address, any other link whole", () => {
  expect(linkDestination("mailto:ana%40example.com?subject=Hi")).toEqual({
    text: "ana@example.com",
    mail: true,
  });
  expect(linkDestination("https://example.com/a?utm_source=x")).toEqual({
    text: "https://example.com/a?utm_source=x",
    mail: false,
  });
  expect(linkDestination("mailto:%E0%A4%A")).toEqual({ text: "%E0%A4%A", mail: true });
});
