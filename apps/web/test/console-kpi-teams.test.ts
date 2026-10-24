import type { inferRouterOutputs } from "@trpc/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { formatHourMinute } from "@/lib/console-format";
import { formatDayTime } from "@/lib/format";
import type { AppRouter } from "@/server/routers";

type Row = inferRouterOutputs<AppRouter>["console"]["overview"]["kpiTeams"]["rows"][number];

const h = vi.hoisted(() => ({
  locale: "pt-BR" as "en" | "pt-BR",
  kpis: undefined as unknown,
  teams: { data: undefined as unknown, isError: false },
}));

// The real catalogs, so the test reads what the operator reads.
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
// A tooltip's text only mounts on hover: the trigger carries it here instead.
vi.mock("@/components/tooltip", () => ({
  Tooltip: ({ text, children }: { text: string; children: React.ReactNode }) =>
    createElement("span", { className: "tip", "data-tip": text }, children),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock("@/lib/trpc", () => {
  const at = (path: string[]): unknown =>
    new Proxy(() => {}, {
      get: (_, key: string) =>
        key.endsWith("Options") ? () => ({ path: path.join(".") }) : at([...path, key]),
    });
  return { useTRPC: () => at([]) };
});
vi.mock("@tanstack/react-query", () => ({
  skipToken: Symbol("skipToken"),
  useQuery: (options: { path: string }) =>
    options.path === "console.overview.kpiTeams"
      ? { ...h.teams, refetch: () => {} }
      : { data: options.path === "console.overview.kpis" ? h.kpis : undefined, isError: false },
}));

const { KpiTeams } = await import("@/components/console/overview/kpi-teams");
const { KpiChart } = await import("@/components/console/overview/charts");

const ROW: Omit<Row, "id" | "name" | "sent" | "count" | "rate"> = {
  logoUrl: null,
  plan: "starter",
  planQuota: null,
  // Noon UTC: the same calendar day in every zone the suite runs in.
  createdAt: new Date("2026-01-02T12:00:00Z"),
  suspendedAt: null,
  suspensionReason: null,
  broadcastsPausedByOperatorAt: null,
  guardrail: "ok",
  guardrailMetric: null,
  complaintRate7d: 0,
  hardBounceRate7d: 0,
  lastAt: "2026-01-12",
};
const row = (over: Partial<Row> & Pick<Row, "id" | "name" | "sent" | "count">): Row => ({
  ...ROW,
  rate: over.sent >= over.count && over.sent > 0 ? over.count / over.sent : null,
  ...over,
});

const COMPLAINTS = [
  row({
    id: "a",
    name: "Acme",
    sent: 2000,
    count: 3,
    guardrail: "warning",
    guardrailMetric: "complaint",
    complaintRate7d: 0.0031,
  }),
  row({
    id: "b",
    name: "Example Team",
    plan: "pro",
    sent: 0,
    count: 4,
    suspendedAt: new Date("2026-01-05T12:00:00Z"),
    suspensionReason: "reputation",
    lastAt: "2026-01-13",
  }),
  row({ id: "c", name: "Initech", sent: 1, count: 2 }),
  row({
    id: "d",
    name: "Umbrella",
    sent: 400,
    count: 1,
    suspendedAt: new Date("2026-01-14T12:00:00Z"),
    suspensionReason: "review",
  }),
];

function render(kind: "hardBounced" | "complained", data: unknown, isError = false) {
  h.teams = { data, isError };
  return renderToStaticMarkup(createElement(KpiTeams, { kind, period: "7d" }));
}
/** Every body row's cells, as raw HTML. */
const cells = (html: string) =>
  [...(html.split("<tbody>")[1] ?? "").matchAll(/<tr[^>]*>(.*?)<\/tr>/gs)].map((r) =>
    [...(r[1] ?? "").matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map((c) => c[1] ?? ""),
  );
const text = (html: string) => html.replace(/<[^>]+>/g, "");
const tipOf = (cell: string) => /data-tip="([^"]*)"/.exec(cell)?.[1];
const note = (html: string) => text(/<p [^>]*>(.*?)<\/p>/s.exec(html)?.[1] ?? "");

describe("the teams behind a feedback KPI", () => {
  const complaints = { grain: "day", teams: 4, total: 10, rows: COMPLAINTS, buckets: [] };

  it("lays out one baseline list: team, plan, age, status, then the figures", () => {
    h.locale = "pt-BR";
    const html = render("complained", complaints);
    expect(html).toContain('<table class="ms-table nowrap baseline">');
    expect([...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1])).toEqual([
      "Equipe",
      "Tipo",
      "Criada",
      "Situação",
      "Reclamações",
      "Enviados",
      "Taxa",
      "Mais recente",
    ]);
    expect(html).toContain('<th style="width:100%">Equipe</th>');
    const [first] = cells(html);
    expect(first?.map(text)).toEqual([
      "AAcme",
      "Starter",
      "2 de jan.",
      "em alerta",
      "3",
      "2.000",
      "0,150%",
      "12 de jan.",
    ]);
    expect(first?.[0]).toContain('href="/console/safety/a"');
    expect(html).toMatch(/<tr class="hoverable">/);
  });

  it("prints the card's decimals, and a dash where the team sent too little to rate", () => {
    h.locale = "pt-BR";
    const rows = cells(render("complained", complaints));
    expect(rows[1]?.[6]).toContain('<span class="ms-mono" style="color:var(--ms-muted)">—</span>');
    expect(tipOf(rows[1]?.[6] ?? "")).toBe(
      "Nenhum envio no período. As reclamações são de e-mails enviados antes.",
    );
    expect(tipOf(rows[2]?.[6] ?? "")).toBe(
      "Mais reclamações que envios no período. Parte delas é de e-mails enviados antes.",
    );
    const bounces = cells(
      render("hardBounced", {
        ...complaints,
        teams: 1,
        total: 125,
        rows: [row({ id: "e", name: "Globex", sent: 10_000, count: 125 })],
      }),
    );
    expect(bounces[0]?.slice(4, 7).map(text)).toEqual(["125", "10.000", "1,25%"]);
    h.locale = "en";
    expect(tipOf(cells(render("hardBounced", complaints))[1]?.[6] ?? "")).toBe(
      "No sends in the period. These hard bounces are about mail sent earlier.",
    );
  });

  it("draws a suspension as a dot with its reason, and a review hold as in review", () => {
    h.locale = "pt-BR";
    const rows = cells(render("complained", complaints));
    const suspended = rows[1]?.[3] ?? "";
    expect(suspended).toContain('class="ms-dot" style="background:var(--ms-danger)');
    expect(suspended).not.toContain("ms-badge");
    expect(text(suspended)).toBe("suspensa");
    expect(tipOf(suspended)).toBe("Suspensa em 5 de jan. · Reputação de envio");
    expect(text(rows[3]?.[3] ?? "")).toBe("em revisão");
  });

  it("sums the hidden teams under the list, and offers the rest", () => {
    h.locale = "pt-BR";
    expect(note(render("complained", complaints))).toBe("4 equipes · 10 reclamações");
    const nine = Array.from({ length: 9 }, (_, i) =>
      row({ id: `t${i}`, name: `Team ${i}`, sent: 1000, count: 9 - i }),
    );
    const html = render("hardBounced", { ...complaints, teams: 23, total: 90, rows: nine });
    expect(cells(html)).toHaveLength(7);
    // 9+8+…+3 = 42 shown, so 48 in the other 16 teams.
    expect(note(html)).toBe("7 de 23 equipes · 48 hard bounces nas outras 16 · Mostrar todas");
    h.locale = "en";
    const one = [row({ id: "a", name: "Acme", sent: 1000, count: 3 })];
    expect(note(render("complained", { ...complaints, teams: 2, total: 4, rows: one }))).toBe(
      "1 of 2 teams · 1 complaint in the other one",
    );
    expect(
      note(
        render("complained", { ...complaints, teams: 1, total: 3, rows: COMPLAINTS.slice(0, 1) }),
      ),
    ).toBe("1 team · 3 complaints");
  });

  it("says so when no team drew one, or when the list failed to load", () => {
    h.locale = "pt-BR";
    const empty = render("complained", { ...complaints, teams: 0, total: 0, rows: [] });
    expect(empty).toMatch(
      /<td colspan="8" style="color:var\(--ms-muted\);padding:18px 12px">0 reclamações no período\.<\/td>/i,
    );
    expect(empty).not.toContain("<p ");
    const failed = render("complained", undefined, true);
    expect(text(cells(failed)[0]?.[0] ?? "")).toBe(
      "Não foi possível carregar esta tela. Tentar de novo",
    );
    expect(failed).toContain('<button type="button" class="ms-link"');
  });

  it("loads as three skeleton rows with no footer", () => {
    h.locale = "pt-BR";
    const html = render("complained", undefined);
    expect(cells(html)).toHaveLength(3);
    expect(html).toContain("ms-skeleton");
    expect(html).not.toContain("<p ");
  });

  it("prints the hour on a day's window, with the day for yesterday's hours", () => {
    h.locale = "pt-BR";
    const today = new Date();
    today.setMinutes(0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    const rows = cells(
      render("complained", {
        ...complaints,
        grain: "hour",
        rows: [
          row({ id: "a", name: "Acme", sent: 50, count: 1, lastAt: today.toISOString() }),
          row({ id: "b", name: "Globex", sent: 50, count: 1, lastAt: yesterday.toISOString() }),
        ],
      }),
    );
    expect(rows[0]?.[7]).toBe(formatHourMinute(today, "pt-BR"));
    expect(rows[0]?.[7]).toMatch(/^\d{2}:\d{2}$/);
    expect(rows[1]?.[7]).toBe(formatDayTime(yesterday, "pt-BR"));
  });
});

describe("the feedback charts' note", () => {
  it("says the counters take the day the feedback arrives", () => {
    const counts = { sent: 100_000, delivered: 0, bounced: 0, hardBounced: 0, complained: 7 };
    h.kpis = {
      grain: "day",
      points: [{ t: "2026-01-12", ...counts }],
      totals: counts,
      previous: counts,
    };
    h.locale = "pt-BR";
    const chart = (kind: "sent" | "complained") =>
      note(renderToStaticMarkup(createElement(KpiChart, { kind, period: "7d" })));
    expect(chart("complained")).toBe(
      "Últimos 7 dias · média 0,007% · pela data de chegada, não de envio",
    );
    expect(chart("sent")).toBe("Últimos 7 dias · total 100.000");
  });
});
