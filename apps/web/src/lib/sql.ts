/** Escape LIKE/ILIKE metacharacters so user search input matches literally. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}
