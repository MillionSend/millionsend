import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("next-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-intl")>();
  const messages = { console: (await import("../messages/en/console.json")).default };
  return {
    ...actual,
    useTranslations: (namespace: string) =>
      actual.createTranslator({ locale: "en", messages, namespace: namespace as "console" }),
  };
});

const { PeriodBar } = await import("@/components/console/chart-dialog");

it("draws its buttons at 12px: the inherited font first, its own size after", () => {
  const html = renderToStaticMarkup(createElement(PeriodBar, { value: "7d", onChange: () => {} }));
  const styles = [...html.matchAll(/<button type="button" style="([^"]*)"/g)].map((m) => m[1]);
  expect(styles).toHaveLength(5);
  for (const style of styles) expect(style).toMatch(/^font:inherit;.*;font-size:12px;/);
});
