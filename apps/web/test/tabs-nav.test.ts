import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AudienceTabs } from "@/app/(dashboard)/audience/audience-tabs";
import { revealInRow } from "@/lib/use-active-tab-in-view";

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/audience/segments/9b1e7a52",
  useRouter: () => ({ push: () => {} }),
}));

function rect(left: number, right: number) {
  return () => ({ left, right }) as DOMRect;
}
function row(left: number, right: number, scrollLeft: number) {
  return { scrollLeft, getBoundingClientRect: rect(left, right) } as unknown as Element;
}
function tab(left: number, right: number) {
  return { getBoundingClientRect: rect(left, right) } as unknown as Element;
}

describe("revealInRow", () => {
  it("scrolls right just far enough when the tab hangs past the row's right edge", () => {
    const r = row(0, 300, 40);
    revealInRow(r, tab(280, 360));
    expect(r.scrollLeft).toBe(100);
  });

  it("scrolls left when the tab is cut off at the left edge", () => {
    const r = row(0, 300, 120);
    revealInRow(r, tab(-30, 50));
    expect(r.scrollLeft).toBe(90);
  });

  it("leaves the row alone when the tab is already in view", () => {
    const r = row(0, 300, 75);
    revealInRow(r, tab(10, 90));
    expect(r.scrollLeft).toBe(75);
  });
});

describe("AudienceTabs", () => {
  it("renders one active button (longest matching prefix) inside an ms-tabs row", () => {
    const html = renderToStaticMarkup(createElement(AudienceTabs));
    expect(html).toContain('class="ms-tabs"');
    expect(html.match(/class="active"/g)).toHaveLength(1);
    expect(html).toMatch(/class="active">segments</);
  });
});
