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

  it("leaves merge tokens and ordinary email markup untouched", () => {
    const src = "<table><tr><td>Hi {{{FIRST_NAME|there}}}</td></tr></table>";
    expect(sanitizeHtml(src)).toBe(src);
  });
});
