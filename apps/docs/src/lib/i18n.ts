import { defineI18n } from "fumadocs-core/i18n";

/**
 * English is the source of truth and stays unprefixed (/quickstart); pt-BR
 * lives under /pt-BR/*. Pages without a pt-BR file fall back to the English
 * content on the pt-BR route (loader default: fallbackLanguage = defaultLanguage).
 */
export const i18n = defineI18n({
  defaultLanguage: "en",
  languages: ["en", "pt-BR"],
  hideLocale: "default-locale",
});

export function isLocale(value: string | undefined): value is (typeof i18n.languages)[number] {
  return value !== undefined && (i18n.languages as readonly string[]).includes(value);
}
