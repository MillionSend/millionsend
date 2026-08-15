import { describe, expect, it } from "vitest";
import { mergeSpansToTokens, tokensToMergeSpans, unwrapParagraph } from "./merge-token-html";

describe("merge token <-> span round-trip", () => {
  it("round-trips a plain token through spans", () => {
    const html = "<p>Hi {{{FIRST_NAME}}}</p>";
    expect(mergeSpansToTokens(tokensToMergeSpans(html))).toBe(html);
  });

  it("round-trips a token with a fallback", () => {
    const html = "<p>Hi {{{FIRST_NAME|there}}}, plan {{{plan}}}</p>";
    expect(mergeSpansToTokens(tokensToMergeSpans(html))).toBe(html);
  });

  it("escapes fallbacks with html-special chars and restores them", () => {
    const html = '<p>{{{name|<b>"x"&y</b>}}}</p>';
    const spans = tokensToMergeSpans(html);
    // the span attribute must not carry raw angle brackets/quotes that break the tag
    expect(spans).not.toMatch(/data-merge-fallback="[^"]*</);
    expect(mergeSpansToTokens(spans)).toBe(html);
  });

  it("emits a parseable span carrying name and fallback", () => {
    expect(tokensToMergeSpans("{{{plan|free}}}")).toBe(
      '<span data-merge-field="plan" data-merge-fallback="free"></span>',
    );
  });

  it("leaves non-merge empty spans alone", () => {
    const html = '<span class="x"></span>';
    expect(mergeSpansToTokens(html)).toBe(html);
  });

  it("unwraps a single wrapping paragraph for heading storage", () => {
    expect(unwrapParagraph("<p>Hello world</p>")).toBe("Hello world");
    expect(unwrapParagraph("Hello")).toBe("Hello");
    // two paragraphs are not a single wrapper — leave intact
    expect(unwrapParagraph("<p>a</p><p>b</p>")).toBe("<p>a</p><p>b</p>");
  });
});
