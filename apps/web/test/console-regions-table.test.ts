import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ServedRegion } from "@/components/console/region-actions";

const h = vi.hoisted(() => ({ locale: "en" as "en" | "pt-BR" }));

// The real catalogs, so the test reads what the operator reads.
vi.mock("next-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-intl")>();
  const catalogs = {
    en: {
      console: (await import("../messages/en/console.json")).default,
      domains: (await import("../messages/en/domains.json")).default,
      common: (await import("../messages/en/common.json")).default,
    },
    "pt-BR": {
      console: (await import("../messages/pt-BR/console.json")).default,
      domains: (await import("../messages/pt-BR/domains.json")).default,
      common: (await import("../messages/pt-BR/common.json")).default,
    },
  };
  return {
    ...actual,
    useLocale: () => h.locale,
    useTranslations: (namespace: string) =>
      actual.createTranslator({
        locale: h.locale,
        messages: catalogs[h.locale],
        namespace: namespace as keyof (typeof catalogs)["en"],
      }),
  };
});
// A tooltip's text only mounts on hover: the trigger carries it here instead.
vi.mock("@/components/tooltip", () => ({
  Tooltip: ({
    text,
    children,
    triggerClassName,
  }: {
    text: string;
    children: React.ReactNode;
    triggerClassName?: string;
  }) =>
    createElement(
      "span",
      { className: `tip${triggerClassName ? ` ${triggerClassName}` : ""}`, "data-tip": text },
      children,
    ),
}));
vi.mock("@/lib/trpc", () => {
  const at = (): unknown =>
    new Proxy(() => {}, {
      get: (_, key: string) => (key.endsWith("Options") ? () => ({}) : at()),
    });
  return { useTRPC: () => at() };
});
vi.mock("@tanstack/react-query", () => ({
  useMutation: () => ({ mutate: () => {}, isPending: false }),
}));

const { RegionsTable } = await import("@/components/console/overview/regions-table");
const { BroadcastsCell } = await import("@/components/console/regions/region-cells");

const LINES = { sesReview: 0.001, sesPause: 0.005, breaker: 0.004, ours: 0.0008 };

function served(over: Partial<ServedRegion> & { region: string }): ServedRegion {
  return {
    served: true,
    share: 70_000,
    usableReserve: 28_000,
    bulkSent24h: 70_000,
    txSent24h: 5_000,
    room: 0,
    bulkParked: 0,
    waitingBroadcasts: 0,
    lastFinishesAt: null,
    txPeak7d: 0,
    bulkPeak7d: 0,
    status: "serving",
    probedAt: new Date(),
    latencyMs: 40,
    error: null,
    account: {
      sendingEnabled: true,
      productionAccess: true,
      enforcementStatus: "HEALTHY",
      pricingPlan: "NONE",
      quota: { max24h: 100_000, sentLast24h: 75_000, maxSendRate: 14 },
    },
    domainsVerified: 3,
    sent24h: 75_000,
    sesComplaintRate: 0.0002,
    sesComplaintRead: true,
    week: { sent: 500_000, hardBounceRate: 0.001, complaintRate: 0.0003 },
    breaker: null,
    daily: [],
    cost: { sentThisMonth: 300_000, plan: "NONE", centsPer1k: 10.5, cents: 3150, tenants: true },
    ...over,
  };
}

const render = (rows: ServedRegion[]) =>
  renderToStaticMarkup(
    createElement(RegionsTable, {
      list: { served: rows, complaintLines: LINES } as never,
      onChanged: () => {},
    }),
  );
/** Every cell of the table's rows, as raw HTML, row by row. */
const cells = (html: string) =>
  [...html.matchAll(/<tr>(.*?)<\/tr>/gs)]
    .slice(1)
    .map((row) => [...(row[1] ?? "").matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map((c) => c[1] ?? ""));
const text = (cell: string) => cell.replace(/<[^>]+>/g, "");
const tipOf = (cell: string) => /data-tip="([^"]*)"/.exec(cell)?.[1]?.replaceAll("&amp;", "&");

describe("the Overview's regions table", () => {
  it("reads the fine state across its columns, figures right, details in tooltips", () => {
    h.locale = "en";
    const html = render([served({ region: "sa-east-1" })]);
    expect([...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1])).toEqual([
      "Region",
      "Status",
      "24h quota",
      "Broadcasts",
      "SES account",
      "Queue",
      "Bounce 7d",
      "SES complaints",
      "Cost this month",
      "",
    ]);
    expect(html).toContain('class="ms-table nowrap baseline"');
    const [row] = cells(html);
    if (!row) throw new Error("no row");
    expect(row.map(text)).toEqual([
      "🇧🇷 São Paulo",
      "Serving",
      "75%",
      "flowing",
      "healthy",
      "—",
      "0.10%",
      "0.02%",
      "$31.50",
      "",
    ]);
    expect(tipOf(row[0] ?? "")).toBe("sa-east-1");
    expect(tipOf(row[2] ?? "")).toBe(
      "75,000 / 100,000\nBroadcasts 70,000 of 70,000\nTransactional 5,000 (usable reserve 28,000)\nMax rate 14/s",
    );
    expect(row[2]).toContain('class="tip ms-quota-cell"');
    expect(tipOf(row[7] ?? "")).toBe(
      "The rate SES itself measures\nSES reviews from 0.1% and pauses at 0.5%\nOur regional pause: 0.4% · our own 7-day count: 0.030%",
    );
    // Under SES's review line the rate takes no tone.
    expect(row[7]).not.toContain("color:");
    expect(tipOf(row[8] ?? "")).toBe("300,000 sent × $0.105/1k · incl. tenants");
    expect(html).toContain('<td class="right ms-cell-menu" style="width:40px">');
  });

  it("names trouble in a word or two, with the reason one hover away (pt-BR)", () => {
    h.locale = "pt-BR";
    const [paused, probation] = cells(
      render([
        served({
          region: "eu-west-1",
          bulkParked: 250_000,
          waitingBroadcasts: 3,
          sesComplaintRate: 0.0025,
          account: {
            sendingEnabled: true,
            productionAccess: true,
            enforcementStatus: "PROBATION",
            pricingPlan: "NONE",
            quota: { max24h: 100_000, sentLast24h: 99_000, maxSendRate: 14 },
          },
          txSent24h: 29_000,
          breaker: {
            paused: true,
            manualReason: null,
            pausedAt: new Date(),
            reason: {
              metric: "bounce",
              rate: 0.052,
              limit: 0.04,
              windowHours: 24,
              sent: 10_000,
              events: 520,
            },
          },
        }),
        served({ region: "us-east-1", sesComplaintRate: 0.0042 }),
      ]),
    );
    if (!paused || !probation) throw new Error("rows missing");
    expect(paused.map(text).slice(3, 8)).toEqual([
      "pausadas",
      "em análise",
      "250.000",
      "0,10%",
      "0,25%",
    ]);
    expect(tipOf(paused[3] ?? "")).toBe(
      "Pausa automática: bounce de 5,20% em 24h, acima do limite de 4%.\nO transacional segue saindo.",
    );
    // The dot leads, outside the tooltip's trigger, so the dots form a column.
    expect(paused[3]).toMatch(/^<span class="ms-dot" style="background:var\(--ms-danger\)/);
    expect(paused[4]).toMatch(
      /^<span class="ms-dot" style="background:var\(--ms-warn\)[^>]*><\/span><span class="tip"/,
    );
    expect(tipOf(paused[4] ?? "")).toBe(
      "A AWS colocou a conta em análise (probation) nesta região.",
    );
    expect(tipOf(paused[5] ?? "")).toBe("3 transmissões · em espera durante a pausa");
    // Amber from SES's review line, red from our pause line.
    expect(paused[7]).toContain("color:var(--ms-warn)");
    expect(probation[7]).toContain("color:var(--ms-danger)");
    // Past the usable reserve, the transactional fill turns warn.
    expect(paused[2]).toContain("background:var(--ms-warn)");
  });

  it("shows sandbox and unreachable regions with dashes, the GetAccount error on the badge", () => {
    h.locale = "pt-BR";
    const [sandbox, down, shutdown] = cells(
      render([
        served({
          region: "eu-west-1",
          status: "sandbox",
          share: null,
          usableReserve: null,
          sesComplaintRate: null,
          week: null,
          account: {
            sendingEnabled: true,
            productionAccess: false,
            enforcementStatus: "HEALTHY",
            pricingPlan: "NONE",
            quota: { max24h: 200, sentLast24h: 12, maxSendRate: 1 },
          },
          cost: { sentThisMonth: 12, plan: "NONE", centsPer1k: 10, cents: 0, tenants: false },
        }),
        served({
          region: "ap-northeast-1",
          status: "unreachable",
          error: "ThrottlingException",
          account: null,
          sesComplaintRate: null,
          week: null,
          cost: { sentThisMonth: 0, plan: null, centsPer1k: 10, cents: 0, tenants: false },
        }),
        served({
          region: "us-east-1",
          account: {
            sendingEnabled: false,
            productionAccess: true,
            enforcementStatus: "SHUTDOWN",
            pricingPlan: "NONE",
            quota: { max24h: 200_000, sentLast24h: 0, maxSendRate: 50 },
          },
        }),
      ]),
    );
    if (!sandbox || !down || !shutdown) throw new Error("rows missing");
    expect(sandbox.map(text).slice(1, 9)).toEqual([
      "Sandbox",
      "12 / 200",
      "—",
      "saudável",
      "—",
      "—",
      "—",
      "$0",
    ]);
    expect(tipOf(sandbox[2] ?? "")).toBe("12 / 200 · taxa máxima 1/s");
    expect(tipOf(sandbox[8] ?? "")).toBe("12 enviados × $0,10/mil");
    expect(down.map(text).slice(1, 9)).toEqual(["Inacessível", "—", "—", "—", "—", "—", "—", "$0"]);
    expect(tipOf(down[1] ?? "")).toBe("GetAccount falhou: ThrottlingException");
    expect(shutdown[4]).toContain("background:var(--ms-danger)");
    expect(text(shutdown[4] ?? "")).toBe("suspensa");
  });

  it("says when SES's rate can't be read, and that our own count is what the pause watches", () => {
    h.locale = "pt-BR";
    const [unreadable, none] = cells(
      render([
        served({ region: "sa-east-1", sesComplaintRate: null, sesComplaintRead: false }),
        served({ region: "eu-west-1", sesComplaintRate: null, sesComplaintRead: true }),
      ]),
    );
    if (!unreadable || !none) throw new Error("rows missing");
    expect(text(unreadable[7] ?? "")).toBe("—");
    expect(tipOf(unreadable[7] ?? "")).toBe(
      "Não foi possível ler a taxa do SES\nA pausa regional segue nossa medição: 0,030% em 7 dias, limite de 0,08%",
    );
    expect(tipOf(none[7] ?? "")).toBe(
      "O SES ainda não publicou uma taxa para esta região\nA pausa regional segue nossa medição: 0,030% em 7 dias, limite de 0,08%",
    );
  });
});

describe("the Broadcasts cell the Regions page shares", () => {
  it("says why a region is paused: SES's own rate, or the operator's hold", () => {
    h.locale = "en";
    const cell = (region: ServedRegion) =>
      renderToStaticMarkup(createElement(BroadcastsCell, { region }));
    const ses = cell(
      served({
        region: "sa-east-1",
        breaker: {
          paused: true,
          manualReason: null,
          pausedAt: new Date(),
          reason: { metric: "complaint", source: "ses", rate: 0.0042, limit: 0.004 },
        },
      }),
    );
    expect(text(ses)).toBe("paused");
    expect(tipOf(ses)).toBe(
      "Automatic pause: complaints at 0.42% as SES measures them, above the 0.4% limit.\nTransactional mail keeps flowing.",
    );
    const held = cell(
      served({
        region: "sa-east-1",
        breaker: { paused: true, manualReason: "incident", pausedAt: new Date(), reason: null },
      }),
    );
    expect(tipOf(held)).toBe("Paused by the operator: incident\nTransactional mail keeps flowing.");
    // Our own complaint count, judged while SES's rate can't be read.
    const ours = cell(
      served({
        region: "sa-east-1",
        breaker: {
          paused: true,
          manualReason: null,
          pausedAt: new Date(),
          reason: {
            metric: "complaint",
            source: "events",
            rate: 0.0009,
            limit: 0.0008,
            windowHours: 168,
            sent: 10_000,
            events: 9,
          },
        },
      }),
    );
    expect(tipOf(ours)).toBe(
      "Automatic pause: complaint at 0.09% over 7 days, above the 0.08% limit.\nTransactional mail keeps flowing.",
    );
  });
});
