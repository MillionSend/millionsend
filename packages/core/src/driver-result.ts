/**
 * db.execute() results differ by driver: postgres-js yields an array-like
 * RowList, PGlite (tests) yields { rows }. Normalize through `unknown` —
 * typing against one driver makes the other branch unreachable for TS.
 */
export function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown }).rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

export function firstRow<T>(result: unknown): T | undefined {
  return resultRows<T>(result)[0];
}
