import de from "../../messages/unsubscribe/de.json";
import en from "../../messages/unsubscribe/en.json";
import es from "../../messages/unsubscribe/es.json";
import fr from "../../messages/unsubscribe/fr.json";
import id from "../../messages/unsubscribe/id.json";
import it from "../../messages/unsubscribe/it.json";
import ja from "../../messages/unsubscribe/ja.json";
import ko from "../../messages/unsubscribe/ko.json";
import nl from "../../messages/unsubscribe/nl.json";
import pl from "../../messages/unsubscribe/pl.json";
import ptBR from "../../messages/unsubscribe/pt-BR.json";
import ru from "../../messages/unsubscribe/ru.json";
import tr from "../../messages/unsubscribe/tr.json";
import zh from "../../messages/unsubscribe/zh.json";

/** Recipient-facing catalog shape; every locale's file carries these keys (i18n-parity test). */
export type UnsubscribeMessages = typeof en;

/**
 * The languages the hosted unsubscribe page speaks, each named in itself for
 * the preview's picker. Recipients are not dashboard users, so this list
 * grows apart from the dashboard's locales.
 */
export const UNSUBSCRIBE_LOCALES = {
  en: { name: "English", messages: en },
  "pt-BR": { name: "Português (Brasil)", messages: ptBR },
  es: { name: "Español", messages: es },
  fr: { name: "Français", messages: fr },
  de: { name: "Deutsch", messages: de },
  it: { name: "Italiano", messages: it },
  nl: { name: "Nederlands", messages: nl },
  pl: { name: "Polski", messages: pl },
  tr: { name: "Türkçe", messages: tr },
  ru: { name: "Русский", messages: ru },
  id: { name: "Bahasa Indonesia", messages: id },
  ja: { name: "日本語", messages: ja },
  ko: { name: "한국어", messages: ko },
  zh: { name: "中文（简体）", messages: zh },
} as const satisfies Record<string, { name: string; messages: UnsubscribeMessages }>;

export type UnsubscribeLocale = keyof typeof UNSUBSCRIBE_LOCALES;

export const DEFAULT_UNSUBSCRIBE_LOCALE: UnsubscribeLocale = "en";

const LOCALE_TAGS = Object.keys(UNSUBSCRIBE_LOCALES) as UnsubscribeLocale[];

/**
 * The page's locale for an Accept-Language header: tags in the order the
 * browser ranks them, an exact match first ("pt-BR"), then the language alone
 * ("pt" → "pt-BR", "zh-TW" → "zh"); English when nothing matches.
 */
export function pickUnsubscribeLocale(
  acceptLanguage: string | null | undefined,
): UnsubscribeLocale {
  const ranked = (acceptLanguage ?? "")
    .split(",")
    .map((part, index) => {
      const [tag = "", ...params] = part.trim().toLowerCase().split(";");
      const quality = Number(
        params
          .map((p) => p.trim())
          .find((p) => p.startsWith("q="))
          ?.slice(2),
      );
      return { tag: tag.trim(), q: Number.isFinite(quality) ? quality : 1, index };
    })
    .filter((entry) => entry.tag !== "" && entry.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  for (const { tag } of ranked) {
    const exact = LOCALE_TAGS.find((locale) => locale.toLowerCase() === tag);
    if (exact) return exact;
    const language = tag.split("-")[0];
    const byLanguage = LOCALE_TAGS.find(
      (locale) => locale.toLowerCase().split("-")[0] === language,
    );
    if (byLanguage) return byLanguage;
  }
  return DEFAULT_UNSUBSCRIBE_LOCALE;
}
