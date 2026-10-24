import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SubdomainInput } from "./subdomain-input";

describe("SubdomainInput", () => {
  it("keeps the field's own name and state, and breaks the domain after its dots", () => {
    const html = renderToStaticMarkup(
      createElement(SubdomainInput, {
        id: "tracking-subdomain",
        "aria-label": "Tracking subdomain",
        domain: "mail.acme.example",
        error: true,
        disabled: true,
        value: "links",
        readOnly: true,
      }),
    );
    expect(html).toMatch(/<input type="text" class="ms-input mono error"/);
    for (const attribute of [
      'id="tracking-subdomain"',
      'aria-label="Tracking subdomain"',
      'autoComplete="off"',
      'spellCheck="false"',
      'disabled=""',
    ]) {
      expect(html).toContain(attribute);
    }
    expect(html).toContain(">.mail.<wbr/>acme.<wbr/>example</span>");
  });
});
