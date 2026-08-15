import { describe, expect, it } from "vitest";
import { sanitizeHtml } from "./sanitize-html";

describe("sanitizeHtml", () => {
  it("drops script/style with their content but keeps surrounding markup", () => {
    const out = sanitizeHtml("<p>ok</p><script>steal()</script><style>a{}</style><p>bye</p>");
    expect(out).toContain("<p>ok</p>");
    expect(out).toContain("<p>bye</p>");
    expect(out).not.toContain("steal(");
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<style");
  });

  it("removes document-metadata and framing elements", () => {
    const out = sanitizeHtml(
      '<meta http-equiv="refresh"><link rel="x"><iframe src="//e"></iframe><base href="//e">ok',
    );
    expect(out).not.toMatch(/<(meta|link|iframe|base)\b/i);
    expect(out).toContain("ok");
  });

  it("strips inline event handlers", () => {
    const out = sanitizeHtml('<a href="https://x" onclick="pwn()" onmouseover=\'y()\'>go</a>');
    expect(out).not.toContain("onclick");
    expect(out).not.toContain("onmouseover");
    expect(out).toContain('href="https://x"');
    expect(out).toContain(">go</a>");
  });

  it("strips javascript: urls in href/src", () => {
    const out = sanitizeHtml('<a href="javascript:alert(1)">x</a><img src=javascript:bad>');
    expect(out).not.toContain("javascript:");
  });

  // Attribute-boundary bypasses that defeated the old regex sanitizer: a slash
  // or missing whitespace before the handler/href instead of a space.
  it("neutralizes handlers/urls separated by / or missing whitespace", () => {
    for (const payload of [
      '<img src="x"/onerror=alert(1)>',
      "<img/onerror=alert(1) src=x>",
      "<a/href=javascript:alert(1)>click</a>",
      "<svg/onload=alert(1)>",
      "<svg onload=alert(1)></svg>",
      '<img src="data:text/html,<script>alert(1)</script>">',
      "<a href=`javascript:alert(1)`>x</a>",
      "<<img src=x onerror=alert(1)>",
    ]) {
      const out = sanitizeHtml(payload);
      expect(out).not.toMatch(/onerror|onload/i);
      // No url attribute whose value is the executable javascript: scheme (a
      // leading backtick/space demotes it to an inert relative URL, which is
      // safe to leave — the property is "does not execute", not "no substring").
      expect(out).not.toMatch(/=\s*["']?\s*javascript:/i);
      expect(out).not.toMatch(/<svg/i);
      expect(out).not.toMatch(/<script/i);
    }
  });

  it("keeps legitimate email formatting and structure", () => {
    const out = sanitizeHtml(
      '<p><b>b</b><i>i</i><u>u</u> <a href="https://x">link</a></p>' +
        "<table><tr><td>cell</td></tr></table>" +
        '<img src="https://cdn/i.png" alt="pic">' +
        "<span>Hi {{{FIRST_NAME|there}}}</span>",
    );
    expect(out).toContain("<b>b</b>");
    expect(out).toContain("<i>i</i>");
    expect(out).toContain("<u>u</u>");
    expect(out).toContain('href="https://x"');
    expect(out).toMatch(/<table/);
    expect(out).toContain("<td>cell</td>");
    expect(out).toContain('src="https://cdn/i.png"');
    expect(out).toContain("{{{FIRST_NAME|there}}}");
  });

  it("preserves merge tokens as plain text", () => {
    const out = sanitizeHtml("<table><tr><td>Hi {{{FIRST_NAME|there}}}</td></tr></table>");
    expect(out).toContain("{{{FIRST_NAME|there}}}");
    expect(out).toContain("<td>");
  });

  it("keeps merge tokens used inside href/src so unsubscribe links survive", () => {
    // A {{{...}}} token leads with '{', a non-scheme char DOMPurify's URI check
    // permits — the worker substitutes the real URL at send time. Losing this
    // would silently break RFC 8058 unsubscribe links written in a custom-HTML
    // block, while javascript:/data: URLs must still be stripped.
    const link = sanitizeHtml('<a href="{{{UNSUBSCRIBE_URL}}}">Unsubscribe</a>');
    expect(link).toContain('href="{{{UNSUBSCRIBE_URL}}}"');
    const img = sanitizeHtml('<img src="{{{HERO_IMAGE}}}">');
    expect(img).toContain('src="{{{HERO_IMAGE}}}"');
    expect(sanitizeHtml('<a href="javascript:alert(1)">x</a>')).not.toContain("javascript:");
  });
});
