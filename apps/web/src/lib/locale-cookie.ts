// Client-safe half of the locale plumbing: src/i18n/request.ts reads
// next/headers and cannot be imported from client components, so the cookie
// name and the languages live here and it imports them from here.
export const LOCALES = ["en", "pt-BR"] as const;
export type AppLocale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: AppLocale = "en";
export const LOCALE_COOKIE = "NEXT_LOCALE";
const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function isAppLocale(value: unknown): value is AppLocale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** Remembers the interface language for a year; the caller refreshes the tree so the server re-renders in it. */
export function setLocaleCookie(locale: AppLocale): void {
  // biome-ignore lint/suspicious/noDocumentCookie: Cookie Store API is unavailable in Safari.
  document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=${LOCALE_COOKIE_MAX_AGE}`;
}
