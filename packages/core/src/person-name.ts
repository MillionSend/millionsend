/** A display name split on whitespace: first word, then the rest. */
export function splitPersonName(name: string | null | undefined): {
  firstName: string | null;
  lastName: string | null;
} {
  const [firstName, ...rest] = (name ?? "").trim().split(/\s+/);
  return { firstName: firstName || null, lastName: rest.length > 0 ? rest.join(" ") : null };
}
