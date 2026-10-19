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

  it("reads an exported email the way a recipient sees it", () => {
    const html = `<!doctype html>
<html>
  <head>
    <title>Spring issue</title>
    <style>p { margin: 0 }</style>
  </head>
  <body>
    <div style="display:none">See what's new&zwnj;&nbsp;&zwnj;&nbsp;&#847;&#8203;</div>
    <!--[if mso]><table><tr><td>Outlook-only button</td></tr></table><![endif]-->
    <table>
      <tr>
        <td>
          <h1>Spring
            issue</h1>
          <p>Hi {{{FIRST_NAME|there}}}, read the
            <a href="https://example.com/news">latest news</a>.</p>
          <a href="">&#8202;&#8202;Open&#8202;&#8202;&#8203;</a>
        </td>
      </tr>
    </table>
  </body>
</html>`;
    expect(htmlToText(html)).toBe(
      "See what's new\n\nSpring issue\n\nHi {{{FIRST_NAME|there}}}, read the latest news (https://example.com/news).\n\nOpen",
    );
  });

  it("decodes numeric entities, keeps an escaped one literal, and leaves a bogus one as written", () => {
    expect(htmlToText("<p>&#169; &#x2014; &amp;#169; &#9999999999;</p>")).toBe(
      "© — &#169; &#9999999999;",
    );
  });

  it("shows a link's URL once, and none for an empty or placeholder href", () => {
    expect(htmlToText('<a href="https://example.com">https://example.com</a>')).toBe(
      "https://example.com",
    );
    expect(htmlToText('<a href="#">Top</a> <a href="">Open</a>')).toBe("Top Open");
  });
});
