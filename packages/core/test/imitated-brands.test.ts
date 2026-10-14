import { REAL_NAMES } from "@millionsend/test-utils";
import { describe, expect, it } from "vitest";
import {
  IMITATED_BRAND_AFFIXES,
  IMITATED_BRAND_WORDS,
  IMITATED_BRANDS,
  imitatedBrandIn,
} from "../src/imitated-brands.js";

describe("imitatedBrandIn", () => {
  it("finds every listed brand as written, in any case", () => {
    for (const brand of [...IMITATED_BRANDS, ...IMITATED_BRAND_WORDS]) {
      expect(imitatedBrandIn(brand), brand).toBe(brand);
      expect(imitatedBrandIn(brand.toUpperCase()), brand).toBe(brand);
      expect(imitatedBrandIn(brand.toLowerCase()), brand).toBe(brand);
    }
  });

  it("finds a brand on word boundaries, however it is accented, spaced or joined", () => {
    for (const [name, brand] of [
      ["Suporte Itau", "Itaú"],
      ["ITAÚ Unibanco", "Itaú"],
      ["PayPal Support", "PayPal"],
      ["PayPalSupport", "PayPal"],
      ["Pay Pal", "PayPal"],
      ["Mercadolivre Ofertas", "Mercado Livre"],
      ["MercadoLivre", "Mercado Livre"],
      ["Atendimento Banco do Brasil", "Banco do Brasil"],
      ["Portal gov.br", "gov.br"],
      ["GovBR Serviços", "gov.br"],
      ["Office365 Admin", "Office 365"],
      ["Booking.com Partners", "Booking.com"],
      ["Amazon Prime", "Amazon"],
      ["Caixa Tem", "Caixa"],
      ["Impôts Remboursement", "Impots"],
      ["ａｍａｚｏｎ", "Amazon"],
    ] as const) {
      expect(imitatedBrandIn(name), name).toBe(brand);
    }
  });

  it("reads look-alike digits, letters and letter pairs as the letter they imitate", () => {
    for (const [name, brand] of [
      ["PayPa1", "PayPal"],
      ["G00gle Security", "Google"],
      ["App1e ID", "Apple"],
      ["Rnicrosoft Account", "Microsoft"],
      ["Arnazon", "Amazon"],
      ["Vvhatsapp", "WhatsApp"],
      ["0utl00k Team", "Outlook"],
      ["Netf1ix", "Netflix"],
      ["РayРal", "PayPal"],
      ["Аpple", "Apple"],
      ["ΜΙCROSOFT", "Microsoft"],
    ] as const) {
      expect(imitatedBrandIn(name), name).toBe(brand);
    }
  });

  it("finds a brand fused into one word with digits or one affix, on either side", () => {
    for (const [name, brand] of [
      ["Microsoft365", "Microsoft"],
      ["365microsoft", "Microsoft"],
      ["paypalsupport", "PayPal"],
      ["PAYPALSUPPORT", "PayPal"],
      ["paypal1", "PayPal"],
      ["appleid", "Apple"],
      ["itausuporte", "Itaú"],
      ["suportenubank", "Nubank"],
      ["g00glelogin", "Google"],
      ["Atendimento Caixaapp", "Caixa"],
    ] as const) {
      expect(imitatedBrandIn(name), name).toBe(brand);
    }
    for (const brand of IMITATED_BRANDS) {
      const word = brand.replace(/[^\p{L}\p{N}]/gu, "");
      for (const name of [`${word}support`, `suporte${word}`, `${word}2024`, `24${word}`]) {
        expect(imitatedBrandIn(name), name).toBe(brand);
      }
    }
    expect(IMITATED_BRAND_AFFIXES).toContain("support");
  });

  it("matches a brand that is an everyday word only as the whole name", () => {
    for (const [name, brand] of [
      ["Claro", "Claro"],
      ["claro!", "Claro"],
      ["0i", "Oi"],
      ["T.I.M.", "TIM"],
      ["99", "99"],
      ["Prime", "Prime"],
    ] as const) {
      expect(imitatedBrandIn(name), name).toBe(brand);
    }
    for (const name of [
      "Claro Consultoria",
      "Céu Azul Turismo",
      "Inter Escola de Idiomas",
      "Acme Prime",
      "Gol de Placa",
      "Oi Pet Shop",
      "Free Flow Studio",
      "Sky High",
      "Viva Vivo",
      "99 Problemas",
    ]) {
      expect(imitatedBrandIn(name), name).toBeNull();
    }
  });

  it("leaves everyday-word brands to the review when asked, never the others", () => {
    for (const brand of IMITATED_BRAND_WORDS) {
      expect(imitatedBrandIn(brand, { everydayWords: false }), brand).toBeNull();
    }
    expect(imitatedBrandIn("tim", { everydayWords: false })).toBeNull();
    expect(imitatedBrandIn("PayPal", { everydayWords: false })).toBe("PayPal");
    expect(imitatedBrandIn("paypalsupport", { everydayWords: false })).toBe("PayPal");
  });

  it("leaves a brand inside a longer word alone, unless all it is fused to is digits or one affix", () => {
    for (const name of [
      ...REAL_NAMES,
      "Acme",
      "Studio 54",
      "Caixote",
      "Uberlândia Imóveis",
      "Applebee's",
      "Metamorfose",
      "Googleplex Fans",
      "Correio da Manhã",
      "Santanderino",
      "Upstream Labs",
      "Nimbra Cloud",
      "Kora",
      "Metal Works",
      "Caixão Antigo",
      "Oups Studio",
      "Amazonas Turismo",
      "Startups",
      "Uberaba",
      "Upsell",
    ]) {
      expect(imitatedBrandIn(name), name).toBeNull();
    }
  });
});
