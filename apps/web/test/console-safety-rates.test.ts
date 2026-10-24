import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ locale: "pt-BR" as "en" | "pt-BR" }));

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

const { Rate7d, ReasonLabel, RiskCell } = await import("@/components/console/safety/parts");

const DASH = '<span class="ms-mono" style="color:var(--ms-muted)">—</span>';
const cell = (props: Parameters<typeof Rate7d>[0]) =>
  renderToStaticMarkup(createElement(Rate7d, props));

describe("a Trust & safety 7-day rate", () => {
  it("prints the standing's rate when its window held a send to rate", () => {
    h.locale = "pt-BR";
    expect(cell({ rate: 0.0031, sent: 900, complaintSends: true })).toBe("0,31%");
    expect(cell({ rate: 0, sent: 900 })).toBe("0,00%");
  });

  it("is a dash that says why over a window with nothing to rate, not 0.00%", () => {
    h.locale = "pt-BR";
    expect(cell({ rate: 0, sent: 900, complaintSends: false })).toBe(
      `<span class="tip" data-tip="Nenhum envio nos últimos 7 dias para provedores que repassam reclamações.">${DASH}</span>`,
    );
    h.locale = "en";
    expect(cell({ rate: 0, sent: 0 })).toBe(
      `<span class="tip" data-tip="No sends in the last 7 days.">${DASH}</span>`,
    );
  });

  it("says plainly that nothing was sent, under the complaint rate too", () => {
    h.locale = "en";
    expect(cell({ rate: 0, sent: 0, complaintSends: false })).toBe(
      `<span class="tip" data-tip="No sends in the last 7 days.">${DASH}</span>`,
    );
  });

  it("is a bare dash without a standing", () => {
    expect(cell({ rate: null, sent: 0, complaintSends: false })).toBe(DASH);
  });
});

describe("a Trust & safety list row's other cells", () => {
  it("ends a flag's reason in an ellipsis, its explanation still on hover", () => {
    h.locale = "en";
    const html = renderToStaticMarkup(
      createElement(ReasonLabel, {
        reason: "guardrail",
        detail: { guardrail: "warning", metric: "complaint", rate: 0.0039 },
        truncate: true,
      }),
    );
    expect(html).toBe(
      '<span class="tip" data-tip="The deliverability guardrail turned warning or paused the team on its bounce or complaint rates."><span class="ms-truncate">Complaints 0.39% · guardrail warning</span></span>',
    );
  });

  it("is the muted dash before a team's first sample", () => {
    expect(renderToStaticMarkup(createElement(RiskCell, { risk: null, plan: "starter" }))).toBe(
      DASH,
    );
  });
});
