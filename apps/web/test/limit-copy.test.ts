import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import type { LimitTranslate } from "@/lib/new-domain-limit";

const root = fileURLToPath(new URL("../messages", import.meta.url));
const load = (locale: string, namespace: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(root, locale, `${namespace}.json`), "utf8"));

/** The copy the new domain limit added or reworded, by namespace. */
const LIMIT_COPY = {
  emails: [
    "list.whenAfter",
    "list.whenAfterDay",
    "list.waitingFor",
    "list.waitingTip",
    "list.limitBanner",
    "detail.sendingDomain",
    "detail.perDayForNow",
    "detail.acceptedAgo",
    "detail.goesOutSoon",
    "detail.goesOutAfter",
    "detail.goesOutOn",
    "detail.limitBanner",
    "detail.pending.newDomainLimit",
    "detail.pending.newDomainLimitUsed",
    "detail.pending.newDomainLimitPoolUsed",
    "detail.pending.newDomainLimitBody",
    "detail.pending.expectedSoon",
    "detail.pending.expectedNext",
    "detail.pending.expectedBody",
    "detail.pending.expectedSoonBody",
    "detail.pending.pacedBody",
  ],
  domains: ["new.sentBefore.yesHint", "list.limit", "detail.bannerVerifiedLimited", "detail.limit"],
  warmup: ["off.previewTail", "pace.note"],
  broadcasts: [
    "guard.reason",
    "guard.limitReason",
    "guard.stepLimitDomain",
    "guard.warmupReason",
    "detail.warmupNote",
    "composer.testQueued",
    "composer.testQueuedLimit",
  ],
  console: [
    "safety.limitRequests",
    "safety.review.warmup.subtitle",
    "safety.review.warmup.request",
    "safety.review.warmup.dialog.requestLifted",
    "safety.review.warmup.dialog.decline",
  ],
} as const;

/** Every message under `path`, keyed by its full path. */
function messages(catalog: Record<string, unknown>, path: string): Record<string, string> {
  const node = path
    .split(".")
    .reduce<unknown>((at, key) => (at as Record<string, unknown>)?.[key], catalog);
  if (typeof node === "string") return { [path]: node };
  if (!node || typeof node !== "object") throw new Error(`missing ${path}`);
  return Object.assign({}, ...Object.keys(node).map((key) => messages(catalog, `${path}.${key}`)));
}

/** The ICU arguments a message reads, including those nested in plural and select branches. */
function icuArgs(message: string): string[] {
  const names = new Set<string>();
  const blocks = (text: string, visit: (inner: string) => void) => {
    let depth = 0;
    let start = 0;
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] === "{") {
        if (depth === 0) start = i + 1;
        depth += 1;
      } else if (text[i] === "}") {
        depth -= 1;
        if (depth === 0) visit(text.slice(start, i));
      }
    }
  };
  const argument = (inner: string) => {
    const match = /^\s*(\w+)\s*(?:,\s*(\w+)\s*,([\s\S]*))?$/.exec(inner);
    if (!match?.[1]) return;
    names.add(match[1]);
    if (match[3] !== undefined) blocks(match[3], (branch) => blocks(branch, argument));
  };
  blocks(message, argument);
  return [...names].sort();
}

describe("the new domain limit's copy", () => {
  const pairs = Object.entries(LIMIT_COPY).flatMap(([namespace, paths]) =>
    paths.flatMap((path) => {
      const en = messages(load("en", namespace), path);
      const pt = messages(load("pt-BR", namespace), path);
      return Object.keys(en).map((key) => ({
        key: `${namespace}.${key}`,
        en: en[key],
        pt: pt[key],
      }));
    }),
  );

  it("reads the same arguments in both languages", () => {
    expect(pairs.length).toBeGreaterThan(80);
    for (const { key, en, pt } of pairs) {
      expect(pt, key).toBeTypeOf("string");
      expect(icuArgs(pt ?? ""), key).toEqual(icuArgs(en ?? ""));
    }
  });

  it("has no semicolons, no em dashes and no mechanics past volumes and dates", () => {
    for (const { key, en, pt } of pairs) {
      for (const text of [en, pt]) {
        expect(text, key).not.toMatch(/[;—]/);
        expect(text, key).not.toMatch(/tier|graduat|degrau|nível/i);
      }
    }
  });

  it("never promises transactional mail goes unheld, which the daily limit does hold", () => {
    for (const locale of ["en", "pt-BR"]) {
      for (const namespace of ["warmup", "broadcasts", "domains", "emails"]) {
        const text = JSON.stringify(load(locale, namespace));
        expect(text).not.toMatch(
          /transactional email is (never|not) held|transaciona(l|is) (nunca|não) fica(m)? (retidos|esperando)/,
        );
      }
    }
    expect(messages(load("en", "warmup"), "pace.note")["pace.note"]).toContain(
      "The warm-up never holds your transactional email.",
    );
    expect(
      messages(load("en", "domains"), "new.sentBefore.yesHint")["new.sentBefore.yesHint"],
    ).toBe(
      "No warm-up. It keeps the reputation it already has. Domains registered in the last 30 days still start with a daily limit.",
    );
  });

  it("names a request's notifications answer alike for the team and the operator", () => {
    for (const locale of ["en", "pt-BR"]) {
      const asked = messages(load(locale, "domains"), "detail.limit.ask.sendsOptions");
      const listed = messages(load(locale, "console"), "safety.limitRequests.sends");
      expect(listed["safety.limitRequests.sends.notifications"], locale).toBe(
        asked["detail.limit.ask.sendsOptions.notifications"],
      );
    }
  });

  it("counts none, one and many apart in both languages", () => {
    const t = (locale: "en" | "pt-BR", namespace: "emails" | "domains") =>
      createTranslator({
        locale,
        messages: { [namespace]: load(locale, namespace) },
        namespace,
      }) as unknown as LimitTranslate;
    const domains = t("en", "domains");
    const dominios = t("pt-BR", "domains");
    expect(domains("detail.limit.waitingHint", { count: 0 })).toBe("nothing is waiting");
    expect(domains("detail.limit.waitingHint", { count: 1 })).toBe("goes out after 00:00 UTC");
    expect(domains("detail.limit.waitingHint", { count: 214 })).toBe("go out after 00:00 UTC");
    expect(dominios("detail.limit.waitingHint", { count: 1 })).toBe("sai depois das 00:00 UTC");
    expect(dominios("detail.limit.waitingHint", { count: 2 })).toBe("saem depois das 00:00 UTC");
    expect(domains("detail.limit.noLimitHint", { days: 1 })).toBe("in 1 day, or sooner");
    expect(dominios("detail.limit.noLimitHint", { days: 27 })).toBe("em 27 dias, ou antes");
    expect(dominios("detail.limit.registered", { days: 1 })).toBe("Registrado há 1 dia");
    expect(dominios("detail.limit.waitingTitle", { count: 1 })).toBe("1 e-mail esperando.");
    expect(dominios("detail.limit.waitingTitle", { count: 2_000 })).toBe(
      "2.000 e-mails esperando.",
    );
    const emails = t("en", "emails");
    const emailsPt = t("pt-BR", "emails");
    const body = (ahead: number) =>
      emails("detail.pending.newDomainLimitBody", { domain: "nova.example", ahead });
    expect(body(0)).toBe("nova.example is a new domain. Nothing is ahead of this one.");
    expect(body(1)).toBe("nova.example is a new domain. 1 email is ahead of this one.");
    expect(body(1_200)).toBe("nova.example is a new domain. 1,200 emails are ahead of this one.");
    expect(
      emailsPt("detail.pending.newDomainLimitBody", { domain: "nova.example", ahead: 1 }),
    ).toBe("nova.example é um domínio novo. 1 e-mail está na frente deste.");
    expect(emailsPt("list.limitBanner.title", { count: 1, domain: "nova.example" })).toBe(
      "1 e-mail está esperando o limite diário de nova.example.",
    );
  });
});
