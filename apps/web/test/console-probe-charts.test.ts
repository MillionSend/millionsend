import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ locale: "en" as "en" | "pt-BR", history: undefined as unknown }));

vi.mock("next-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-intl")>();
  const catalogs = {
    en: { console: (await import("../messages/en/console.json")).default },
    "pt-BR": { console: (await import("../messages/pt-BR/console.json")).default },
  };
  return {
    ...actual,
    useLocale: () => h.locale,
    useTranslations: (namespace: string) =>
      actual.createTranslator({
        locale: h.locale,
        messages: catalogs[h.locale],
        namespace: namespace as "console",
      }),
  };
});
vi.mock("@/lib/trpc", () => {
  const at = (path: string[]): unknown =>
    new Proxy(() => {}, {
      get: (_, key: string) =>
        key.endsWith("Options") ? () => ({ path: path.join(".") }) : at([...path, key]),
    });
  return { useTRPC: () => at([]) };
});
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { path: string }) =>
    options.path === "console.overview.history"
      ? { data: h.history, isError: false }
      : { data: undefined, isError: false },
}));

const { ProbeChart } = await import("@/components/console/overview/charts");
const { StatTiles } = await import("@/components/console/overview/stat-tiles");

const point = (t: string, value: number, readings: number) => ({
  t: new Date(t),
  value,
  ok: true,
  readings,
});
const chart = () =>
  renderToStaticMarkup(
    createElement(ProbeChart, {
      probe: "queue_waiting",
      period: "30d",
      label: "Queue",
      formatValue: (v: number) => String(v),
    }),
  );

describe("a probe chart's note on how its points were folded", () => {
  it("names the highest reading or the average, and the bucket from the period", () => {
    h.locale = "pt-BR";
    h.history = {
      bucketSeconds: 6 * 3_600,
      aggregate: "max",
      points: [point("2026-10-01T00:00:00Z", 8000, 360), point("2026-10-01T06:00:00Z", 2, 360)],
    };
    expect(chart()).toContain("Cada ponto: o maior valor em 6h");
    h.locale = "en";
    h.history = { ...(h.history as object), bucketSeconds: 300, aggregate: "avg" };
    expect(chart()).toContain("Each point: the average over 5 min");
  });

  it("says nothing when every point is a single reading", () => {
    h.locale = "en";
    h.history = {
      bucketSeconds: 24 * 3_600,
      aggregate: "max",
      points: [point("2026-10-01T00:00:00Z", 12, 1), point("2026-10-02T00:00:00Z", 9, 1)],
    };
    expect(chart()).not.toContain("Each point");
  });
});

describe("the stat tiles", () => {
  it("print whole numbers, as the Health card does", () => {
    h.locale = "pt-BR";
    const html = renderToStaticMarkup(
      createElement(StatTiles, {
        summary: {
          teams: { total: 12, free: 8, paid: 3, system: 1, newThisWeek: 2, suspended: 0 },
          contacts: { total: 123_456.333, unsubscribed: 1_000 },
          domains: { verified: 9, pending: 1, failed: 0, total: 10 },
          queue: { waiting: 512.084, quotaHeld: 0, oldestSeconds: 30 },
        } as never,
      }),
    );
    expect(html).toContain(">123.456<");
    expect(html).toContain(">512<");
    expect(html).not.toMatch(/123\.456,|512,084/);
  });
});
