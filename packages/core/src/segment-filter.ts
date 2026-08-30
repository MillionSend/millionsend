import { schema } from "@millionsend/db";
import type { SegmentFilter } from "@millionsend/db/schema";
import { and, or, type SQL, sql } from "drizzle-orm";
import { z } from "zod";

/**
 * Translates a team-authored segment filter into a parameterized Drizzle
 * predicate over the contacts table. Reused by the worker fan-out, the API
 * live-count, and broadcast targeting — the single place a filter becomes SQL.
 *
 * SECURITY: every field value AND every `property:<key>` reaches SQL as a bound
 * parameter via the `sql` tag — never string-concatenated — so a value like
 * `x' OR '1'='1` is compared as literal data, not executed. Unknown fields and
 * operators are rejected before any SQL is built (`segmentFilterSchema`), so the
 * predicate can only ever reference the columns and operators enumerated here.
 */

type ContactsTable = typeof schema.contacts;

const BUILTIN_TEXT_FIELDS = ["email", "first_name", "last_name"] as const;
const TEXT_OPS = [
  "equals",
  "not_equals",
  "contains",
  "starts_with",
  "ends_with",
  "is_set",
  "is_not_set",
] as const;
const BOOL_OPS = ["is_true", "is_false"] as const;
const DATE_OPS = ["before", "after"] as const;
const PROPERTY_PREFIX = "property:";

export const SEGMENT_FILTER_MAX_CONDITIONS = 50;
export const SEGMENT_FILTER_VALUE_MAX_LENGTH = 500;

type TextOp = (typeof TEXT_OPS)[number];

/** A text op that ignores its `value` — presence tests, not comparisons. */
function isPresenceOp(op: TextOp): boolean {
  return op === "is_set" || op === "is_not_set";
}

const conditionSchema = z
  .object({
    field: z.string(),
    op: z.string(),
    // Key is present but nullable; presence ops ignore it, so null is valid there.
    value: z.string().max(SEGMENT_FILTER_VALUE_MAX_LENGTH).nullable(),
  })
  .superRefine((cond, ctx) => {
    const isProperty = cond.field.startsWith(PROPERTY_PREFIX);
    const isText = isProperty || (BUILTIN_TEXT_FIELDS as readonly string[]).includes(cond.field);
    if (isText) {
      if (isProperty && cond.field.slice(PROPERTY_PREFIX.length).length === 0) {
        ctx.addIssue({ code: "custom", message: "property field requires a key" });
        return;
      }
      if (!(TEXT_OPS as readonly string[]).includes(cond.op)) {
        ctx.addIssue({ code: "custom", message: `unsupported operator "${cond.op}"` });
        return;
      }
      // A comparison op needs something to compare against.
      if (!isPresenceOp(cond.op as TextOp) && cond.value === null) {
        ctx.addIssue({ code: "custom", message: `operator "${cond.op}" requires a value` });
      }
      return;
    }
    if (cond.field === "unsubscribed") {
      if (!(BOOL_OPS as readonly string[]).includes(cond.op)) {
        ctx.addIssue({ code: "custom", message: `unsupported operator "${cond.op}"` });
      }
      return;
    }
    if (cond.field === "created_at") {
      if (!(DATE_OPS as readonly string[]).includes(cond.op)) {
        ctx.addIssue({ code: "custom", message: `unsupported operator "${cond.op}"` });
        return;
      }
      if (cond.value === null || Number.isNaN(Date.parse(cond.value))) {
        ctx.addIssue({ code: "custom", message: `operator "${cond.op}" requires an ISO date` });
      }
      return;
    }
    ctx.addIssue({ code: "custom", message: `unknown field "${cond.field}"` });
  });

/** The saved-filter shape; `z.infer` matches the DB `SegmentFilter` type. */
export const segmentFilterSchema: z.ZodType<SegmentFilter> = z.object({
  match: z.enum(["all", "any"]),
  conditions: z.array(conditionSchema).max(SEGMENT_FILTER_MAX_CONDITIONS),
});

/** Thrown when a filter fails validation; the API turns this into a 422. */
export class SegmentFilterError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`invalid segment filter: ${issues.join("; ")}`);
    this.name = "SegmentFilterError";
    this.issues = issues;
  }
}

/**
 * `%`, `_` and the escape char are LIKE metacharacters; escaping them keeps
 * contains/starts_with/ends_with matching literal substrings (still a bound
 * parameter — this is pattern correctness, not injection defense).
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** The text expression a text/property condition compares against. */
function textExpr(contacts: ContactsTable, field: string): SQL {
  if (field.startsWith(PROPERTY_PREFIX)) {
    const key = field.slice(PROPERTY_PREFIX.length);
    // jsonb ->> text: the key is a bound parameter, never concatenated.
    return sql`(${contacts.properties} ->> ${key})`;
  }
  const col =
    field === "email"
      ? contacts.email
      : field === "first_name"
        ? contacts.firstName
        : contacts.lastName;
  return sql`${col}`;
}

function textConditionSql(expr: SQL, op: TextOp, value: string | null): SQL {
  switch (op) {
    case "equals":
      return sql`${expr} = ${value}`;
    // is-distinct-from so a null column counts as "not equal" rather than unknown.
    case "not_equals":
      return sql`${expr} is distinct from ${value}`;
    case "contains":
      return sql`${expr} like ${`%${escapeLike(value ?? "")}%`} escape '\\'`;
    case "starts_with":
      return sql`${expr} like ${`${escapeLike(value ?? "")}%`} escape '\\'`;
    case "ends_with":
      return sql`${expr} like ${`%${escapeLike(value ?? "")}`} escape '\\'`;
    case "is_set":
      return sql`${expr} is not null and ${expr} <> ''`;
    // Parenthesized: this OR is AND-ed with team/audience scoping by every
    // caller, and a bare OR would flip precedence to (scope AND …) OR (… = ''),
    // matching contacts outside the scope — a cross-tenant leak.
    case "is_not_set":
      return sql`(${expr} is null or ${expr} = '')`;
  }
}

function conditionSql(
  contacts: ContactsTable,
  field: string,
  op: string,
  value: string | null,
): SQL {
  if (field === "unsubscribed") {
    return op === "is_true"
      ? sql`${contacts.unsubscribed} = true`
      : sql`${contacts.unsubscribed} = false`;
  }
  if (field === "created_at") {
    return op === "before"
      ? sql`${contacts.createdAt} < ${value}::timestamptz`
      : sql`${contacts.createdAt} > ${value}::timestamptz`;
  }
  return textConditionSql(textExpr(contacts, field), op as TextOp, value);
}

/**
 * Builds the Drizzle predicate for `filter` over `contacts`. Always returns a
 * usable predicate: an empty condition set becomes `true` (matches every
 * contact in the caller's scope) per the contract, so callers can drop it
 * straight into `and(...)` without a special case. Throws `SegmentFilterError`
 * on an unknown field/operator or malformed shape.
 *
 * A null filter (manual-membership-only segment) matches NO contacts here:
 * its membership lives in segment_members, and treating null as match-all
 * would silently widen a targeted send to the whole team.
 */
export function segmentWhere(contacts: ContactsTable, filter: SegmentFilter | null): SQL {
  if (filter === null) return sql`false`;
  const parsed = segmentFilterSchema.safeParse(filter);
  if (!parsed.success) {
    throw new SegmentFilterError(parsed.error.issues.map((i) => i.message));
  }
  const { match, conditions } = parsed.data;
  if (conditions.length === 0) return sql`true`;
  const predicates = conditions.map((c) => conditionSql(contacts, c.field, c.op, c.value));
  // Guaranteed non-empty here, so and()/or() never return undefined.
  const combined = match === "all" ? and(...predicates) : or(...predicates);
  return combined ?? sql`true`;
}

/**
 * Segment RESOLUTION — "who is in this segment": a contact matching the saved
 * filter (when one is set) OR holding an explicit segment_members row. The one
 * resolver behind the segment contact list, contact_count, and broadcast
 * fan-out targeting, so they can never disagree on membership. Parenthesized:
 * every caller ANDs this with team scoping, and a bare OR would leak contacts
 * outside the scope.
 */
export function segmentContactsWhere(
  contacts: ContactsTable,
  segment: { id: string; filter: SegmentFilter | null },
): SQL {
  const m = schema.segmentMembers;
  const isMember = sql`exists (select 1 from ${m} where ${m.segmentId} = ${segment.id} and ${m.contactId} = ${contacts.id})`;
  if (segment.filter === null) return isMember;
  return sql`(${segmentWhere(contacts, segment.filter)} or ${isMember})`;
}
