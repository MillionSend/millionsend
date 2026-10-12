import { REAL_NAMES } from "@millionsend/test-utils";
import { describe, expect, it } from "vitest";
import { IMITATED_BRAND_WORDS, IMITATED_BRANDS, imitatedBrandIn } from "../src/imitated-brands.js";

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

  it("leaves names that only contain a brand inside a longer word alone", () => {
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
    ]) {
      expect(imitatedBrandIn(name), name).toBeNull();
    }
  });
});
