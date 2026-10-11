/**
 * Brands phishers imitate most, as a team name would write them. A team
 * named after one is flagged for the operator, never refused: a real bank
 * can be a customer too. Add a brand by its usual spelling; matching ignores
 * case, accents, spacing and look-alike letters.
 */
export const IMITATED_BRANDS: readonly string[] = [
  "Microsoft",
  "Office 365",
  "Outlook",
  "Hotmail",
  "Google",
  "Gmail",
  "YouTube",
  "Apple",
  "iCloud",
  "Amazon",
  "PayPal",
  "Netflix",
  "Meta",
  "Facebook",
  "Instagram",
  "WhatsApp",
  "DocuSign",
  "Adobe",
  "Dropbox",
  "DHL",
  "FedEx",
  "UPS",
  "Booking.com",
  "Airbnb",
  "Binance",
  "Coinbase",
  "Roblox",
  "MillionSend",
  "Correios",
  "Receita Federal",
  "gov.br",
  "Serasa",
  "Nubank",
  "Itaú",
  "Bradesco",
  "Santander",
  "Caixa",
  "Banco do Brasil",
  "C6 Bank",
  "PicPay",
  "Mercado Livre",
  "Mercado Pago",
  "Shopee",
  "Magalu",
  "Americanas",
  "iFood",
  "Uber",
  "Livelo",
  "LATAM",
  "Detran",
  "INSS",
  "SFR",
  "La Poste",
  "Ameli",
  "Impots",
  "CAF",
];

/**
 * Brands that are everyday words too ("free", "claro", "oi"): a team
 * matches one only when its whole name is that brand.
 */
export const IMITATED_BRAND_WORDS: readonly string[] = [
  "Free",
  "Orange",
  "Prime",
  "Inter",
  "Claro",
  "Azul",
  "Gol",
  "Oi",
  "Sky",
  "Vivo",
  "TIM",
  "99",
];

// ponytail: a hand-picked set of Cyrillic and Greek letters drawn like Latin
// ones; Unicode's confusables data (TR39) if names start dodging it.
const LOOK_ALIKE_FROM = "АВЕКМНОРСТХаеорсухіјѕΑΒΕΖΗΙΚΜΝΟΡΤΥΧοιν";
const LOOK_ALIKE_TO = "ABEKMHOPCTXaeopcyxijsABEZHIKMNOPTYXoiv";

/**
 * Text as the words brand matching compares: compatibility forms and accents
 * gone, look-alike letters read as Latin, camelCase split, lowercase, and the
 * swaps phishers make folded alike on both sides (0 and o, 1 and l and i,
 * rn and m, vv and w).
 */
function brandWords(text: string): string[] {
  const latin = Array.from(text.normalize("NFKD").replace(/\p{M}/gu, ""), (c) => {
    const i = LOOK_ALIKE_FROM.indexOf(c);
    return i === -1 ? c : LOOK_ALIKE_TO.charAt(i);
  }).join("");
  return latin
    .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
    .toLowerCase()
    .replaceAll("rn", "m")
    .replaceAll("vv", "w")
    .replaceAll("0", "o")
    .replace(/[1l]/g, "i")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

const spelled = (brands: readonly string[]) =>
  new Map(brands.map((brand) => [brandWords(brand).join(""), brand]));
const BRANDS = spelled(IMITATED_BRANDS);
const WHOLE_NAME_BRANDS = spelled(IMITATED_BRAND_WORDS);

/**
 * The imitated brand a team name borrows, or null: consecutive words of the
 * name that together spell a brand ("Pay Pal", "PayPal", "paypal"), or the
 * whole name for a brand that is also an everyday word.
 */
export function imitatedBrandIn(name: string): string | null {
  const words = brandWords(name);
  const whole = WHOLE_NAME_BRANDS.get(words.join(""));
  if (whole) return whole;
  for (let start = 0; start < words.length; start += 1) {
    let run = "";
    for (const word of words.slice(start)) {
      run += word;
      const brand = BRANDS.get(run);
      if (brand) return brand;
    }
  }
  return null;
}
