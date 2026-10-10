import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Breakable, KeepHyphenated } from "./breakable";

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

const kept = (text: string) => renderToStaticMarkup(createElement(KeepHyphenated, { text }));

describe("KeepHyphenated", () => {
  it("keeps each hyphenated word on one line and leaves the rest alone", () => {
    expect(kept("Envie seu primeiro e-mail")).toBe(
      'Envie seu primeiro <span style="white-space:nowrap">e-mail</span>',
    );
    expect(kept("até sexta-feira, 12 e-mails.")).toBe(
      'até <span style="white-space:nowrap">sexta-feira,</span> 12 <span style="white-space:nowrap">e-mails.</span>',
    );
  });

  it("returns text without a word hyphen as it is", () => {
    expect(kept("Send your first email — 2 steps")).toBe("Send your first email — 2 steps");
  });
});
