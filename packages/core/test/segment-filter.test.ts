import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import type { SegmentFilter } from "@millionsend/db/schema";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  SegmentFilterError,
  segmentContactsWhere,
  segmentFilterSchema,
  segmentWhere,
} from "../src/segment-filter.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;
let teamBId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "seg");

  await db.insert(schema.contacts).values([
    {
      teamId,
      email: "alice@example.com",
      firstName: "Alice",
      lastName: "Alpha",
      properties: { plan: "pro", city: "Rio" },
      unsubscribed: false,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    },
    {
      teamId,
      email: "bob@other.test",
      firstName: "Bob",
      lastName: null,
      properties: { plan: "free" },
      unsubscribed: true,
      createdAt: new Date("2026-06-01T00:00:00Z"),
    },
    {
      teamId,
      email: "carol@example.com",
      firstName: null,
      lastName: "",
      properties: { plan: "" },
      unsubscribed: false,
      createdAt: new Date("2026-08-01T00:00:00Z"),
    },
  ]);

  // A second team whose contact must never appear in a team-A query. It
  // carries the exact values the is_not_set OR-disjuncts test for (empty
  // last_name, missing property) so an unparenthesized OR would leak it.
  teamBId = await createTeam(db, "seg-b");
  await db.insert(schema.contacts).values({
    teamId: teamBId,
    email: "mallory@leak.test",
    firstName: "Mallory",
    lastName: "",
    properties: {},
    unsubscribed: false,
    createdAt: new Date("2026-03-01T00:00:00Z"),
  });
});
afterAll(() => close());

/** Emails matching the filter within the seeded team, sorted. */
async function matched(filter: SegmentFilter | null): Promise<string[]> {
  const rows = await db
    .select({ email: schema.contacts.email })
    .from(schema.contacts)
    .where(and(eq(schema.contacts.teamId, teamId), segmentWhere(schema.contacts, filter)));
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

  it("empty conditions matches every team contact (both match modes)", async () => {
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

  it("null filter (manual-membership-only segment) matches no contacts", async () => {
    expect(await matched(null)).toEqual([]);
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

describe("segmentWhere: OR-precedence / cross-team scoping", () => {
  // A bare `expr is null or expr = ''` AND-ed with team scoping would parse
  // as `(scope AND expr is null) OR (expr = '')`, so any contact in ANY team
  // with an empty value leaks in. Parenthesizing the disjunction keeps the
  // AND-composition intact. mallory (team B, last_name '') is the tripwire.
  it("is_not_set stays scoped to its team (no cross-team leak)", async () => {
    expect(await matched(all({ field: "last_name", op: "is_not_set", value: null }))).toEqual([
      "bob@other.test",
      "carol@example.com",
    ]);
    // The leaked row would be from team B — assert it is truly seeded and
    // would otherwise match, so this test can't pass by B being empty.
    const bRows = await db
      .select({ email: schema.contacts.email })
      .from(schema.contacts)
      .where(
        and(
          eq(schema.contacts.teamId, teamBId),
          segmentWhere(schema.contacts, all({ field: "last_name", op: "is_not_set", value: null })),
        ),
      );
    expect(bRows.map((r) => r.email)).toEqual(["mallory@leak.test"]);
  });

  it("generates a parenthesized disjunction for is_not_set", () => {
    const { sql: text } = db
      .select()
      .from(schema.contacts)
      .where(
        segmentWhere(schema.contacts, all({ field: "last_name", op: "is_not_set", value: null })),
      )
      .toSQL();
    expect(text).toMatch(/\([^()]*is null or[^()]*=\s*''\)/i);
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

  it("caps the condition count and value length", () => {
    const cond = { field: "email", op: "equals", value: "x" };
    const fifty = { match: "all" as const, conditions: Array.from({ length: 50 }, () => cond) };
    expect(segmentFilterSchema.safeParse(fifty).success).toBe(true);
    expect(
      segmentFilterSchema.safeParse({ ...fifty, conditions: [...fifty.conditions, cond] }).success,
    ).toBe(false);
    expect(segmentFilterSchema.safeParse(all({ ...cond, value: "x".repeat(501) })).success).toBe(
      false,
    );
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

  it("refuses a created_at year outside 1–9999 and counts every date it accepts", async () => {
    for (const value of ["0000-06-01", "-000001-01-01", "+010000-01-01"]) {
      expect(
        segmentFilterSchema.safeParse(all({ field: "created_at", op: "before", value })).success,
      ).toBe(false);
    }
    // Postgres cannot read "2026" or "2026-10" itself.
    expect(await matched(all({ field: "created_at", op: "after", value: "2026" }))).toEqual([
      "bob@other.test",
      "carol@example.com",
    ]);
    expect(await matched(all({ field: "created_at", op: "before", value: "2026-07" }))).toEqual([
      "alice@example.com",
      "bob@other.test",
    ]);
    expect(await matched(all({ field: "created_at", op: "before", value: "0001-01-01" }))).toEqual(
      [],
    );
    expect(await matched(all({ field: "created_at", op: "after", value: "9999-12-31" }))).toEqual(
      [],
    );
  });
});

describe("segmentContactsWhere: resolution (filter OR manual membership)", () => {
  /** Emails the segment resolves to within `team`, sorted. */
  async function resolved(
    segment: { id: string; filter: SegmentFilter | null },
    team = teamId,
  ): Promise<string[]> {
    const rows = await db
      .select({ email: schema.contacts.email })
      .from(schema.contacts)
      .where(and(eq(schema.contacts.teamId, team), segmentContactsWhere(schema.contacts, segment)));
    return rows.map((r) => r.email).sort();
  }

  async function makeSegment(name: string, filter: SegmentFilter | null): Promise<string> {
    const [row] = await db
      .insert(schema.segments)
      .values({ teamId, name, filter })
      .returning({ id: schema.segments.id });
    if (!row) throw new Error("segment insert failed");
    return row.id;
  }

  async function addMember(segmentId: string, email: string): Promise<void> {
    const [contact] = await db
      .select({ id: schema.contacts.id })
      .from(schema.contacts)
      .where(and(eq(schema.contacts.teamId, teamId), eq(schema.contacts.email, email)));
    if (!contact) throw new Error(`no contact ${email}`);
    await db.insert(schema.segmentMembers).values({ segmentId, contactId: contact.id });
  }

  it("a null-filter segment resolves to its manual members only", async () => {
    const id = await makeSegment("manual", null);
    expect(await resolved({ id, filter: null })).toEqual([]);
    await addMember(id, "carol@example.com");
    expect(await resolved({ id, filter: null })).toEqual(["carol@example.com"]);
  });

  it("unions filter matches with manual members, without double counting", async () => {
    const filter = all({ field: "property:plan", op: "equals", value: "pro" });
    const id = await makeSegment("pro-plus", filter);
    // alice matches the filter AND is a manual member; carol is member-only.
    // A duplicate row for alice would show up twice in the sorted list.
    await addMember(id, "alice@example.com");
    await addMember(id, "carol@example.com");
    expect(await resolved({ id, filter })).toEqual(["alice@example.com", "carol@example.com"]);
  });

  it("membership of one segment does not bleed into another", async () => {
    const withMember = await makeSegment("has-member", null);
    const empty = await makeSegment("empty", null);
    await addMember(withMember, "bob@other.test");
    expect(await resolved({ id: withMember, filter: null })).toEqual(["bob@other.test"]);
    expect(await resolved({ id: empty, filter: null })).toEqual([]);
  });

  it("the OR stays parenthesized: team scoping still excludes other teams", async () => {
    // Match-all filter → `(true or exists(...))`; if the OR leaked out of its
    // parens, the team AND would only bind the left side and mallory (team B)
    // would appear.
    const filter = all();
    const id = await makeSegment("everyone", filter);
    expect(await resolved({ id, filter })).toEqual([
      "alice@example.com",
      "bob@other.test",
      "carol@example.com",
    ]);
  });
});

describe("segmentWhere: date ops", () => {
  const DAY = 86_400_000;
  const ago = (days: number) => new Date(Date.now() - days * DAY);
  let datesTeam: string;

  beforeAll(async () => {
    datesTeam = await createTeam(db, "seg-dates");
    await db.insert(schema.contacts).values([
      {
        teamId: datesTeam,
        email: "recent@example.com",
        properties: {
          signup: "2026-01-08",
          last_login: ago(2).toISOString(),
          renews: ago(-10).toISOString(),
          count: "3",
        },
        createdAt: ago(5),
      },
      {
        teamId: datesTeam,
        email: "lapsed@example.com",
        properties: {
          signup: "1767225600",
          last_login: String(Math.floor(ago(60).getTime() / 1000)),
          count: "1500",
        },
        createdAt: ago(40),
      },
      {
        teamId: datesTeam,
        email: "junk@example.com",
        properties: { signup: "soon", last_login: "yesterday" },
        createdAt: ago(400),
      },
      { teamId: datesTeam, email: "blank@example.com", properties: {} },
    ]);
  });

  const inTeam = async (field: string, op: string, value: string | null) => {
    const rows = await db
      .select({ email: schema.contacts.email })
      .from(schema.contacts)
      .where(
        and(
          eq(schema.contacts.teamId, datesTeam),
          segmentWhere(schema.contacts, all({ field, op, value })),
        ),
      );
    return rows.map((r) => r.email.split("@")[0]).sort();
  };

  it("compares a property read as a date, before and after", async () => {
    expect(await inTeam("property:signup", "after", "2026-01-05")).toEqual(["recent"]);
    expect(await inTeam("property:signup", "before", "2026-01-05T00:00:00Z")).toEqual(["lapsed"]);
  });

  it("reads in_last_days as from N days ago to now, and not_in_last_days as older than that", async () => {
    expect(await inTeam("property:last_login", "in_last_days", "30")).toEqual(["recent"]);
    expect(await inTeam("property:last_login", "not_in_last_days", "30")).toEqual(["lapsed"]);
    expect(await inTeam("property:last_login", "in_last_days", "90")).toEqual(["lapsed", "recent"]);
    // A date still to come is in neither.
    expect(await inTeam("property:renews", "in_last_days", "30")).toEqual([]);
    expect(await inTeam("property:renews", "not_in_last_days", "30")).toEqual([]);
    expect(await inTeam("property:renews", "after", "2026-01-01")).toEqual(["recent"]);
  });

  it("never matches a value that reads as no date, or no value", async () => {
    for (const op of ["in_last_days", "not_in_last_days"]) {
      expect(await inTeam("property:count", op, "36500"), op).toEqual([]);
    }
    expect(await inTeam("property:count", "before", "2100-01-01")).toEqual([]);
    expect(await inTeam("property:count", "after", "0001-01-01")).toEqual([]);
    expect(await inTeam("property:signup", "after", "0001-01-01")).toEqual(["lapsed", "recent"]);
    // junk's "yesterday" and blank's missing key are in neither.
    expect(await inTeam("property:last_login", "not_in_last_days", "1")).toEqual([
      "lapsed",
      "recent",
    ]);
  });

  it("keeps text ops on a property that holds dates", async () => {
    expect(await inTeam("property:signup", "equals", "1767225600")).toEqual(["lapsed"]);
    expect(await inTeam("property:last_login", "is_not_set", null)).toEqual(["blank"]);
  });

  it("takes in_last_days and not_in_last_days on created_at", async () => {
    expect(await inTeam("created_at", "in_last_days", "30")).toEqual(["blank", "recent"]);
    expect(await inTeam("created_at", "not_in_last_days", "30")).toEqual(["junk", "lapsed"]);
    expect(await inTeam("created_at", "not_in_last_days", "365")).toEqual(["junk"]);
  });

  it("validates the value statically, whatever the property's type", () => {
    const valid = (field: string, op: string, value: string | null) =>
      segmentFilterSchema.safeParse(all({ field, op, value })).success;
    expect(valid("property:anything", "in_last_days", "1")).toBe(true);
    expect(valid("property:anything", "not_in_last_days", "36500")).toBe(true);
    expect(valid("created_at", "in_last_days", "7")).toBe(true);
    for (const days of ["0", "36501", "007", "1.5", "-1", "7 ", "abc", null]) {
      expect(valid("property:anything", "in_last_days", days), String(days)).toBe(false);
      expect(valid("created_at", "not_in_last_days", days), String(days)).toBe(false);
    }
    expect(valid("property:anything", "before", "2026-01-08")).toBe(true);
    for (const date of ["soon", "0000-06-01", "+010000-01-01", null]) {
      expect(valid("property:anything", "after", date), String(date)).toBe(false);
    }
    // Builtin text fields take no date ops, and created_at no text ops.
    expect(valid("email", "in_last_days", "7")).toBe(false);
    expect(valid("created_at", "equals", "2026-01-08")).toBe(false);
    expect(valid("property:anything", "in_next_days", "7")).toBe(false);
  });

  it("reads a before/after value with no zone in UTC, as stored values are, whatever the server's zone", () => {
    vi.stubEnv("TZ", "America/Sao_Paulo");
    try {
      for (const field of ["property:last_login", "created_at"]) {
        for (const [value, bound] of [
          ["2026-01-08T10:00:00", "2026-01-08T10:00:00.000Z"],
          ["2026-01-08 10:00", "2026-01-08T10:00:00.000Z"],
          ["2026-01-08T10:00:00-03:00", "2026-01-08T13:00:00.000Z"],
          ["2026", "2026-01-01T00:00:00.000Z"],
        ] as const) {
          const query = db
            .select()
            .from(schema.contacts)
            .where(segmentWhere(schema.contacts, all({ field, op: "after", value })))
            .toSQL();
          expect(query.params, `${field} ${value}`).toContain(bound);
        }
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("binds a hostile key and the day count as parameters", async () => {
    const key = "x') is not null or ('1'='1";
    expect(await inTeam(`property:${key}`, "not_in_last_days", "1")).toEqual([]);
    const query = db
      .select()
      .from(schema.contacts)
      .where(
        segmentWhere(
          schema.contacts,
          all({ field: `property:${key}`, op: "in_last_days", value: "30" }),
        ),
      )
      .toSQL();
    expect(query.sql).not.toContain(key);
    expect(query.params).toContain(key);
    expect(query.params).toContain(30);
  });
});
