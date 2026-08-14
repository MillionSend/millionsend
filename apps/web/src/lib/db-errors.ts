/** Postgres unique_violation, possibly wrapped by the drizzle driver. */
export function isUniqueViolation(error: unknown): boolean {
  for (let e = error; e instanceof Error; e = e.cause as Error) {
    if ((e as { code?: unknown }).code === "23505") return true;
  }
  return false;
}
