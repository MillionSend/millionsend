import { DEFAULT_ABUSE_RULES, fromAbuseRules } from "./abuse-rules.js";

/**
 * Brands phishers imitate most, as a team name would write them, from the
 * detection rules (abuse-rules.ts). A team named after one is flagged for
 * the operator, never refused: a real bank can be a customer too. On the
 * shared inbox domain, which every team's mail shares, a name that imitates
 * one is refused instead: a team's subdomain label, a chosen username and a
 * display name. A brand is listed by its usual spelling; matching ignores
 * case, accents, spacing and look-alike letters. The lists: brands
 * (`imitatedBrands`); brands that are everyday words too ("free", "claro"),
 * matched only as a whole name (`imitatedBrandWords`); and words phishers
 * fuse onto a brand, on either side, as digits are ("paypalsupport",
 * "appleid"; `imitatedBrandAffixes`). The exports are the built-in lists.
 */
export const IMITATED_BRANDS: readonly string[] = DEFAULT_ABUSE_RULES.lists.imitatedBrands;
export const IMITATED_BRAND_WORDS: readonly string[] = DEFAULT_ABUSE_RULES.lists.imitatedBrandWords;
export const IMITATED_BRAND_AFFIXES: readonly string[] =
  DEFAULT_ABUSE_RULES.lists.imitatedBrandAffixes;

// ponytail: a hand-picked set of Cyrillic and Greek letters drawn like Latin
// ones; Unicode's confusables data (TR39) if names start dodging it.
const LOOK_ALIKE_FROM = "АВЕКМНОРСТХаеорсухіјѕΑΒΕΖΗΙΚΜΝΟΡΤΥΧοιν";
const LOOK_ALIKE_TO = "ABEKMHOPCTXaeopcyxijsABEZHIKMNOPTYXoiv";

/**
 * The words of a name as written, before the swaps are folded: compatibility
 * forms and accents gone, look-alike letters read as Latin, camelCase split,
 * lowercase.
 */
export function plainWords(text: string): string[] {
  const latin = Array.from(text.normalize("NFKD").replace(/\p{M}/gu, ""), (c) => {
    const i = LOOK_ALIKE_FROM.indexOf(c);
    return i === -1 ? c : LOOK_ALIKE_TO.charAt(i);
  }).join("");
  return latin
    .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * A word with the swaps phishers make folded alike on both sides: 0 and o,
 * 1 and l and i, rn and m, vv and w.
 */
const folded = (word: string): string =>
  word.replaceAll("rn", "m").replaceAll("vv", "w").replaceAll("0", "o").replace(/[1l]/g, "i");

const spell = (text: string) => plainWords(text).map(folded).join("");
const spelled = (brands: readonly string[]) =>
  new Map(brands.map((brand) => [spell(brand), brand]));
const spellings = fromAbuseRules(({ lists }) => ({
  brands: spelled(lists.imitatedBrands),
  wholeName: spelled(lists.imitatedBrandWords),
  affixes: new Set(lists.imitatedBrandAffixes.map(spell)),
}));
const DIGITS = /^[0-9]+$/;

/**
 * The brand `run` fuses with digits or a single affix on either side, or
 * null. Digits are read in `plain`, the run as written, where a letter that
 * folds like one ("metal" reads "metai") never passes for one.
 */
function fusedBrand(run: string, plain: string): string | null {
  const { brands, affixes } = spellings();
  for (const [key, brand] of brands) {
    const n = run.length - key.length;
    if (n <= 0) continue;
    if (
      run.startsWith(key) &&
      (affixes.has(run.slice(key.length)) || DIGITS.test(plain.slice(-n)))
    ) {
      return brand;
    }
    if (run.endsWith(key) && (affixes.has(run.slice(0, n)) || DIGITS.test(plain.slice(0, n)))) {
      return brand;
    }
  }
  return null;
}

/**
 * The imitated brand a name borrows, or null: consecutive words of the name
 * that together spell a brand ("Pay Pal", "PayPal", "paypal"), alone or fused
 * with digits or one affix ("paypalsupport", "Microsoft365"), or the whole
 * name for a brand that is also an everyday word. `everydayWords: false`
 * leaves those last ones to an identity review, for names a person may well
 * carry ("Tim").
 */
export function imitatedBrandIn(
  name: string,
  opts: { everydayWords?: boolean } = {},
): string | null {
  const words = plainWords(name).map((plain) => ({ plain, folded: folded(plain) }));
  const whole =
    opts.everydayWords === false
      ? undefined
      : spellings().wholeName.get(words.map((w) => w.folded).join(""));
  if (whole) return whole;
  for (let start = 0; start < words.length; start += 1) {
    let run = "";
    let plain = "";
    for (const word of words.slice(start)) {
      run += word.folded;
      plain += word.plain;
      const brand = spellings().brands.get(run) ?? fusedBrand(run, plain);
      if (brand) return brand;
    }
  }
  return null;
}
