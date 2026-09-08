/** Rows a statement touched, from the driver's own count: postgres-js `count`, PGlite `affectedRows`. */
export function affectedRows(result: unknown): number {
  const r = result as { count?: number; affectedRows?: number };
  return r.count ?? r.affectedRows ?? 0;
}
