import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Breakable } from "./breakable";

const html = (text: string) => renderToStaticMarkup(createElement(Breakable, { text }));

describe("Breakable", () => {
  it("breaks every address of a list after its @ and dots, and nothing else", () => {
    expect(html("Ana <ana@x.com.br>, bob@y.io")).toBe(
      "Ana &lt;ana@<wbr/>x.<wbr/>com.<wbr/>br&gt;, bob@<wbr/>y.<wbr/>io",
    );
  });

  it("leaves prose and figures alone", () => {
    expect(html("Enviados 153.623 de 200.000.")).toBe("Enviados 153.623 de 200.000.");
  });

  it("keeps a trailing comma on a domain that ends a list item", () => {
    expect(html("dpab.com.br, x")).toBe("dpab.<wbr/>com.<wbr/>br, x");
  });
});
