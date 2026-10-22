import { parsePropertyDate } from "./property-date.js";

/**
 * Bounds on a contact's free-form properties map, shared by the public API
 * and the dashboard so both boundaries reject the same payloads: the map is
 * a jsonb column expanded per row by segment filters and the property list.
 */
export const CONTACT_PROPERTY_MAX_KEYS = 100;
export const CONTACT_PROPERTY_KEY_MAX_LENGTH = 200;
export const CONTACT_PROPERTY_VALUE_MAX_LENGTH = 1000;

/**
 * A property definition's type: Resend's string and number, plus date, a
 * MillionSend extension whose values must read as a date (property-date.ts).
 * This module imports only property-date.ts, which imports nothing, so the
 * dashboard can read it in the browser.
 */
export const CONTACT_PROPERTY_TYPES = ["string", "number", "date"] as const;
export type ContactPropertyType = (typeof CONTACT_PROPERTY_TYPES)[number];

/**
 * Whether writing `incoming` over `current` (a jsonb `||` merge) and dropping
 * `removed` would change the stored map. No-op writes are skipped upstream so
 * a full re-upsert neither moves `updated_at` nor fires `contact.updated`.
 */
export function contactPropertiesChange(
  current: Record<string, string>,
  incoming: Record<string, string>,
  removed: readonly string[] = [],
): boolean {
  return (
    Object.entries(incoming).some(
      ([key, value]) => !Object.hasOwn(current, key) || current[key] !== value,
    ) || removed.some((key) => Object.hasOwn(current, key))
  );
}

/**
 * The numeric reading of a property value, or null when it has none:
 * String(value) must be non-blank and parse to a finite number (values are
 * stored as text, so this is the shared write-validate/read-back rule).
 */
export function numericPropertyValue(value: unknown): number | null {
  const str = String(value).trim();
  if (str === "") return null;
  const num = Number(str);
  return Number.isFinite(num) ? num : null;
}

/**
 * The text `value` is stored as under a property of `type`, or the type it
 * fails to read as. A number keeps its text and a date is trimmed. A key
 * with no definition, like a string one, takes any value as written.
 */
export function storedPropertyValue(
  type: ContactPropertyType | undefined,
  value: unknown,
): { ok: true; stored: string } | { ok: false; mustBe: Exclude<ContactPropertyType, "string"> } {
  const text = String(value);
  if (type === "number" && numericPropertyValue(text) === null) {
    return { ok: false, mustBe: "number" };
  }
  if (type !== "date") return { ok: true, stored: text };
  return parsePropertyDate(text) === null
    ? { ok: false, mustBe: "date" }
    : { ok: true, stored: text.trim() };
}
