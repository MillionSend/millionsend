import { describe, expect, it } from "vitest";
import type { Block, BlockDoc } from "./model";
import { emptyBlockDoc } from "./model";
import { serialize } from "./serialize";

function doc(...blocks: Block[]): BlockDoc {
  return { version: 1, blocks };
}

describe("serialize html", () => {
  it("wraps in a 600px centered table", () => {
    const { html } = serialize(emptyBlockDoc());
    expect(html).toContain('width="600"');
    expect(html).toContain("max-width:600px");
    expect(html).toContain('align="center"');
    // empty doc still yields a valid, balanced wrapper
    expect(html.match(/<table/g)).toHaveLength(2);
    expect(html.match(/<\/table>/g)).toHaveLength(2);
    // inner container closes with no block rows inside it
    expect(html).toContain('margin:0 auto;"></table>');
  });

  it("renders a heading with level tag and inline styles", () => {
    const { html } = serialize(
      doc({
        type: "heading",
        id: "h",
        level: 2,
        html: "Hello",
        align: "left",
        color: "#111111",
        fontSize: 28,
        padding: 16,
      }),
    );
    expect(html).toContain("<h2 ");
    expect(html).toContain("font-size:28px");
    expect(html).toContain("color:#111111");
    expect(html).toContain("padding:16px");
    expect(html).toContain(">Hello</h2>");
  });

  it("renders a text block, passing inline html through", () => {
    const { html } = serialize(
      doc({
        type: "text",
        id: "t",
        html: "<p>Hi <strong>there</strong></p>",
        align: "left",
        color: "#333333",
        fontSize: 16,
        padding: 8,
      }),
    );
    expect(html).toContain("<p>Hi <strong>there</strong></p>");
    expect(html).toContain("font-size:16px");
  });

  it("renders an image with width, alt, and optional link", () => {
    const linked = serialize(
      doc({
        type: "image",
        id: "i",
        src: "https://x/y.png",
        alt: "Logo",
        width: 240,
        href: "https://x",
        align: "center",
        padding: 0,
      }),
    ).html;
    expect(linked).toContain('src="https://x/y.png"');
    expect(linked).toContain('alt="Logo"');
    expect(linked).toContain('width="240"');
    expect(linked).toContain("width:240px");
    expect(linked).toContain('<a href="https://x" target="_blank">');

    const unlinked = serialize(
      doc({
        type: "image",
        id: "i",
        src: "https://x/y.png",
        alt: "Logo",
        width: 240,
        align: "center",
        padding: 0,
      }),
    ).html;
    expect(unlinked).not.toContain("<a href");
  });

  it("renders a bulletproof table button", () => {
    const { html } = serialize(
      doc({
        type: "button",
        id: "b",
        label: "Buy now",
        href: "https://x/buy",
        bgColor: "#2563eb",
        textColor: "#ffffff",
        radius: 6,
        align: "center",
        padding: 12,
      }),
    );
    expect(html).toContain('bgcolor="#2563eb"');
    expect(html).toContain("background-color:#2563eb");
    expect(html).toContain("border-radius:6px");
    expect(html).toContain('<a href="https://x/buy"');
    expect(html).toContain(">Buy now</a>");
    expect(html).toContain("color:#ffffff");
  });

  it("renders divider and spacer rows", () => {
    const divider = serialize(
      doc({ type: "divider", id: "d", color: "#e5e5e5", thickness: 2, padding: 8 }),
    ).html;
    expect(divider).toContain("border-top:2px solid #e5e5e5");

    const spacer = serialize(doc({ type: "spacer", id: "s", height: 40 })).html;
    expect(spacer).toContain("height:40px");
    expect(spacer).toContain("line-height:40px");
  });

  it("passes a merge token through byte-for-byte", () => {
    const { html, text } = serialize(
      doc({
        type: "text",
        id: "t",
        html: "<p>Hi {{{FIRST_NAME|there}}}, you are {{{plan}}}</p>",
        align: "left",
        color: "#000000",
        fontSize: 16,
        padding: 0,
      }),
    );
    expect(html).toContain("{{{FIRST_NAME|there}}}");
    expect(html).toContain("{{{plan}}}");
    expect(text).toContain("{{{FIRST_NAME|there}}}");
    expect(text).toContain("{{{plan}}}");
  });

  it("passes a custom-html block through verbatim in html but not in text", () => {
    const hostile = '<script>alert("xss")</script><p>ok {{{EMAIL}}}</p>';
    const { html, text } = serialize(doc({ type: "html", id: "c", html: hostile, padding: 0 }));
    // html: raw passthrough — defense-in-depth sanitization is the paste path's job
    expect(html).toContain(hostile);
    // text: script dropped entirely, token kept
    expect(text).not.toContain("<script");
    expect(text).not.toContain("alert(");
    expect(text).toContain("ok {{{EMAIL}}}");
  });
});

describe("serialize text", () => {
  it("keeps link URLs and joins blocks", () => {
    const { text } = serialize(
      doc(
        {
          type: "heading",
          id: "h",
          level: 1,
          html: "Title",
          align: "left",
          color: "#000",
          fontSize: 32,
          padding: 0,
        },
        {
          type: "text",
          id: "t",
          html: '<p>See <a href="https://x">the page</a></p>',
          align: "left",
          color: "#000",
          fontSize: 16,
          padding: 0,
        },
        {
          type: "button",
          id: "b",
          label: "Go",
          href: "https://x/go",
          bgColor: "#000",
          textColor: "#fff",
          radius: 4,
          align: "center",
          padding: 0,
        },
      ),
    );
    expect(text).toContain("Title");
    expect(text).toContain("the page (https://x)");
    expect(text).toContain("Go (https://x/go)");
    // divider/spacer contribute no text lines
    expect(text.split("\n\n")).toHaveLength(3);
  });
});
