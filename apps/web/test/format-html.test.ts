import { describe, expect, it } from "vitest";
import { formatHtml, htmlToText } from "@/lib/html";

describe("formatHtml", () => {
  it("indents nested tags one per line and leaves void elements flat", () => {
    expect(formatHtml('<div><p>Hi <b>there</b></p><img src="x"><br/></div>')).toBe(
      [
        "<div>",
        "  <p>",
        "    Hi",
        "    <b>",
        "      there",
        "    </b>",
        "  </p>",
        '  <img src="x">',
        "  <br/>",
        "</div>",
      ].join("\n"),
    );
  });

  it("keeps style and script bodies verbatim and survives '>' inside attributes", () => {
    const html = '<head><style>a{color:red}\n.b>c{}</style></head><a href="?x>1">go</a>';
    expect(formatHtml(html)).toBe(
      [
        "<head>",
        "  <style>",
        "a{color:red}",
        ".b>c{}",
        "  </style>",
        "</head>",
        '<a href="?x>1">',
        "  go",
        "</a>",
      ].join("\n"),
    );
  });
});

describe("htmlToText", () => {
  it("decodes &amp; last so an escaped entity stays literal", () => {
    expect(htmlToText("<p>Type &lt;b&gt; to bold &amp;lt;</p>")).toBe("Type <b> to bold &lt;");
  });

  it("keeps an editor's paragraphs apart and its list items one per line", () => {
    const html =
      "<p>Hello,</p><p>We got the order.<br>It ships today.</p>" +
      "<ul><li><p>one</p></li><li><p>two</p></li></ul><p>Thanks</p>";
    expect(htmlToText(html)).toBe(
      "Hello,\n\nWe got the order.\nIt ships today.\n\n- one\n- two\n\nThanks",
    );
  });
});
