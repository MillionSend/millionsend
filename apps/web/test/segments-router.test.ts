import { recountSegment, segmentFilterSchema } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSegmentFilter, filterToRows, sameFilter } from "@/lib/segment-builder";
import { createCaller } from "@/server/routers";

const TEST_KEK = Buffer.alloc(32, 7).toString("base64");
process.env.MASTER_ENCRYPTION_KEY = TEST_KEK;

vi.mock("@millionsend/db", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@millionsend/db")>();
  return { ...mod, getDb: () => db };
});

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});

afterEach(async () => {
  await close();
});

function callerFor(teamId: string) {
  return createCaller({
    db,
    session: { user: { id: "u1", email: "u1@example.com", name: "u1" } },
    teamId,
    role: "owner",
  });
}

async function insertContact(
  teamId: string,
  o: {
    email: string;
    firstName?: string;
    properties?: Record<string, string>;
    unsubscribed?: boolean;
    createdAt?: Date;
  },
) {
  await db.insert(schema.contacts).values({
    teamId,
    email: o.email,
    firstName: o.firstName ?? null,
    properties: o.properties ?? {},
    unsubscribed: o.unsubscribed ?? false,
    ...(o.createdAt ? { createdAt: o.createdAt } : {}),
  });
}

const filterOf = (
  match: "all" | "any",
  conditions: { field: string; op: string; value: string | null }[],
) => ({ match, conditions });

describe("segments CRUD and isolation", () => {
  it("creates, lists with the stored count, gets, updates, and deletes", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    await insertContact(teamId, { email: "ada@x.com" });
    await insertContact(teamId, { email: "bob@y.com" });

    const { id } = await caller.segments.create({
      name: "X domain",
      filter: filterOf("all", [{ field: "email", op: "ends_with", value: "@x.com" }]),
    });

    // create stores the count, so the list is right without a live scan.
    const listed = await caller.segments.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id, name: "X domain", contactCount: 1 });
    expect(listed[0]?.countedAt).toBeInstanceOf(Date);

    const got = await caller.segments.get({ id });
    expect(got.count).toBe(1);

    await caller.segments.update({
      id,
      name: "Everyone",
      filter: filterOf("all", []),
    });
    // A filter change recounts before the list is read again.
    expect((await caller.segments.list())[0]).toMatchObject({ name: "Everyone", contactCount: 2 });
    expect((await caller.segments.get({ id })).count).toBe(2);

    await caller.segments.delete({ id });
    expect(await caller.segments.list()).toEqual([]);
  });

  it("blocks cross-team list/get/update/delete and scopes count to the caller's team", async () => {
    const teamA = await createTeam(db, "team-a");
    const teamB = await createTeam(db, "team-b");
    const a = callerFor(teamA);
    const b = callerFor(teamB);
    await insertContact(teamA, { email: "ada@x.com" });
    const { id: segId } = await a.segments.create({
      name: "seg",
      filter: filterOf("all", []),
    });

    expect(await b.segments.list()).toEqual([]);
    await expect(b.segments.get({ id: segId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(b.segments.update({ id: segId, name: "hijack" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(b.segments.delete({ id: segId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // count is team-scoped: A's contact never inflates B's preview.
    expect(await b.segments.count({ filter: filterOf("all", []) })).toEqual({ count: 0 });
    expect((await a.segments.get({ id: segId })).name).toBe("seg");
  });

  it("refuses to delete a segment referenced by a broadcast", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const { id: segmentId } = await caller.segments.create({
      name: "Protected",
      filter: filterOf("all", []),
    });
    await caller.broadcasts.create({
      segmentId,
      from: "Ada <ada@example.com>",
      subject: "Scoped",
    });

    await expect(caller.segments.delete({ id: segmentId })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect((await caller.segments.get({ id: segmentId })).id).toBe(segmentId);
  });
});

describe("segments count matches known filters (the same predicate the worker fans out on)", () => {
  async function seed() {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    await insertContact(teamId, {
      email: "ada@x.com",
      firstName: "Ada",
      properties: { plan: "pro" },
    });
    await insertContact(teamId, {
      email: "bob@x.com",
      properties: { plan: "free" },
      unsubscribed: true,
    });
    await insertContact(teamId, {
      email: "cyd@y.com",
      createdAt: new Date("2020-01-01T00:00:00Z"),
    });
    return { caller };
  }

  it("counts text, property, boolean, date, empty, and match=any filters", async () => {
    const { caller } = await seed();
    const c = (m: "all" | "any", conds: { field: string; op: string; value: string | null }[]) =>
      caller.segments.count({ filter: filterOf(m, conds) });

    expect((await c("all", [])).count).toBe(3); // empty = every team contact
    expect((await c("all", [{ field: "email", op: "ends_with", value: "@x.com" }])).count).toBe(2);
    expect((await c("all", [{ field: "property:plan", op: "equals", value: "pro" }])).count).toBe(
      1,
    );
    expect((await c("all", [{ field: "unsubscribed", op: "is_true", value: null }])).count).toBe(1);
    expect(
      (await c("all", [{ field: "created_at", op: "before", value: "2021-01-01" }])).count,
    ).toBe(1);
    // match=any unions the two single-contact predicates.
    expect(
      (
        await c("any", [
          { field: "email", op: "ends_with", value: "@y.com" },
          { field: "property:plan", op: "equals", value: "pro" },
        ])
      ).count,
    ).toBe(2);
    // match=all intersects to nothing.
    expect(
      (
        await c("all", [
          { field: "email", op: "ends_with", value: "@y.com" },
          { field: "property:plan", op: "equals", value: "pro" },
        ])
      ).count,
    ).toBe(0);
  });

  it("treats a value as data, not SQL (injection attempt matches nothing)", async () => {
    const { caller } = await seed();
    const evil = await caller.segments.count({
      filter: filterOf("all", [{ field: "email", op: "equals", value: "x' OR '1'='1" }]),
    });
    expect(evil.count).toBe(0);
  });
});

describe("segments reject a malformed filter with 422", () => {
  it("rejects an unknown field and an unsupported operator on count and create", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);

    await expect(
      caller.segments.count({
        filter: filterOf("all", [{ field: "ssn", op: "equals", value: "x" }]),
      }),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE_CONTENT" });
    await expect(
      caller.segments.count({
        filter: filterOf("all", [{ field: "email", op: "bogus", value: "x" }]),
      }),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE_CONTENT" });
    // A bad filter is rejected at create time, not stored to blow up on read.
    await expect(
      caller.segments.create({
        name: "bad",
        filter: filterOf("all", [{ field: "email", op: "bogus", value: "x" }]),
      }),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE_CONTENT" });
    expect(await caller.segments.list()).toEqual([]);
  });

  it("rejects oversized filters at the input boundary", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const cond = { field: "email", op: "equals", value: "x" };
    await expect(
      caller.segments.count({
        filter: filterOf(
          "all",
          Array.from({ length: 51 }, () => cond),
        ),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.segments.create({
        name: "long",
        filter: filterOf("all", [{ ...cond, value: "x".repeat(501) }]),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await caller.segments.list()).toEqual([]);
  });
});

describe("builder produces a valid filter shape", () => {
  it("maps rows to a filter the core schema accepts, dropping incomplete rows", () => {
    const filter = buildSegmentFilter("any", [
      { field: "email", op: "contains", value: "@acme.com" },
      { field: "property:plan", op: "equals", value: "pro" },
      { field: "unsubscribed", op: "is_false", value: "" }, // valueless → null
      { field: "email", op: "equals", value: "   " }, // blank value → dropped
      { field: "property:", op: "equals", value: "x" }, // blank key → dropped
    ]);
    expect(segmentFilterSchema.safeParse(filter).success).toBe(true);
    expect(filter.conditions).toEqual([
      { field: "email", op: "contains", value: "@acme.com" },
      { field: "property:plan", op: "equals", value: "pro" },
      { field: "unsubscribed", op: "is_false", value: null },
    ]);
  });

  it("filterToRows/sameFilter round-trip a saved filter for the detail editor", () => {
    const saved = filterOf("any", [
      { field: "email", op: "ends_with", value: "@x.com" },
      { field: "unsubscribed", op: "is_false", value: null },
    ]);
    const rows = filterToRows(saved);
    expect(rows).toEqual([
      { field: "email", op: "ends_with", value: "@x.com" },
      { field: "unsubscribed", op: "is_false", value: "" },
    ]);
    const rebuilt = buildSegmentFilter("any", rows);
    expect(rebuilt).toEqual(saved);
    expect(sameFilter(rebuilt, saved)).toBe(true);
    expect(sameFilter({ ...rebuilt, match: "all" }, saved)).toBe(false);
    expect(sameFilter(buildSegmentFilter("any", rows.slice(0, 1)), saved)).toBe(false);
    expect(filterToRows(null)).toEqual([]);
  });
});

describe("segment counts include unsubscribed contacts", () => {
  it("list reads the stored contact + unsubscribed counts; get counts live and refreshes them", async () => {
    const teamId = await createTeam(db, "team-unsub");
    const caller = callerFor(teamId);
    await insertContact(teamId, { email: "ada@x.com" });
    await insertContact(teamId, { email: "bob@x.com", unsubscribed: true });
    await insertContact(teamId, { email: "cyd@y.com", unsubscribed: true });

    const { id: xId } = await caller.segments.create({
      name: "x-domain",
      filter: filterOf("all", [{ field: "email", op: "ends_with", value: "@x.com" }]),
    });
    const { id: allId } = await caller.segments.create({
      name: "everyone",
      filter: filterOf("all", []),
    });
    // Manual segment holding only the unsubscribed y-domain contact.
    const [manual] = await db
      .insert(schema.segments)
      .values({ teamId, name: "hand-picked", filter: null })
      .returning({ id: schema.segments.id });
    if (!manual) throw new Error("segment insert failed");
    const [cyd] = await db
      .select({ id: schema.contacts.id })
      .from(schema.contacts)
      .where(eq(schema.contacts.email, "cyd@y.com"));
    if (!cyd) throw new Error("contact missing");
    await db.insert(schema.segmentMembers).values({ segmentId: manual.id, contactId: cyd.id });

    const byId = new Map((await caller.segments.list()).map((row) => [row.id, row]));
    expect(byId.get(xId)).toMatchObject({ contactCount: 2, unsubscribedCount: 1 });
    expect(byId.get(allId)).toMatchObject({ contactCount: 3, unsubscribedCount: 2 });
    // Inserted outside the router: never counted until get or the cron runs.
    expect(byId.get(manual.id)).toMatchObject({
      contactCount: null,
      unsubscribedCount: null,
      countedAt: null,
    });

    const got = await caller.segments.get({ id: xId });
    expect(got).toMatchObject({ count: 2, unsubscribedCount: 1 });
    expect(await caller.segments.get({ id: manual.id })).toMatchObject({
      count: 1,
      unsubscribedCount: 1,
    });
    const refreshed = (await caller.segments.list()).find((row) => row.id === manual.id);
    expect(refreshed).toMatchObject({ contactCount: 1, unsubscribedCount: 1 });
    expect(refreshed?.countedAt).toBeInstanceOf(Date);
  });

  it("counts other teams' contacts in neither total", async () => {
    const teamA = await createTeam(db, "team-a");
    const teamB = await createTeam(db, "team-b");
    await insertContact(teamB, { email: "elsewhere@x.com", unsubscribed: true });
    const a = callerFor(teamA);
    const { id } = await a.segments.create({ name: "empty", filter: filterOf("all", []) });
    expect(await a.segments.get({ id })).toMatchObject({ count: 0, unsubscribedCount: 0 });
  });
});

describe("broadcast create carries a segmentId", () => {
  it("stores the segment, surfaces its name, counts against it, and rejects a foreign one", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    await insertContact(teamId, { email: "ada@x.com" });
    await insertContact(teamId, { email: "bob@y.com" });
    const { id: segmentId } = await caller.segments.create({
      name: "X only",
      filter: filterOf("all", [{ field: "email", op: "ends_with", value: "@x.com" }]),
    });

    const { id: broadcastId } = await caller.broadcasts.create({
      segmentId,
      from: "Ada <ada@example.com>",
      subject: "Hi",
    });
    const detail = await caller.broadcasts.get({ id: broadcastId });
    expect(detail.segmentId).toBe(segmentId);
    expect(detail.segmentName).toBe("X only");

    // Guard-rail count reflects the segment (1 of 2 contacts), not the whole team.
    const scoped = await caller.broadcasts.recipientCount({ segmentId });
    expect(scoped.count).toBe(1);
    const whole = await caller.broadcasts.recipientCount({});
    expect(whole.count).toBe(2);

    // Another team's segment cannot scope this send.
    const teamB = await createTeam(db, "team-b");
    const { id: foreign } = await callerFor(teamB).segments.create({
      name: "elsewhere",
      filter: filterOf("all", []),
    });
    await expect(
      caller.broadcasts.create({
        segmentId: foreign,
        from: "Ada <ada@example.com>",
        subject: "Hi",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("manual (null-filter) segments", () => {
  it("list/get count manual members and never crash on a null filter", async () => {
    const teamId = await createTeam(db, "team-manual");
    const caller = callerFor(teamId);
    await insertContact(teamId, { email: "picked@x.com" });
    await insertContact(teamId, { email: "unpicked@x.com" });
    const [segment] = await db
      .insert(schema.segments)
      .values({ teamId, name: "hand-picked", filter: null })
      .returning({ id: schema.segments.id });
    if (!segment) throw new Error("segment insert failed");
    const [contact] = await db
      .select({ id: schema.contacts.id })
      .from(schema.contacts)
      .where(eq(schema.contacts.email, "picked@x.com"));
    if (!contact) throw new Error("contact missing");
    await db.insert(schema.segmentMembers).values({ segmentId: segment.id, contactId: contact.id });

    expect((await caller.segments.get({ id: segment.id })).count).toBe(1);
    await recountSegment(db, { id: segment.id, teamId, filter: null });
    const listed = await caller.segments.list();
    expect(listed[0]).toMatchObject({ id: segment.id, filter: null, contactCount: 1 });
  });

  it("broadcasts.recipientCount resolves manual members plus filter matches", async () => {
    const teamId = await createTeam(db, "team-manual-rc");
    const caller = callerFor(teamId);
    await insertContact(teamId, { email: "match@x.com", properties: { tier: "vip" } });
    await insertContact(teamId, { email: "picked@y.com" });
    await insertContact(teamId, { email: "outsider@z.com" });
    const [segment] = await db
      .insert(schema.segments)
      .values({
        teamId,
        name: "vips-plus",
        filter: filterOf("all", [{ field: "property:tier", op: "equals", value: "vip" }]),
      })
      .returning({ id: schema.segments.id });
    if (!segment) throw new Error("segment insert failed");
    const [picked] = await db
      .select({ id: schema.contacts.id })
      .from(schema.contacts)
      .where(eq(schema.contacts.email, "picked@y.com"));
    if (!picked) throw new Error("contact missing");
    await db.insert(schema.segmentMembers).values({ segmentId: segment.id, contactId: picked.id });

    const { count } = await caller.broadcasts.recipientCount({ segmentId: segment.id });
    expect(count).toBe(2);
  });
});
