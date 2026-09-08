/**
 * Bounds on a contact's free-form properties map, shared by the public API
 * and the dashboard so both boundaries reject the same payloads: the map is
 * a jsonb column expanded per row by segment filters and the property list.
 */
export const CONTACT_PROPERTY_MAX_KEYS = 100;
export const CONTACT_PROPERTY_KEY_MAX_LENGTH = 200;
export const CONTACT_PROPERTY_VALUE_MAX_LENGTH = 1000;

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
    Object.entries(incoming).some(([key, value]) => current[key] !== value) ||
    removed.some((key) => key in current)
  );
}
