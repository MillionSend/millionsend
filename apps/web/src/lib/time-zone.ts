/**
 * The runtime's canonical name for an IANA zone, or null when it is not a
 * zone it knows. Validation by construction: `Intl.supportedValuesOf` lists
 * only ICU's legacy canonicals (Asia/Calcutta, Europe/Kiev), while browsers
 * report current names (Asia/Kolkata, Europe/Kyiv), fixed offsets (Etc/GMT+3)
 * and old aliases (US/Eastern) — all of which the formatter accepts and maps
 * to a name Postgres's tzdata knows too.
 */
export function canonicalTimeZone(tz: string): string | null {
  try {
    return new Intl.DateTimeFormat("en", { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}
