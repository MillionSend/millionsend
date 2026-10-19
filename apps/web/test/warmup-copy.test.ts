import { createTranslator } from "next-intl";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import enBroadcasts from "../messages/en/broadcasts.json";
import enDeliverability from "../messages/en/deliverability.json";
import enWarmup from "../messages/en/warmup.json";
import ptBroadcasts from "../messages/pt-BR/broadcasts.json";
import ptWarmup from "../messages/pt-BR/warmup.json";

// The real English catalogs, so the test reads what a customer reads.
vi.mock("next-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-intl")>();
  const messages = {
    broadcasts: (await import("../messages/en/broadcasts.json")).default,
    deliverability: (await import("../messages/en/deliverability.json")).default,
    warmup: (await import("../messages/en/warmup.json")).default,
  };
  return {
    ...actual,
    useLocale: () => "en",
    useTranslations: (namespace: keyof typeof messages) =>
      actual.createTranslator({ locale: "en", messages, namespace }),
  };
});

const { SendPlanSummary } = await import("@/app/(dashboard)/broadcasts/parts");
type SendPlanWarmup = import("@/app/(dashboard)/broadcasts/parts").SendPlanWarmup;

const NOW = new Date("2026-10-18T09:00:00Z");

function offer(firstDay: string, over: Partial<SendPlanWarmup> = {}): SendPlanWarmup {
  return {
    status: "off",
    domain: "news.example.com",
    bestDay: 0,
    eligible: 9_000,
    inactive: 0,
    inactiveSince: new Date("2026-07-20T12:00:00Z"),
    skipInactive: true,
    risky: true,
    plan: { perDay: [{ day: firstDay, count: 1_500 }], days: 1, finishesAt: null },
    blocked: false,
    horizonDays: 24,
    ...over,
  };
}

const dialog = (warmup: SendPlanWarmup, scheduled = false) =>
  renderToStaticMarkup(
    createElement(SendPlanSummary, {
      count: 9_000,
      estimate: null,
      cloud: true,
      locale: "en",
      now: NOW,
      warmup,
      scheduled,
    }),
  ).replaceAll("&#x27;", "'");

describe("the send dialog's warm-up copy", () => {
  it("names the day a scheduled send's warm-up starts, and today only when it is today", () => {
    expect(dialog(offer("2026-10-18"))).toContain("1,500 today, then about 1.5× a day");
    const later = dialog(offer("2026-10-23"), true);
    expect(later).toContain("1,500 on Fri, Oct 23, then about 1.5× a day");
    expect(later).not.toContain("today");
  });

  it("counts a best day of one in the singular, and refuses a long warm-up in the one shared words", () => {
    expect(dialog(offer("2026-10-18", { bestDay: 1 }))).toContain(
      "news.example.com has never sent more than 1 email in a day.",
    );
    expect(
      dialog(offer("2026-10-18", { status: "warming", risky: false, blocked: true })),
    ).toContain("At this warm-up's pace this broadcast needs more than 24 days.");
  });
});

describe("warm-up counts in both languages", () => {
  const en = (namespace: "broadcasts" | "warmup") =>
    createTranslator({
      locale: "en",
      messages: { broadcasts: enBroadcasts, warmup: enWarmup, deliverability: enDeliverability },
      namespace,
    });
  const pt = (namespace: "broadcasts" | "warmup") =>
    createTranslator({
      locale: "pt-BR",
      messages: { broadcasts: ptBroadcasts, warmup: ptWarmup },
      namespace,
    });

  it("say none, one and many apart", () => {
    expect(en("warmup")("settings.inactiveHint", { inactive: 0, total: "2,000" })).toBe(
      "None of your 2,000 contacts has gone 90+ days without activity.",
    );
    expect(en("warmup")("off.previewSkipped", { inactive: 1 })).toBe(
      "1 with no activity in 90+ days is skipped.",
    );
    expect(en("warmup")("off.previewLast", { inactive: 2_000 })).toBe(
      "2,000 with no activity in 90+ days go last.",
    );
    expect(pt("broadcasts")("detail.warmupOrderSkipped", { skipped: 1 })).toBe(
      "os mais ativos primeiro · 1 inativo de fora",
    );
    expect(pt("broadcasts")("detail.warmupOrderSkipped", { skipped: 1_200 })).toBe(
      "os mais ativos primeiro · 1.200 inativos de fora",
    );
  });
});
