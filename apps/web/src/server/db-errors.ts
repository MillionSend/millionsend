export function isForeignKeyViolation(error: unknown): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    if ((current as Error & { code?: string }).code === "23503") return true;
    current = current.cause;
  }
  return false;
}
