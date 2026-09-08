import { describe, expect, it } from "vitest";
import { pickUnsubscribeLocale, UNSUBSCRIBE_LOCALES } from "@/lib/unsubscribe-locales";

describe("pickUnsubscribeLocale", () => {
  it("takes the browser's first language, exact tag before language alone", () => {
    expect(pickUnsubscribeLocale("pt-BR,pt;q=0.9,en;q=0.8")).toBe("pt-BR");
    expect(pickUnsubscribeLocale("pt-PT,en;q=0.8")).toBe("pt-BR");
    expect(pickUnsubscribeLocale("en-US,en;q=0.9")).toBe("en");
    expect(pickUnsubscribeLocale("PT-br")).toBe("pt-BR");
  });

  it("honours quality values over header order", () => {
    expect(pickUnsubscribeLocale("en;q=0.5,pt-BR;q=0.9")).toBe("pt-BR");
    expect(pickUnsubscribeLocale("pt-BR;q=0,en")).toBe("en");
  });

  it("skips languages the page does not speak and falls back to English", () => {
    expect(pickUnsubscribeLocale("xx-YY,pt-BR;q=0.7")).toBe("pt-BR");
    expect(pickUnsubscribeLocale("*")).toBe("en");
    expect(pickUnsubscribeLocale("")).toBe("en");
    expect(pickUnsubscribeLocale(null)).toBe("en");
  });

  it("names every language in itself", () => {
    for (const [locale, { name }] of Object.entries(UNSUBSCRIBE_LOCALES)) {
      expect(name, locale).not.toBe("");
    }
  });
});
