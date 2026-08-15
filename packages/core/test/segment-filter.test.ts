import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import type { SegmentFilter } from "@millionsend/db/schema";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SegmentFilterError, segmentFilterSchema, segmentWhere } from "../src/segment-filter.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;
let audienceId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "seg");
  const [audience] = await db
    .insert(schema.audiences)
    .values({ teamId, name: "all" })
    .returning({ id: schema.audiences.id });
  if (!audience) throw new Error("audience insert failed");
  audienceId = audience.id;

  await db.insert(schema.contacts).values([
    {
      audienceId,
      teamId,
      email: "alice@example.com",
      firstName: "Alice",
      lastName: "Alpha",
      properties: { plan: "pro", city: "Rio" },
      unsubscribed: false,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    },
    {
      audienceId,
      teamId,
      email: "bob@other.test",
      firstName: "Bob",
      lastName: null,
      properties: { plan: "free" },
      unsubscribed: true,
      createdAt: new Date("2026-06-01T00:00:00Z"),
    },
    {
      audienceId,
      teamId,
      email: "carol@example.com",
      firstName: null,
      lastName: "",
      properties: { plan: "" },
      unsubscribed: false,
      createdAt: new Date("2026-08-01T00:00:00Z"),
    },
  ]);
});
afterAll(() => close());

/** Emails matching the filter within the seeded audience, sorted. */
async function matched(filter: SegmentFilter): Promise<string[]> {
  const rows = await db
    .select({ email: schema.contacts.email })
    .from(schema.contacts)
    .where(and(eq(schema.contacts.audienceId, audienceId), segmentWhere(schema.contacts, filter)));
  return rows.map((r) => r.email).sort();
}

const all = (...conditions: SegmentFilter["conditions"]): SegmentFilter => ({
  match: "all",
  conditions,
});
const any = (...conditions: SegmentFilter["conditions"]): SegmentFilter => ({
  match: "any",
  conditions,
});

describe("segmentWhere: operators", () => {
  it("equals / not_equals on a builtin text field", async () => {
    expect(
      await matched(all({ field: "email", op: "equals", value: "alice@example.com" })),
    ).toEqual(["alice@example.com"]);
    // not_equals treats a null column as "not equal" (is distinct from).
    expect(await matched(all({ field: "first_name", op: "not_equals", value: "Alice" }))).toEqual([
      "bob@other.test",
      "carol@example.com",
    ]);
  });

  it("contains / starts_with / ends_with match literal substrings", async () => {
    expect(await matched(all({ field: "email", op: "contains", value: "example.com" }))).toEqual([
      "alice@example.com",
      "carol@example.com",
    ]);
    expect(await matched(all({ field: "email", op: "starts_with", value: "bob" }))).toEqual([
      "bob@other.test",
    ]);
    expect(await matched(all({ field: "last_name", op: "ends_with", value: "lpha" }))).toEqual([
      "alice@example.com",
    ]);
  });

  it("treats LIKE metacharacters in the value as literals, not wildcards", async () => {
    // A bare "%" would match every row if the pattern weren't escaped.
    expect(await matched(all({ field: "email", op: "contains", value: "%" }))).toEqual([]);
    expect(await matched(all({ field: "email", op: "contains", value: "_" }))).toEqual([]);
  });

  it("is_set / is_not_set on a builtin (null or empty counts as unset)", async () => {
    expect(await matched(all({ field: "last_name", op: "is_set", value: null }))).toEqual([
      "alice@example.com",
    ]);
    // carol has "" last_name, bob has null last_name — both unset.
    expect(await matched(all({ field: "last_name", op: "is_not_set", value: null }))).toEqual([
      "bob@other.test",
      "carol@example.com",
    ]);
  });

  it("unsubscribed is_true / is_false", async () => {
    expect(await matched(all({ field: "unsubscribed", op: "is_true", value: null }))).toEqual([
      "bob@other.test",
    ]);
    expect(await matched(all({ field: "unsubscribed", op: "is_false", value: null }))).toEqual([
      "alice@example.com",
      "carol@example.com",
    ]);
  });

  it("created_at before / after", async () => {
    expect(
      await matched(all({ field: "created_at", op: "after", value: "2026-05-01T00:00:00Z" })),
    ).toEqual(["bob@other.test", "carol@example.com"]);
    expect(
      await matched(all({ field: "created_at", op: "before", value: "2026-05-01T00:00:00Z" })),
    ).toEqual(["alice@example.com"]);
  });
});

describe("segmentWhere: property fields", () => {
  it("equals on a custom property", async () => {
    expect(await matched(all({ field: "property:plan", op: "equals", value: "pro" }))).toEqual([
      "alice@example.com",
    ]);
  });

  it("is_set treats a missing key or empty value as unset", async () => {
    // alice+bob have a non-empty plan; carol's is "", so unset.
    expect(await matched(all({ field: "property:plan", op: "is_set", value: null }))).toEqual([
      "alice@example.com",
      "bob@other.test",
    ]);
    // 'city' is present only on alice.
    expect(await matched(all({ field: "property:city", op: "is_not_set", value: null }))).toEqual([
      "bob@other.test",
      "carol@example.com",
    ]);
  });
});

describe("segmentWhere: match combination and empty", () => {
  it("all = AND, any = OR", async () => {
    expect(
      await matched(
        all(
          { field: "email", op: "contains", value: "example.com" },
          { field: "unsubscribed", op: "is_false", value: null },
        ),
      ),
    ).toEqual(["alice@example.com", "carol@example.com"]);
    expect(
      await matched(
        any(
          { field: "email", op: "equals", value: "alice@example.com" },
          { field: "unsubscribed", op: "is_true", value: null },
        ),
      ),
    ).toEqual(["alice@example.com", "bob@other.test"]);
  });

  it("empty conditions matches everyone in the audience (both match modes)", async () => {
    expect(await matched({ match: "all", conditions: [] })).toEqual([
      "alice@example.com",
      "bob@other.test",
      "carol@example.com",
    ]);
    expect(await matched({ match: "any", conditions: [] })).toEqual([
      "alice@example.com",
      "bob@other.test",
      "carol@example.com",
    ]);
  });
});

describe("segmentWhere: security (SQL injection)", () => {
  it("treats a hostile property value as data, matching nothing", async () => {
    // If the value were interpolated into SQL, `' OR '1'='1` would flip the
    // predicate to always-true and leak every contact. Parameterized, it can
    // only ever equal a plan literally named that (none exist) → no rows.
    expect(
      await matched(all({ field: "property:plan", op: "equals", value: "x' OR '1'='1" })),
    ).toEqual([]);
    expect(
      await matched(all({ field: "email", op: "equals", value: "'; DROP TABLE contacts;--" })),
    ).toEqual([]);
    // The table is intact and still queryable after the hostile query ran.
    expect(await matched({ match: "all", conditions: [] })).toHaveLength(3);
  });

  it("treats a hostile property KEY as a bound parameter, not SQL", async () => {
    // A key crafted to break out of the ->> operand must be looked up verbatim
    // (no such key) rather than executed.
    expect(
      await matched(
        all({ field: "property:plan') = 'pro' OR ('1'='1", op: "is_set", value: null }),
      ),
    ).toEqual([]);
  });
});

describe("segmentFilterSchema / segmentWhere: validation", () => {
  it("rejects an unknown field", () => {
    expect(
      segmentFilterSchema.safeParse(all({ field: "ssn", op: "equals", value: "x" })).success,
    ).toBe(false);
    expect(() =>
      segmentWhere(schema.contacts, all({ field: "ssn", op: "equals", value: "x" })),
    ).toThrow(SegmentFilterError);
  });

  it("rejects an operator not allowed for the field", () => {
    // is_true is boolean-only; a text field must not accept it.
    expect(
      segmentFilterSchema.safeParse(all({ field: "email", op: "is_true", value: null })).success,
    ).toBe(false);
    // before/after are date-only.
    expect(
      segmentFilterSchema.safeParse(all({ field: "email", op: "before", value: "x" })).success,
    ).toBe(false);
  });

  it("rejects a property field with an empty key", () => {
    expect(
      segmentFilterSchema.safeParse(all({ field: "property:", op: "equals", value: "x" })).success,
    ).toBe(false);
  });

  it("requires a value for comparison ops and a valid date for created_at", () => {
    expect(
      segmentFilterSchema.safeParse(all({ field: "email", op: "equals", value: null })).success,
    ).toBe(false);
    expect(
      segmentFilterSchema.safeParse(all({ field: "created_at", op: "after", value: "not-a-date" }))
        .success,
    ).toBe(false);
  });
});
