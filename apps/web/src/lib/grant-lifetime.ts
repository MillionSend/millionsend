/**
 * How long an OAuth grant lasts, picked on the consent screen: days from the
 * consent, or null for until the user disconnects it. Listed in the order the
 * screen offers them, the default first.
 */
export const GRANT_LIFETIME_DAYS = { never: null, "1y": 365, "90d": 90, "30d": 30 } as const;

export type GrantLifetime = keyof typeof GRANT_LIFETIME_DAYS;

export function isGrantLifetime(value: unknown): value is GrantLifetime {
  return typeof value === "string" && Object.hasOwn(GRANT_LIFETIME_DAYS, value);
}
