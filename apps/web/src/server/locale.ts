import { cookies } from "next/headers";
import { type AppLocale, DEFAULT_LOCALE, LOCALE_COOKIE, LOCALES } from "../i18n/request";

/**
 * The dashboard locale of the current request, from the NEXT_LOCALE cookie.
 * Outside a request (tests, background jobs) `cookies()` throws — fall back
 * to the default locale.
 */
export async function activeLocale(): Promise<AppLocale> {
  try {
    const value = (await cookies()).get(LOCALE_COOKIE)?.value;
    return (LOCALES as readonly string[]).includes(value ?? "")
      ? (value as AppLocale)
      : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

/**
 * The locale of a bare request, for mail sent from an auth endpoint where
 * next-intl's request scope does not exist: the NEXT_LOCALE cookie the app
 * sets, then Accept-Language. Anything that isn't Portuguese reads English —
 * the email locales mirror the dashboard's launch locales.
 */
export function localeFromRequest(request: Request | undefined): AppLocale {
  const cookie = request?.headers.get("cookie")?.match(/(?:^|;\s*)NEXT_LOCALE=([^;]+)/)?.[1];
  const acceptLanguage = request?.headers.get("accept-language") ?? "";
  for (const candidate of [cookie, ...acceptLanguage.split(",")]) {
    const tag = candidate?.trim().toLowerCase();
    if (!tag) continue;
    if (tag.startsWith("pt")) return "pt-BR";
    if (tag.startsWith("en")) return "en";
  }
  return DEFAULT_LOCALE;
}
