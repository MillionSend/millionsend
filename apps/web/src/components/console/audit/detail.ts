/**
 * Compact one-line rendering of an audit row's metadata: "reason complaints · notified yes".
 * `name` is skipped (the Target column already shows the team); a from/to pair
 * of plan objects collapses to "free → pro"; other nested values are left out.
 */
export function auditDetail(
  data: Record<string, unknown> | null,
  bool: (value: boolean) => string,
): string {
  if (!data) return "";
  const parts: string[] = [];
  const plan = (value: unknown) =>
    typeof value === "object" && value !== null && "plan" in value ? String(value.plan) : null;
  const from = plan(data.from);
  const to = plan(data.to);
  if (from !== null && to !== null) parts.push(`${from} → ${to}`);
  for (const [key, value] of Object.entries(data)) {
    if (key === "name" || key === "from" || key === "to" || value === null || value === undefined)
      continue;
    if (typeof value === "boolean") parts.push(`${key} ${bool(value)}`);
    else if (typeof value === "string" || typeof value === "number") {
      if (value !== "") parts.push(`${key} ${value}`);
    }
  }
  return parts.join(" · ");
}
