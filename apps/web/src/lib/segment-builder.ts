/**
 * Pure helpers behind the segment filter builder UI. Kept out of the React
 * component so the wire-shape mapping is unit-testable and the page and tests
 * agree on exactly what a builder row becomes. This is UI shape only — the
 * authoritative validation and the SQL predicate live in @millionsend/core
 * (segmentFilterSchema / segmentWhere), which this must never re-implement.
 * The wire shape is the pinned contract: { match, conditions: [{ field, op, value }] }.
 */

export type MatchMode = "all" | "any";

/** A builder row before it is mapped to the wire condition. */
export interface BuilderRow {
  /** A base field ("email", "created_at", …) or "property:<key>". */
  field: string;
  op: string;
  value: string;
}

export interface WireCondition {
  field: string;
  op: string;
  value: string | null;
}

export interface SegmentFilterDraft {
  match: MatchMode;
  conditions: WireCondition[];
}

export const PROPERTY_PREFIX = "property:";

export const BASE_FIELDS = [
  "email",
  "first_name",
  "last_name",
  "unsubscribed",
  "created_at",
] as const;

type FieldKind = "text" | "unsubscribed" | "created_at";

/** Which operator/value grammar a field uses. property:* behaves like text. */
export function fieldKind(field: string): FieldKind {
  if (field === "unsubscribed") return "unsubscribed";
  if (field === "created_at") return "created_at";
  return "text";
}

export const OPS_BY_KIND: Record<FieldKind, readonly string[]> = {
  text: ["equals", "not_equals", "contains", "starts_with", "ends_with", "is_set", "is_not_set"],
  unsubscribed: ["is_true", "is_false"],
  created_at: ["before", "after"],
};

/** Operators that carry no value — the wire value is null. */
export const VALUELESS_OPS = new Set(["is_set", "is_not_set", "is_true", "is_false"]);

export function opsFor(field: string): readonly string[] {
  return OPS_BY_KIND[fieldKind(field)];
}

export function defaultOp(field: string): string {
  return OPS_BY_KIND[fieldKind(field)][0] as string;
}

export function isProperty(field: string): boolean {
  return field.startsWith(PROPERTY_PREFIX);
}

export function propertyKey(field: string): string {
  return isProperty(field) ? field.slice(PROPERTY_PREFIX.length) : "";
}

/** A row is complete enough to translate: a real field, and a value when the op needs one. */
export function rowComplete(row: BuilderRow): boolean {
  if (isProperty(row.field) && propertyKey(row.field).trim() === "") return false;
  if (VALUELESS_OPS.has(row.op)) return true;
  return row.value.trim() !== "";
}

/**
 * Map builder rows to the pinned filter shape, dropping incomplete rows so the
 * live-count query and a saved segment never carry a half-filled condition.
 * Empty conditions is a valid filter that matches the whole audience.
 */
export function buildSegmentFilter(match: MatchMode, rows: BuilderRow[]): SegmentFilterDraft {
  return {
    match,
    conditions: rows.filter(rowComplete).map((row) => ({
      field: row.field,
      op: row.op,
      value: VALUELESS_OPS.has(row.op) ? null : row.value.trim(),
    })),
  };
}

/** A saved filter's wire conditions back to editable builder rows (null value → empty input). */
export function filterToRows(filter: SegmentFilterDraft | null): BuilderRow[] {
  return (filter?.conditions ?? []).map((c) => ({
    field: c.field,
    op: c.op,
    value: c.value ?? "",
  }));
}

/**
 * Structural equality of two filter drafts. jsonb round-trips reorder object
 * keys, so comparing JSON.stringify output against a saved filter is unreliable.
 */
export function sameFilter(a: SegmentFilterDraft, b: SegmentFilterDraft): boolean {
  return (
    a.match === b.match &&
    a.conditions.length === b.conditions.length &&
    a.conditions.every((c, i) => {
      const d = b.conditions[i];
      return d !== undefined && d.field === c.field && d.op === c.op && d.value === c.value;
    })
  );
}
