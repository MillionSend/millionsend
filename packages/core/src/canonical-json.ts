import { createHash } from "node:crypto";

/**
 * Deterministic serialization for idempotency comparison: object keys sorted
 * recursively so semantically identical request bodies hash identically
 * regardless of key order.
 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortValue(v)]));
  }
  return value;
}

export function canonicalBodyHash(body: unknown): string {
  return createHash("sha256").update(canonicalStringify(body), "utf8").digest("hex");
}
