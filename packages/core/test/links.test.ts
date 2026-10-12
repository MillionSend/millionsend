import { describe, expect, it } from "vitest";
import {
  type BodyLink,
  extractLinks,
  resolveLink,
  resolveTextUrl,
  UNRESOLVED_DESTINATION,
} from "../src/links.js";
import { isShortener, messageDestinations } from "../src/screening.js";

const hostOf = (link: Pick<BodyLink, "url">) => (link.url ? new URL(link.url).hostname : null);
const summary = (links: BodyLink[]) =>
  links.map((l) => `${l.source} ${l.unresolved ? "(unresolved)" : (hostOf(l) ?? "(none)")}`);

describe("extractLinks", () => {
  it("reads attributes as the tokenizer does: a decoy inside another attribute stays its text", () => {
    const links = extractLinks(
      `<a title=" href='https://www.team.dev/' " href="https://evil.example/x">Sign in</a>` +
        `<a/href=https://slash.example/y>Pay</a>` +
        `<a href="https://first.example/" href="https://second.example/">Twice</a>`,
      null,
    );
    expect(summary(links)).toEqual(["a evil.example", "a slash.example", "a first.example"]);
    expect(links.map((l) => l.text)).toEqual(["Sign in", "Pay", "Twice"]);
  });

  it("resolves a value as the WHATWG URL parser does", () => {
    const hrefs = [
      "https:\\\\evil.example/a",
      "https:/\\evil.example/b",
      "ht&#9;tps://evil.example/c",
      "https&colon;&sol;&sol;evil.example/d",
      "//evil.example/e",
      "https:evil.example/f",
      " https://evil.example/g ",
    ];
    const links = extractLinks(hrefs.map((h) => `<a href="${h}">x</a>`).join(""), null);
    expect(links.map((l) => l.url)).toEqual([
      "https://evil.example/a",
      "https://evil.example/b",
      "https://evil.example/c",
      "https://evil.example/d",
      "https://evil.example/e",
      "https://evil.example/f",
      "https://evil.example/g",
    ]);
  });

  it("finds forms, image maps, SVG links and the links clients make of text", () => {
    const links = extractLinks(
      '<form action="https://collect.example/post"><input name=p><button formaction="https://other.example/f">Go</button></form>' +
        '<img usemap="#m"><map name="m"><area href="https://area.example/a" alt="Pay here"></map>' +
        '<svg><a xlink:href="https://svg.example/s"><text>Open</text></a></svg>' +
        "<p>Or visit www.bare.example/login today, or https://plain.example/t.</p>" +
        '<a href="https://real.example/">www.decoy.example</a>',
      "Text part: https://textpart.example/q?a=1 and www.www-text.example",
    );
    expect(summary(links)).toEqual([
      "form collect.example",
      "form other.example",
      "area area.example",
      "xlink svg.example",
      "text www.bare.example",
      "text plain.example",
      "a real.example",
      "text textpart.example",
      "text www.www-text.example",
    ]);
    expect(links.find((l) => l.source === "area")?.text).toBe("Pay here");
  });

  it("resolves relative values against the first <base href>, wherever it sits", () => {
    const links = extractLinks(
      '<a href="login">Log in</a><base href="https://evil.example/app/"><base href="https://later.example/">',
      null,
    );
    expect(links[0]?.url).toBe("https://evil.example/app/login");
  });

  it("reads Outlook's conditional content as markup, and nothing in a comment or raw text", () => {
    const links = extractLinks(
      '<!--[if mso]><a href="https://outlook-only.example/">Button</a><![endif]-->' +
        '<!-- <a href="https://commented.example/"> -->' +
        '<title><a href="https://title.example/"></title>' +
        '<textarea><a href="https://textarea.example/"></textarea>' +
        '<script>var a = "<a href=https://script.example/>";</script>' +
        '<style>a[href="https://style.example/"]{}</style>' +
        '<a href="https://after.example/">after</a>',
      null,
    );
    expect(summary(links)).toEqual(["a outlook-only.example", "a after.example"]);
  });

  it("catches a link a browser finds after a conditional comment closes early", () => {
    // Browsers end the comment at the first "-->", inside the title.
    const links = extractLinks(
      '<!--[if mso]><a title=" --> <a href="https://evil.example/">Pay</a> "><![endif]-->',
      null,
    );
    expect(summary(links)).toEqual(["a evil.example"]);
  });

  it("reads through nested redirect wrappers, up to three, and calls a deeper nest unresolved", () => {
    const wrap = (url: string) => `https://www.google.com/url?q=${encodeURIComponent(url)}`;
    const two = wrap(wrap("https://evil.example/login"));
    const four = wrap(wrap(wrap(wrap("https://evil.example/login"))));
    const [nested, deep] = extractLinks(`<a href="${two}">a</a><a href="${four}">b</a>`, null);
    expect(nested).toMatchObject({ url: "https://evil.example/login", unresolved: false });
    expect(nested?.href).toBe(two);
    expect(deep).toMatchObject({ url: null, unresolved: true });
  });

  it("keeps the anchor text out of the text links, so it cannot pose as the destination", () => {
    const links = extractLinks(
      '<a href="https://evil.example/">https://bank.example/login</a>',
      null,
    );
    expect(summary(links)).toEqual(["a evil.example"]);
    expect(links[0]?.text).toBe("https://bank.example/login");
  });

  it("stands one unresolved link for every link past the first ten thousand", () => {
    const html = Array.from(
      { length: 10_005 },
      (_, i) => `<a href="https://l${i}.example/">x</a>`,
    ).join("");
    const links = extractLinks(html, null);
    expect(links).toHaveLength(10_001);
    expect(links.at(-1)).toMatchObject({ unresolved: true, url: null });
  });

  it("walks crafted bodies in linear time", () => {
    const started = performance.now();
    extractLinks(`<a title="${"x".repeat(200_000)}`, null);
    extractLinks(`<a ${'title=" '.repeat(50_000)}`, null);
    extractLinks("<!--".repeat(50_000), null);
    extractLinks("<!--[if x]>".repeat(50_000), null);
    extractLinks(`${"<!--[if x]><a href=x>".repeat(20_000)}-->`, null);
    extractLinks(`<a ${"x= ".repeat(100_000)}>`, null);
    extractLinks(`${"</ ".repeat(100_000)}`, null);
    extractLinks(`<p>${"www.a ".repeat(100_000)}</p>`, null);
    extractLinks(`${"<a href=#>".repeat(100_000)}`, null);
    extractLinks(`<script>${"</scrip".repeat(50_000)}`, null);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe("resolveLink", () => {
  it("names no destination for a plainly harmless value", () => {
    for (const raw of [
      "",
      "#top",
      "mailto:help@acme.dev",
      "tel:+5511999999999",
      "sms:+15551234",
      "javascript:void(0)",
      "/relative/path",
      "index.html",
      "{{{UNSUBSCRIBE_URL}}}",
      "whatsapp://send?phone=5511999999999",
    ]) {
      expect(resolveLink(raw), raw).toEqual({ href: null, url: null, unresolved: false });
    }
  });

  it("reports what names no destination it can read, and is not plainly harmless, as unresolved", () => {
    for (const raw of [
      "https://exa mple.com/",
      "http://",
      "data:text/html;base64,PGgxPkhpPC9oMT4=",
      "market://details?id=com.evil.app",
      "file://attacker/share",
    ]) {
      expect(resolveLink(raw), raw).toMatchObject({ url: null, unresolved: true });
    }
  });

  it("calls a value spelled with a reference it cannot decode unresolved, not a doubly escaped &", () => {
    const [unknown, doubled] = extractLinks(
      '<a href="https&Mystery;//evil.example/">a</a><a href="https://acme.dev/?a=1&amp;amp;b=2">b</a>',
      null,
    );
    expect(unknown).toMatchObject({ url: null, unresolved: true });
    expect(doubled).toMatchObject({ url: "https://acme.dev/?a=1&amp;b=2", unresolved: false });
  });

  it("follows a scheme-less host name, and a web URL or host another scheme carries", () => {
    expect(resolveLink("www.evil.example/login").url).toBe("https://www.evil.example/login");
    expect(resolveLink("evil.com/login").url).toBe("https://evil.com/login");
    expect(resolveLink("microsoft-edge:https://evil.example/x").url).toBe("https://evil.example/x");
    expect(resolveLink("intent://evil.com/x#Intent;scheme=https;end").url).toBe(
      "https://evil.com/",
    );
    expect(resolveLink("webcal://calendar.example.com/team.ics").url).toBe(
      "https://calendar.example.com/",
    );
  });

  it("drops what text or a QR code holds that is no web link", () => {
    expect(resolveTextUrl("otpauth://totp/Acme:ana?secret=JBSWY3DPEHPK3PXP")).toEqual({
      href: null,
      url: null,
      unresolved: false,
    });
    expect(resolveTextUrl("https://evil.example/qr").url).toBe("https://evil.example/qr");
  });
});

describe("messageDestinations", () => {
  const destinations = (html: string | null, text: string | null = null, links?: string[]) =>
    messageDestinations({ html, text, replyTo: null, links, verifiedDomains: ["team.dev"] });

  it("sees every link a client follows, however it is written", () => {
    expect(
      destinations(
        [
          `<a title=" href='https://www.team.dev/' " href="https://decoy.example/">a</a>`,
          "<a/href=https://slash.example/>b</a>",
          '<a href="https:\\\\backslash.example/">c</a>',
          '<a href="https:/\\mixed.example/">d</a>',
          '<a href="ht&#9;tps://tab.example/">e</a>',
          '<a href="//protocol-relative.example/">f</a>',
          '<form action="https://form.example/">',
          '<button formaction="https://formaction.example/">g</button>',
          '<area href="https://area.example/">',
          '<svg><a xlink:href="https://xlink.example/">h</a></svg>',
          "<p>www.bare.example</p>",
        ].join(""),
        "and https://text.example/x",
      ),
    ).toEqual([
      "area.example",
      "backslash.example",
      "bare.example",
      "decoy.example",
      "form.example",
      "formaction.example",
      "mixed.example",
      "protocol-relative.example",
      "slash.example",
      "tab.example",
      "text.example",
      "xlink.example",
    ]);
  });

  it("follows nested wrappers to where they lead", () => {
    const wrap = (url: string) => `https://www.google.com/url?q=${encodeURIComponent(url)}`;
    expect(destinations(`<a href="${wrap(wrap("https://evil.example/login"))}">x</a>`)).toEqual([
      "evil.example",
    ]);
  });

  it("counts a link it cannot read as a destination never cleared, but not a QR code's otpauth", () => {
    expect(destinations('<a href="https://exa mple.com/">x</a>')).toEqual([UNRESOLVED_DESTINATION]);
    expect(isShortener(UNRESOLVED_DESTINATION)).toBe(true);
    expect(
      destinations(
        '<a href="mailto:a@team.dev">m</a><a href="#top">t</a>',
        "starts with https://",
        ["otpauth://totp/Acme?secret=X"],
      ),
    ).toEqual([]);
  });
});

describe("text links", () => {
  it("take only what reads as a host", () => {
    expect(
      extractLinks("<p>www.a and www.example and www.shop.com.br/x</p>", null).map((l) => l.url),
    ).toEqual([null, null, "https://www.shop.com.br/x"]);
  });
});
