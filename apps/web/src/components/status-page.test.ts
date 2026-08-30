import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatusPage } from "./status-page";

describe("StatusPage", () => {
  it("renders code as digits, then title, body and actions in order", () => {
    const html = renderToStaticMarkup(
      createElement(StatusPage, {
        code: "404",
        title: "No such page.",
        body: "Wrong address.",
        actions: createElement("a", { href: "/" }, "Home"),
      }),
    );
    expect(html).toContain('class="ms-digits ms-status-code">404<');
    expect(html.indexOf("No such page.")).toBeLessThan(html.indexOf("Wrong address."));
    expect(html.indexOf("Wrong address.")).toBeLessThan(html.indexOf('href="/"'));
  });
});
