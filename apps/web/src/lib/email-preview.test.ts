// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  DARK_CLIENT_SIM,
  emulateEmailScheme,
  isForwardSubject,
  linkDestination,
  lockDownReceivedHtml,
  prepareReceivedHtml,
  withoutTrailingQuote,
} from "./email-preview";

/** What the frame builds from a prepared body: the doctype is its no-quirks parse. */
const framed = (html: string) =>
  new DOMParser().parseFromString(`<!doctype html>${html}`, "text/html");

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

  it("lets images, and only images from the hosts named, come from the network once asked", () => {
    const doc = lockDownReceivedHtml("<p>hi</p>", {
      imageHosts: ["cdn.example.com", "img.example.net:8443"],
    });
    expect(doc.startsWith(POLICY)).toBe(true);
    expect(doc).toContain(
      "default-src 'none'; img-src data: https://cdn.example.com https://img.example.net:8443; style-src 'unsafe-inline'; font-src data:",
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
        '<meta name="color-scheme" content="light dark"></head><body><a href="/a">a</a>' +
        '<iframe srcdoc="&lt;link rel=preconnect href=https://tracker.example&gt;"></iframe></body></html>',
    );
    expect(full.html).not.toMatch(/refresh|<base|unsafe-url|<link|<iframe/);
    expect(full.html).toContain('<meta name="color-scheme" content="light dark">');
    expect(full.html).toContain('<a href="/a" target="_blank" rel="noopener noreferrer">a</a>');
  });

  it("opens every link in a new tab with no way back to the dashboard", () => {
    const { full } = prepareReceivedHtml(
      '<a id="named" href="https://sender.example/a" target="promo" rel="opener">a</a>' +
        '<a id="self" href="https://sender.example/b" target="_self">b</a>' +
        '<map><area id="area" href="https://sender.example/c" target="_top"></map>' +
        '<svg><a id="svg" href="https://sender.example/d"><text>d</text></a></svg>',
    );
    const doc = framed(full.html);
    for (const id of ["named", "self", "area", "svg"]) {
      const link = doc.getElementById(id);
      expect(link?.getAttribute("target"), id).toBe("_blank");
      expect(link?.getAttribute("rel"), id).toBe("noopener noreferrer");
    }
  });

  it("strips what only the frame's own parse would build: re-parsed markup and shadow roots", () => {
    // Read once, the metadata here is text in a <style>; the frame, parsing
    // the markup that read serializes to, makes elements of it.
    const mutation =
      '<form><math><mtext></form><form><mglyph><style></math><meta name="referrer" content="unsafe-url"><link rel="preconnect" href="https://sender.example">';
    const shadow =
      '<div><template shadowrootmode="open"><link rel="preconnect" href="https://sender.example"><a href="https://sender.example/x">x</a></template></div>';
    for (const html of [mutation, shadow]) {
      const { full } = prepareReceivedHtml(html);
      const doc = framed(full.html);
      expect(doc.querySelector('meta[name="referrer"], link, template[shadowrootmode]')).toBeNull();
      // What the frame builds is exactly what was checked.
      expect(doc.documentElement.outerHTML).toBe(full.html);
    }
  });

  it("names the hosts a message's remote images come from, never the dashboard's own", () => {
    const hosts = (html: string) => prepareReceivedHtml(html).full.imageHosts;
    expect(hosts('<img src="https://cdn.example.com/a.png">')).toEqual(["cdn.example.com"]);
    expect(hosts('<img src="//cdn.example.com/a.png">')).toEqual(["cdn.example.com"]);
    expect(
      hosts('<img srcset="data:image/png;base64,AA== 1x, https://cdn.example.com/b.png 2x">'),
    ).toEqual(["cdn.example.com"]);
    expect(hosts('<table background="https://bg.example.net/bg.png"></table>')).toEqual([
      "bg.example.net",
    ]);
    expect(
      hosts('<div style="background:url(&quot;https://cdn.example.com/bg.png&quot;)"></div>'),
    ).toEqual(["cdn.example.com"]);
    expect(
      hosts("<style>.hero{background-image:url(https://img.example.org:8443/h.png)}</style>"),
    ).toEqual(["img.example.org:8443"]);
    expect(hosts('<img src="data:image/png;base64,AA=="><img src="cid:logo@example.com">')).toEqual(
      [],
    );
    // Written as text, a URL is no image.
    expect(hosts("<p>see https://cdn.example.com/a.png</p>")).toEqual([]);
    // The frame shares the dashboard's origin: an image there would carry the reader's session.
    expect(
      hosts(
        `<img src="/export/emails"><img src="https://${location.host}/export/contacts">` +
          `<img src="//${location.host}/api/x"><div style="background:url(/y)"></div>`,
      ),
    ).toEqual([]);
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

  it("folds only the history after the last thing the sender wrote, never answers' questions", () => {
    const trimmed = (html: string) => prepareReceivedHtml(html).trimmed?.html ?? null;
    // Apple Mail and Thunderbird answer between top-level quotes.
    expect(
      trimmed(
        'Answers inline.<blockquote type="cite">Can you send the Q3 report?</blockquote>Yes, attached.' +
          '<blockquote type="cite">And the invoice for October?</blockquote>Next week.',
      ),
    ).toBeNull();
    expect(
      trimmed(
        '<div class="moz-cite-prefix">On 10/16/26, Ana wrote:</div><blockquote type="cite">Ship Friday?</blockquote>' +
          '<p>No, Monday.</p><blockquote type="cite">Who signs?</blockquote><p>Bruno does.</p>',
      ),
    ).toBeNull();
    // Gmail keeps the answers inside its quote, beside the quoted parts.
    expect(
      trimmed(
        '<div dir="ltr">Hi Ana,</div><div class="gmail_quote"><div class="gmail_attr">On Thu, Ana wrote:<br></div>' +
          '<blockquote class="gmail_quote">1. Ship Friday?</blockquote><div>Yes, Friday works.</div>' +
          '<blockquote class="gmail_quote">2. Invoice?</blockquote><div>Sent it this morning.</div></div>',
      ),
    ).toBeNull();
    // Answered between, then quoted again at the end: only the end folds.
    const partly = trimmed(
      'Intro<blockquote type="cite">Question</blockquote>Answer<blockquote type="cite">Old history</blockquote>',
    );
    expect(partly).toContain("Question");
    expect(partly).toContain("Answer");
    expect(partly).not.toContain("Old history");
  });

  it("folds nothing when all the reader would see outside the quote is hidden", () => {
    const trimmed = (html: string) => prepareReceivedHtml(html).trimmed;
    expect(
      trimmed(
        '<div style="display:none">Ticket #1042 was updated</div><blockquote type="cite"><p>Hi Ana, we refunded order #1042.</p></blockquote>',
      ),
    ).toBeNull();
    expect(
      trimmed(
        '<div style="max-height:0;overflow:hidden">Preview text</div><div hidden>more</div><blockquote type="cite">All of it</blockquote>',
      ),
    ).toBeNull();
    expect(
      trimmed('<div>\u200b\u200c&nbsp;</div><blockquote type="cite">All of it</blockquote>'),
    ).toBeNull();
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
    expect(full.imageHosts).toEqual(["cdn.example.com"]);
    expect(trimmed?.imageHosts).toEqual([]);
  });
});

it("tells a forward by the prefixes mail clients give its subject", () => {
  for (const subject of ["Fwd: Invoice", "FW: Invoice", "ENC: Fatura", "RV: Factura", "WG: x"]) {
    expect(isForwardSubject(subject), subject).toBe(true);
  }
  for (const subject of ["Re: Fwd: Invoice", "Forward planning", "Invoice", null]) {
    expect(isForwardSubject(subject), String(subject)).toBe(false);
  }
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
    // Answered inline under an attribution.
    expect(
      withoutTrailingQuote(
        "Hi Ana,\n\nOn 10/16/26, Ana wrote:\n> 1. Ship Friday?\nYes, Friday works.\n> 2. Invoice?\nSent it this morning.",
      ),
    ).toBeNull();
  });
});

it("names where a link leads: the host whole with its owner's domain apart, a mailto's address", () => {
  // A look-alike host puts the real domain at the end, where a cut would hide it.
  expect(
    linkDestination(
      "https://accounts.example.com.signin.session-check.evil.example:8443/login?next=%2F#top",
    ),
  ).toEqual({
    lead: "https://accounts.example.com.signin.session-check.",
    domain: "evil.example",
    rest: ":8443/login?next=%2F#top",
    mail: false,
  });
  // The host as it resolves: no userinfo to read as a name, punycode for look-alike letters.
  expect(linkDestination("https://bank.example@evil.example/")).toEqual({
    lead: "https://",
    domain: "evil.example",
    rest: "",
    mail: false,
  });
  expect(linkDestination("https://www.bаnk.example/").domain).toMatch(/^xn--/);
  expect(linkDestination("mailto:ana%40example.com?subject=Hi")).toEqual({
    lead: "ana@example.com",
    domain: "",
    rest: "",
    mail: true,
  });
  expect(linkDestination("mailto:%E0%A4%A").lead).toBe("%E0%A4%A");
  expect(linkDestination("tel:+15555550100")).toEqual({
    lead: "",
    domain: "",
    rest: "tel:+15555550100",
    mail: false,
  });
});
