import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TeamStatusFields } from "@/components/console/teams/cells";

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

const { TeamStatus } = await import("@/components/console/teams/cells");

const OK: TeamStatusFields = {
  suspendedAt: null,
  suspensionReason: null,
  broadcastsPausedByOperatorAt: null,
  guardrail: null,
  guardrailMetric: null,
  complaintRate7d: null,
  hardBounceRate7d: null,
};
// Noon UTC: the same calendar day in every zone the suite runs in.
const DAY = new Date("2026-01-05T12:00:00Z");

/** The cell's dot tone, its words and the tooltip behind them. */
function status(over: Partial<TeamStatusFields>) {
  const html = renderToStaticMarkup(createElement(TeamStatus, { team: { ...OK, ...over } }));
  return {
    html,
    tone: /class="ms-dot" style="background:var\(--ms-(\w+)\)/.exec(html)?.[1],
    text: html.replace(/<[^>]+>/g, ""),
    tip: /data-tip="([^"]*)"/.exec(html)?.[1],
  };
}

describe("a team's status cell", () => {
  it("reads ok with no standing yet, and no tooltip", () => {
    h.locale = "pt-BR";
    expect(status({})).toMatchObject({ tone: "success", text: "ok", tip: undefined });
    expect(status({ guardrail: "ok" })).toMatchObject({ tone: "success", text: "ok" });
  });

  it("names the guardrail's metric and rate, then its window", () => {
    h.locale = "pt-BR";
    expect(
      status({
        guardrail: "warning",
        guardrailMetric: "complaint",
        complaintRate7d: 0.0031,
        hardBounceRate7d: 0.01,
      }),
    ).toMatchObject({
      tone: "warn",
      text: "em alerta",
      tip: "Reclamações 0,31% · proteção de envio em alerta\nÚltimos 7 dias, contando só os e-mails para provedores que repassam reclamações.",
    });
    expect(
      status({
        guardrail: "paused",
        guardrailMetric: "hard_bounce",
        complaintRate7d: 0,
        hardBounceRate7d: 0.06,
      }),
    ).toMatchObject({
      tone: "danger",
      text: "pausada",
      tip: "Hard bounces 6,00% · pausada pela proteção de envio\nÚltimos 7 dias, sobre todos os envios.",
    });
    expect(status({ guardrail: "warning" }).tip).toBe("Proteção de envio em alerta");
  });

  it("puts the operator's pause before the guardrail, the way out in the tooltip", () => {
    h.locale = "pt-BR";
    expect(status({ guardrail: "warning", broadcastsPausedByOperatorAt: DAY })).toMatchObject({
      tone: "danger",
      text: "pausada",
      tip: "Transmissões pausadas pelo operador\nO transacional segue saindo.",
    });
  });

  it("draws a suspension as a dot, not a badge, with the day and the reason", () => {
    h.locale = "pt-BR";
    const phishing = status({
      suspendedAt: DAY,
      suspensionReason: "phishing",
      broadcastsPausedByOperatorAt: DAY,
    });
    expect(phishing).toMatchObject({
      tone: "danger",
      text: "suspensa",
      tip: "Suspensa em 5 de jan. · Phishing ou malware",
    });
    expect(phishing.html).not.toContain("ms-badge");
    expect(status({ suspendedAt: DAY, suspensionReason: "manual" }).tip).toBe(
      "Suspensa em 5 de jan.",
    );
    h.locale = "en";
    expect(status({ suspendedAt: DAY, suspensionReason: "non_payment" })).toMatchObject({
      text: "suspended",
      tip: "Suspended on Jan 5 · Non-payment",
    });
  });

  it("reads a review hold as in review, ahead of everything else", () => {
    h.locale = "pt-BR";
    expect(
      status({ suspendedAt: DAY, suspensionReason: "review", broadcastsPausedByOperatorAt: DAY }),
    ).toMatchObject({
      tone: "warn",
      text: "em revisão",
      tip: "Aguardando revisão desde 5 de jan.",
    });
    h.locale = "en";
    expect(status({ suspendedAt: DAY, suspensionReason: "review" })).toMatchObject({
      text: "in review",
      tip: "Held for review since Jan 5",
    });
  });
});
