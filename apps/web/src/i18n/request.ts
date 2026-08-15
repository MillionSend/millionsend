import { cookies } from "next/headers";
import { getRequestConfig } from "next-intl/server";

export const LOCALES = ["en", "pt-BR"] as const;
export type AppLocale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: AppLocale = "en";
export const LOCALE_COOKIE = "NEXT_LOCALE";

const NAMESPACES = [
  "common",
  "audience",
  "block-editor",
  "auth",
  "broadcasts",
  "deliverability",
  "nav",
  "emails",
  "bounce-guidance",
  "domains",
  "api-keys",
  "logs",
  "merge-fields",
  "metrics",
  "onboarding",
  "settings",
  "placeholders",
  "templates",
  "webhooks",
] as const;

function isAppLocale(value: string | undefined): value is AppLocale {
  return (LOCALES as readonly string[]).includes(value ?? "");
}

/**
 * Cookie-based locale, no URL prefixes. Messages are namespaced by file:
 * messages/<locale>/<ns>.json → useTranslations("<ns>").
 */
export default getRequestConfig(async () => {
  const store = await cookies();
  const cookieValue = store.get(LOCALE_COOKIE)?.value;
  const locale: AppLocale = isAppLocale(cookieValue) ? cookieValue : DEFAULT_LOCALE;
  const entries = await Promise.all(
    NAMESPACES.map(
      async (ns) => [ns, (await import(`../../messages/${locale}/${ns}.json`)).default] as const,
    ),
  );
  return { locale, messages: Object.fromEntries(entries) };
});
