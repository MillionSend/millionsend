import { sha256Hex } from "./hash.js";

/**
 * Deterministic serialization for idempotency comparison: object keys sorted
 * recursively so semantically identical request bodies hash identically
 * regardless of key order. Values serializing via toJSON (Date, custom
 * classes) are resolved first — otherwise they'd all collapse to {} and
 * different bodies would hash alike.
 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortValue(value)) ?? "null";
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    const withToJson = value as { toJSON?: () => unknown };
    if (typeof withToJson.toJSON === "function") return sortValue(withToJson.toJSON());
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortValue(v)]));
  }
  return value;
}

export function canonicalBodyHash(body: unknown): string {
  return sha256Hex(canonicalStringify(body ?? null));
}
