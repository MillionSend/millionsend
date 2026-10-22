/**
 * Pure helpers behind the segment filter builder UI. Kept out of the React
 * component so the wire-shape mapping is unit-testable and the page and tests
 * agree on exactly what a builder row becomes. This is UI shape only — the
 * authoritative validation and the SQL predicate live in @millionsend/core
 * (segmentFilterSchema / segmentWhere), which this must never re-implement.
 * The wire shape is the pinned contract: { match, conditions: [{ field, op, value }] }.
 */

import { isSegmentDayCount } from "@millionsend/core/property-date";

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

type FieldKind = "text" | "date" | "unsubscribed" | "created_at";

/**
 * Which operator/value grammar a field uses. A property is text, or date when
 * `dated`: defined as a date property, or already holding a date op.
 */
export function fieldKind(field: string, dated = false): FieldKind {
  if (field === "unsubscribed") return "unsubscribed";
  if (field === "created_at") return "created_at";
  return dated && isProperty(field) ? "date" : "text";
}

const TEXT_OPS = [
  "equals",
  "not_equals",
  "contains",
  "starts_with",
  "ends_with",
  "is_set",
  "is_not_set",
];
export const DATE_OPS = ["before", "after", "in_last_days", "not_in_last_days"];

export const OPS_BY_KIND: Record<FieldKind, readonly string[]> = {
  text: TEXT_OPS,
  // Text ops stay: is_not_set is how to find contacts without the date.
  date: [...DATE_OPS, ...TEXT_OPS],
  unsubscribed: ["is_true", "is_false"],
  created_at: DATE_OPS,
};

/** Operators that carry no value — the wire value is null. */
export const VALUELESS_OPS = new Set(["is_set", "is_not_set", "is_true", "is_false"]);

export function opsFor(field: string, dated = false): readonly string[] {
  return OPS_BY_KIND[fieldKind(field, dated)];
}

export function defaultOp(field: string, dated = false): string {
  return opsFor(field, dated)[0] as string;
}

/** What an op's value input takes: nothing, a calendar date, a count of days, or text. */
export function valueKind(op: string): "none" | "date" | "days" | "text" {
  if (VALUELESS_OPS.has(op)) return "none";
  if (op === "before" || op === "after") return "date";
  if (op === "in_last_days" || op === "not_in_last_days") return "days";
  return "text";
}

export function isProperty(field: string): boolean {
  return field.startsWith(PROPERTY_PREFIX);
}

export function propertyKey(field: string): string {
  return isProperty(field) ? field.slice(PROPERTY_PREFIX.length) : "";
}

/**
 * The field picker's value for a row: a field or a named property is its own
 * entry; a property with no key yet is the free-form "property" entry, whose
 * key input shows.
 */
export function fieldPickerValue(field: string): string {
  return isProperty(field) && propertyKey(field) === "" ? "property" : field;
}

/** A row is complete enough to translate: a real field, and a value when the op needs one. */
export function rowComplete(row: BuilderRow): boolean {
  if (isProperty(row.field) && propertyKey(row.field).trim() === "") return false;
  const kind = valueKind(row.op);
  if (kind === "none") return true;
  if (kind === "days") return isSegmentDayCount(row.value.trim());
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
