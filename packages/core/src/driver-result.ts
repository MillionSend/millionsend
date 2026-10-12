/**
 * db.execute() results differ by driver: postgres-js yields an array-like
 * RowList, PGlite (tests) yields { rows }. Normalize through `unknown` —
 * typing against one driver makes the other branch unreachable for TS.
 * Unrecognized shapes THROW: every caller treats "no rows" as a meaningful
 * negative outcome (quota rejected, CAS stale, key claimed), so failing
 * open here would convert a driver upgrade into silent product misbehavior.
 */
export function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result !== null && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows: unknown }).rows;
    if (Array.isArray(rows)) return rows as T[];
  }
  throw new Error("unrecognized db.execute result shape — update driver-result.ts");
}

export function firstRow<T>(result: unknown): T | undefined {
  return resultRows<T>(result)[0];
}

/** Whether a query failed on a unique constraint (SQLSTATE 23505), however the driver wrapped it. */
export function isUniqueViolation(err: unknown): boolean {
  let e: unknown = err;
  while (e instanceof Error) {
    if ((e as { code?: string }).code === "23505") return true;
    e = e.cause;
  }
  return false;
}
