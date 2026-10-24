// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  skip: Symbol("skipToken"),
  kpis: undefined as unknown,
  teams: undefined as unknown,
}));

// The real English catalog, so the test reads what the operator reads.
vi.mock("next-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-intl")>();
  const messages = { console: (await import("../messages/en/console.json")).default };
  return {
    ...actual,
    useLocale: () => "en",
    useTranslations: (namespace: string) =>
      actual.createTranslator({ locale: "en", messages, namespace: namespace as "console" }),
  };
});
vi.mock("@/lib/trpc", () => {
  const at = (path: string[]): unknown =>
    new Proxy(() => {}, {
      get: (_, key: string) =>
        key.endsWith("Options")
          ? (input?: unknown) => ({ path: path.join("."), input })
          : at([...path, key]),
    });
  return { useTRPC: () => at([]) };
});
vi.mock("@tanstack/react-query", () => ({
  skipToken: h.skip,
  useQuery: (options: { path: string; input: unknown }) => ({
    data:
      options.path === "console.overview.kpis"
        ? h.kpis
        : options.input === h.skip
          ? undefined
          : h.teams,
    isError: false,
  }),
}));

const { LineChart } = await import("@/components/line-chart");
const { KpiChart } = await import("@/components/console/overview/charts");

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // jsdom lays nothing out: the chart reads a width and tracks its own box.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly measured: () => void) {}
      observe() {
        this.measured();
      }
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(760);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Hovers the point at `index` of `n` and returns the tip's text, null without a tip. */
async function hover(index: number, n: number): Promise<HTMLElement | null> {
  const wrap = container.querySelector<HTMLElement>("div[style*='touch-action']");
  const plotEnd = Number(container.querySelector("svg > line")?.getAttribute("x2"));
  if (!wrap || !plotEnd) throw new Error("no chart");
  await act(async () =>
    wrap.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        clientX: (index * plotEnd) / (n - 1),
        clientY: 100,
        pointerType: "mouse",
      }),
    ),
  );
  return (
    [...document.body.children].find(
      (el): el is HTMLElement => el instanceof HTMLElement && el.style.position === "fixed",
    ) ?? null
  );
}

describe("a line chart's hover tip", () => {
  const chart = (tipExtra?: (index: number) => React.ReactNode) =>
    createElement(LineChart, {
      days: ["2026-10-01", "2026-10-02", "2026-10-03"],
      series: [{ key: "s", label: "Sent", color: "var(--ms-steel)", values: [10, 20, 30] }],
      formatDay: (day: string) => day.slice(5),
      formatValue: (v: number) => String(v),
      tipExtra,
    });

  it("adds the caller's lines for the hovered point under its values", async () => {
    const extra = vi.fn((index: number) => createElement("p", { id: "extra" }, `point ${index}`));
    await act(async () => root.render(chart(extra)));
    const tip = await hover(1, 3);
    expect(extra).toHaveBeenLastCalledWith(1);
    expect(tip?.textContent).toBe("10-02Sent20point 1");
    expect(tip?.lastElementChild?.id).toBe("extra");
  });

  it("is the date and the values alone without them", async () => {
    await act(async () => root.render(chart()));
    expect((await hover(2, 3))?.textContent).toBe("10-03Sent30");
  });
});

describe("a feedback chart's tip", () => {
  const points = ["2026-10-21", "2026-10-22", "2026-10-23"].map((t) => ({
    t,
    sent: 10_000,
    delivered: 9_900,
    bounced: 20,
    hardBounced: 10,
    complained: t === "2026-10-22" ? 9 : 0,
  }));
  const totals = { sent: 30_000, delivered: 29_700, bounced: 60, hardBounced: 30, complained: 9 };
  h.kpis = { grain: "day", points, totals, previous: totals };
  h.teams = {
    grain: "day",
    teams: 7,
    total: 1_239,
    rows: [],
    buckets: [
      {
        t: "2026-10-22",
        top: [
          { name: "Acme", count: 3 },
          { name: "Example Team", count: 2 },
          { name: "Globex", count: 1 },
          { name: "Initech", count: 1 },
          { name: "Umbrella", count: 1 },
        ],
        moreTeams: 2,
        moreCount: 1_231,
      },
    ],
  };
  const lines = (tip: HTMLElement | null) =>
    [...(tip?.children ?? [])]
      .slice(2)
      .flatMap((el) =>
        [...el.children].map((line) =>
          [...line.children].length > 0
            ? [...line.children].map((cell) => cell.textContent)
            : line.textContent,
        ),
      );

  it("lists the point's teams under its rate, then what the rest add up to", async () => {
    await act(async () =>
      root.render(createElement(KpiChart, { kind: "complained", period: "7d" })),
    );
    const tip = await hover(1, 3);
    expect(tip?.children[1]?.textContent).toBe("Complaints0.090%");
    expect(lines(tip)).toEqual([
      ["Acme", "3"],
      ["Example Team", "2"],
      ["Globex", "1"],
      ["Initech", "1"],
      ["Umbrella", "1"],
      "+2 more teams · 1,231",
    ]);
  });

  it("adds nothing on a point no team drew one on, nor to a chart that is not feedback", async () => {
    await act(async () =>
      root.render(createElement(KpiChart, { kind: "complained", period: "7d" })),
    );
    expect((await hover(0, 3))?.children).toHaveLength(2);
    await act(async () => root.render(createElement(KpiChart, { kind: "sent", period: "7d" })));
    expect((await hover(1, 3))?.children).toHaveLength(2);
  });
});
