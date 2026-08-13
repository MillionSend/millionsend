/**
 * Locale registry. `source` is the authoring language; `launch` locales ship
 * complete and block release when untranslated; `community` locales are
 * translated via Weblate and may lag behind source.
 */
export const SOURCE_LOCALE = "en" as const;

export const LAUNCH_LOCALES = ["en", "pt-BR"] as const;

export const COMMUNITY_LOCALES = [
  "es",
  "fr",
  "de",
  "it",
  "nl",
  "pl",
  "tr",
  "ru",
  "ja",
  "ko",
  "zh-CN",
  "id",
  "vi",
  "ar",
] as const;

export const ALL_LOCALES = [...LAUNCH_LOCALES, ...COMMUNITY_LOCALES] as const;

export type Locale = (typeof ALL_LOCALES)[number];

export const RTL_LOCALES: readonly Locale[] = ["ar"];

export function isLocale(value: string): value is Locale {
  return (ALL_LOCALES as readonly string[]).includes(value);
}

/**
 * Resolution order: explicit user preference → team default → Accept-Language
 * header → source. Recipient-facing surfaces (hosted unsubscribe pages) skip
 * the first two — the recipient is not our customer.
 */
export function resolveLocale(candidates: ReadonlyArray<string | null | undefined>): Locale {
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (isLocale(candidate)) return candidate;
    // Fall back across region subtags: "pt-PT" → "pt-BR" is wrong, but
    // "de-AT" → "de" is right; only match when the base language is itself
    // a registered locale.
    const base = candidate.split("-")[0];
    if (base && isLocale(base)) return base;
  }
  return SOURCE_LOCALE;
}

/** Parse an Accept-Language header into ordered locale candidates. */
export function parseAcceptLanguage(header: string | null | undefined): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params
        .map((p) => p.trim())
        .find((p) => p.startsWith("q="))
        ?.slice(2);
      return { tag: (tag ?? "").trim(), q: q ? Number.parseFloat(q) : 1 };
    })
    .filter((e) => e.tag.length > 0 && !Number.isNaN(e.q))
    .sort((a, b) => b.q - a.q)
    .map((e) => e.tag);
}
