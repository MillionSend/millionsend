// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { htmlToText, messageHtml, textAsHtml } from "./html";

describe("messageHtml", () => {
  it("drops classes and gives a button block the link a mail client shows", () => {
    const html = messageHtml(
      '<p class="mly:relative">Hi</p><div data-type="button" data-text="Open" data-url="https://example.com/a" data-alignment="center" data-variant="filled" data-border-radius="round"></div>',
    );
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect(doc.querySelector("[class]")).toBeNull();
    const button = doc.querySelector('div[data-type="button"]');
    expect(button?.getAttribute("data-text")).toBe("Open");
    expect(button?.getAttribute("style")).toBe("text-align:center");
    const link = button?.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://example.com/a");
    expect(link?.textContent).toBe("Open");
    expect(link?.getAttribute("style")).toContain("border-radius:9999px");
    expect(htmlToText(html)).toBe("Hi\n\nOpen (https://example.com/a)");
  });

  it("keeps the colours chosen in the editor", () => {
    const html = messageHtml(
      '<div data-type="button" data-text="Go" data-url="https://example.com" buttoncolor="#2563eb" textcolor="#fefefe"></div>',
    );
    const style = new DOMParser()
      .parseFromString(html, "text/html")
      .querySelector("a")
      ?.getAttribute("style");
    expect(style).toContain("background:#2563eb");
    expect(style).toContain("color:#fefefe");
  });

  it("renders the same button again on a second pass", () => {
    const once = messageHtml(
      '<div data-type="button" data-text="Go" data-url="https://example.com"></div>',
    );
    expect(messageHtml(once)).toBe(once);
  });
});

describe("textAsHtml", () => {
  it("reads back as the same text", () => {
    expect(textAsHtml("a\nb\n\nc")).toBe("<p>a<br>b</p><p>c</p>");
    expect(htmlToText(textAsHtml("a\nb\n\nc"))).toBe("a\nb\n\nc");
  });
});
