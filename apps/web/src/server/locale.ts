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
