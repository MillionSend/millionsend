import { describe, expect, it } from "vitest";
import { formatHtml } from "@/lib/html";

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
