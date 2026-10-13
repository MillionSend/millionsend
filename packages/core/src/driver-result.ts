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

/**
 * Why Postgres refused a value no column can hold, however the driver wrapped
 * the error, else null. Text and jsonb cannot store U+0000 (22021, 22P05).
 * Dates go over as toISOString(), which writes a year outside 0000–9999 with
 * a sign Postgres misreads, and Postgres has no year 0 (22007–22009).
 */
export function unstorableValueMessage(err: unknown): string | null {
  let e: unknown = err;
  while (e instanceof Error) {
    switch ((e as { code?: string }).code) {
      case "22021":
      case "22P05":
        return "Text must not contain the NUL character (\\u0000)";
      case "22007":
      case "22008":
      case "22009":
        return "Dates must be valid and fall between the years 1 and 9999";
    }
    e = e.cause;
  }
  return null;
}
