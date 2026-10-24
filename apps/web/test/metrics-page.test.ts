import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

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

function render(health: { complaintRate: number; complaintSent: number }): string {
  data.window = {
    // The viewer's days, every one with 5,000 sends and a complaint.
    days: DAYS.map((day) => ({ ...ZERO, day, sent: 5_000, delivered: 5_000, complained: 1 })),
    totals: { ...ZERO, sent: 15_000, delivered: 15_000, complained: 3 },
    allTimeDelivered: 15_000,
    today: DAYS[2],
    complaints: {
      days: [
        { day: DAYS[0], complaintSent: 2_000, complained: 1 },
        { day: DAYS[1], complaintSent: 4_000, complained: 1 },
        { day: DAYS[2], complaintSent: 4_000, complained: 0 },
      ],
      sent: 25_000,
      complaintSent: 10_000,
      complained: 2,
      today: DAYS[2],
    },
  };
  data.health = { status: "ok", reasons: [], bounceRate: 0, sent: 25_000, ...health };
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
    expect(complaints).toContain(">last 7 UTC days<");
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
