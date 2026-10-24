import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkerRail, MobileStepBar } from "./stepper";

const rail = (props: { marker: string; done?: boolean }) =>
  renderToStaticMarkup(
    createElement(MarkerRail, { color: "var(--ms-bone)", fadeTop: true, ...props }),
  );

describe("MarkerRail", () => {
  it("shows a done step as a single ✓ in place of its number", () => {
    const html = rail({ marker: "01", done: true });
    expect(html).toMatch(/<\/span>✓<\/span>/);
    expect(html).not.toContain("01");
  });

  it("shows a step still to do by its number alone", () => {
    const html = rail({ marker: "02" });
    expect(html).toMatch(/<\/span>02<\/span>/);
    expect(html).not.toContain("✓");
  });
});

describe("MobileStepBar", () => {
  it("keeps a done step's label as its name beside the ✓, the current step marked", () => {
    const html = renderToStaticMarkup(
      createElement(MobileStepBar, { steps: ["Domain & region", "DNS records"], active: 2 }),
    );
    expect(html).toBe(
      '<ol class="ms-stepbar">' +
        '<li class="ms-stepbar-step done"><span class="ms-stepbar-dot ms-mono">✓</span><span class="ms-stepbar-text">Domain &amp; region</span></li>' +
        '<li class="ms-stepbar-step current" aria-current="step"><span class="ms-stepbar-dot ms-mono">02</span><span class="ms-stepbar-text">DNS records</span></li>' +
        "</ol>",
    );
  });
});
