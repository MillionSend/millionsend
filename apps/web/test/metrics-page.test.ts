// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const data = vi.hoisted(() => ({ window: undefined as unknown, health: undefined as unknown }));

// The real English catalogs, so the test reads what the cards show.
vi.mock("next-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-intl")>();
  const messages = {
    metrics: (await import("../messages/en/metrics.json")).default,
    emails: (await import("../messages/en/emails.json")).default,
    common: (await import("../messages/en/common.json")).default,
  };
  return {
    ...actual,
    useLocale: () => "en",
    useTranslations: (namespace: string) =>
      actual.createTranslator({ locale: "en", messages, namespace: namespace as "metrics" }),
  };
});
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
// Every trpc helper answers with the procedure's path, so useQuery can tell them apart.
vi.mock("@/lib/trpc", () => {
  const at = (path: string[]): unknown =>
    new Proxy(() => ({ path: path.join(".") }), {
      get: (_target, key: string) => at([...path, key]),
      apply: () => ({ path: path.slice(0, -1).join(".") }),
    });
  return { useTRPC: () => at([]) };
});
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { path: string }) => ({
    data:
      options.path === "metrics.window"
        ? data.window
        : options.path === "metrics.health"
          ? data.health
          : undefined,
  }),
}));

const { default: MetricsPage } = await import("@/app/(dashboard)/metrics/page");

const DAYS = ["2026-10-16", "2026-10-17", "2026-10-18"];
const COUNTS = { accepted: 0, delivered: 0, bounced: 0, hardBounced: 0, opened: 0 };
const ZERO = { ...COUNTS, sent: 0, complained: 0, clicked: 0, prefetched: 0 };

type ComplaintDay = { day: string; complaintSent: number; complained: number };
const COMPLAINT_DAYS: ComplaintDay[] = [
  { day: DAYS[0] ?? "", complaintSent: 2_000, complained: 1 },
  { day: DAYS[1] ?? "", complaintSent: 4_000, complained: 1 },
  { day: DAYS[2] ?? "", complaintSent: 4_000, complained: 0 },
];
// Oct 13's mail all went to inboxes that never report spam, yet drew a complaint.
const LATE_DAYS: ComplaintDay[] = [
  { day: "2026-10-12", complaintSent: 2_000, complained: 1 },
  { day: "2026-10-13", complaintSent: 0, complained: 1 },
  { day: "2026-10-14", complaintSent: 5_000, complained: 1 },
  { day: "2026-10-15", complaintSent: 0, complained: 0 },
  { day: "2026-10-16", complaintSent: 3_000, complained: 0 },
];

function load(
  health: { complaintRate: number; complaintSent: number },
  complaintDays: ComplaintDay[] = COMPLAINT_DAYS,
): void {
  const sum = (key: "complaintSent" | "complained") =>
    complaintDays.reduce((acc, d) => acc + d[key], 0);
  data.window = {
    // The viewer's days, every one with 5,000 sends and a complaint.
    days: DAYS.map((day) => ({ ...ZERO, day, sent: 5_000, delivered: 5_000, complained: 1 })),
    totals: { ...ZERO, sent: 15_000, delivered: 15_000, complained: 3 },
    allTimeDelivered: 15_000,
    liftedHardBounced: 0,
    today: DAYS[2],
    complaints: {
      days: complaintDays,
      sent: 25_000,
      complaintSent: sum("complaintSent"),
      complained: sum("complained"),
      today: complaintDays.at(-1)?.day,
    },
  };
  data.health = { status: "ok", reasons: [], bounceRate: 0, sent: 25_000, ...health };
}

function render(
  health: { complaintRate: number; complaintSent: number },
  complaintDays?: ComplaintDay[],
): string {
  load(health, complaintDays);
  return renderToStaticMarkup(createElement(MetricsPage));
}

/** The markup of the KPI card that carries `label`. */
function card(html: string, label: string): string {
  const found = html.split('class="ms-kpi-card"').find((part) => part.includes(`>${label}<`));
  if (!found) throw new Error(`no card labelled ${label}`);
  return found;
}

describe("the complaint card", () => {
  it("draws each UTC day over its sends that could draw a complaint, as its headline does", () => {
    const complaints = card(
      render({ complaintRate: 0.0004, complaintSent: 5_000 }),
      "Complaint rate",
    );
    expect(complaints).toContain(">last 7 UTC days, by send date<");
    expect(complaints).toContain(">0.04%<");
    // 1 in 2,000 sits on the 0.05% line, 1 in 4,000 halfway; over every send
    // (1 in 5,000) the first would stand at 42px.
    const heights = [...complaints.matchAll(/height:(\d+)px;background:var\(--ms-warn\)/g)].map(
      (m) => Number(m[1]),
    );
    expect(heights).toEqual([106, 53, 2]);
    // The window's rate: 2 complaints over 10,000 sends that could draw one.
    expect(complaints).toMatch(/>Complained<.*?>2<.*?>0\.02%</s);
    // What the rate leaves out says so, and how much of the mail it is.
    expect(complaints).toMatch(/report spam<.*?>not counted<.*?>15,000<.*?>60\.0%</s);
  });

  it("has no rate while nothing sent could draw a complaint, whatever went to Gmail", () => {
    const complaints = card(render({ complaintRate: 0, complaintSent: 0 }), "Complaint rate");
    expect(complaints).toMatch(/Complaint rate<\/div>.*?ms-digits[^>]*>—</s);
  });

  it("draws the newest days that sent mail lighter while complaints about it arrive", () => {
    const complaints = card(
      render({ complaintRate: 0.0002, complaintSent: 8_000 }, LATE_DAYS),
      "Complaint rate",
    );
    const bars = [
      ...complaints.matchAll(/height:(\d+)px;background:var\(--ms-warn\);opacity:([\d.]+)/g),
    ].map((m) => [Number(m[1]), Number(m[2])]);
    // A day with nothing sent keeps its stub and has nothing left to collect.
    expect(bars).toEqual([
      [106, 0.85],
      [2, 0.85],
      [42, 0.4],
      [2, 0.85],
      [2, 0.4],
    ]);
  });
});

describe("the complaint card's tip", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    // jsdom lays nothing out: the line chart reads a width, the bars a box.
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
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(760);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 500, 120),
    );
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

  /** Hovers the complaint card's bar at `index` and returns the tip's two lines. */
  async function hover(index: number): Promise<(string | null)[]> {
    const complaints = [...container.querySelectorAll(".ms-kpi-card")].find((el) =>
      el.textContent?.includes("Complaint rate"),
    );
    const area = complaints?.querySelector<HTMLElement>("div[style*='touch-action']");
    if (!area) throw new Error("no complaint bars");
    await act(async () =>
      area.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          clientX: ((index + 0.5) * 500) / LATE_DAYS.length,
          clientY: 60,
          pointerType: "mouse",
        }),
      ),
    );
    const tip = [...document.body.children].find(
      (el): el is HTMLElement => el instanceof HTMLElement && el.style.position === "fixed",
    );
    return [...(tip?.children ?? [])].map((line) => line.textContent);
  }

  it("reads a count, never a rate, on a day nothing went out that could draw one", async () => {
    load({ complaintRate: 0.0002, complaintSent: 8_000 }, LATE_DAYS);
    await act(async () => root.render(createElement(MetricsPage)));
    expect(await hover(1)).toEqual([
      "Oct 13",
      "1 complaint · nothing sent to inboxes that report spam",
    ]);
    expect(await hover(3)).toEqual(["Oct 15", "Nothing sent to inboxes that report spam"]);
  });

  it("says complaints are still arriving on the newest days that sent mail", async () => {
    load({ complaintRate: 0.0002, complaintSent: 8_000 }, LATE_DAYS);
    await act(async () => root.render(createElement(MetricsPage)));
    expect(await hover(2)).toEqual([
      "Oct 14 · complaints still arriving",
      "0.02% · 1 of 5,000 to inboxes that report spam",
    ]);
    expect(await hover(0)).toEqual(["Oct 12", "0.05% · 1 of 2,000 to inboxes that report spam"]);
  });
});

describe("the hard-bounce card", () => {
  it("shows what a pause lift left out of the rate, only once there is something", () => {
    const quiet = card(render({ complaintRate: 0, complaintSent: 0 }), "Hard-bounce rate");
    expect(quiet).not.toContain("Left out after review");
    load({ complaintRate: 0, complaintSent: 0 });
    data.window = { ...(data.window as object), liftedHardBounced: 30 };
    const lifted = card(renderToStaticMarkup(createElement(MetricsPage)), "Hard-bounce rate");
    expect(lifted).toMatch(/title="We reviewed these hard bounces with you[^"]*"/);
    // Over the same 15,000 sends the Hard bounced row divides by.
    expect(lifted).toMatch(/>Left out after review<.*?>not counted<.*?>30<.*?>0\.2%</s);
  });
});

describe("the rate cards", () => {
  it("name the risk line with a legend key on the headline's row, clear of the bars", () => {
    const html = render({ complaintRate: 0.0004, complaintSent: 5_000 });
    expect(card(html, "Complaint rate")).toMatch(
      />0\.04%<\/div><span class="ms-chart-key"[^>]*>Risk 0\.05%<\/span>/,
    );
    expect(card(html, "Hard-bounce rate")).toMatch(
      />0\.0%<\/div><span class="ms-chart-key"[^>]*>Risk 4%<\/span>/,
    );
  });
});
