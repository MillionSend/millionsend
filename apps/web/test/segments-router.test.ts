import { segmentFilterSchema } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSegmentFilter } from "@/lib/segment-builder";
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
  audienceId: string,
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
    audienceId,
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
  it("creates, lists with live count, gets, updates, and deletes", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const { id: audienceId } = await caller.audience.audiences.create({ name: "Newsletter" });
    await insertContact(teamId, audienceId, { email: "ada@x.com" });
    await insertContact(teamId, audienceId, { email: "bob@y.com" });

    const { id } = await caller.segments.create({
      audienceId,
      name: "X domain",
      filter: filterOf("all", [{ field: "email", op: "ends_with", value: "@x.com" }]),
    });

    const listed = await caller.segments.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id, name: "X domain", audienceName: "Newsletter", count: 1 });

    const got = await caller.segments.get({ id });
    expect(got.count).toBe(1);

    await caller.segments.update({
      id,
      name: "Everyone",
      filter: filterOf("all", []),
    });
    expect((await caller.segments.get({ id })).count).toBe(2);
    expect((await caller.segments.list())[0]?.name).toBe("Everyone");

    await caller.segments.delete({ id });
    expect(await caller.segments.list()).toEqual([]);
  });

  it("blocks cross-team list/get/delete/count and foreign-audience create", async () => {
    const teamA = await createTeam(db, "team-a");
    const teamB = await createTeam(db, "team-b");
    const a = callerFor(teamA);
    const b = callerFor(teamB);
    const { id: audienceId } = await a.audience.audiences.create({ name: "A's" });
    const { id: segId } = await a.segments.create({
      audienceId,
      name: "seg",
      filter: filterOf("all", []),
    });

    expect(await b.segments.list()).toEqual([]);
    await expect(b.segments.get({ id: segId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(b.segments.delete({ id: segId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // B cannot count against A's audience, nor create a segment over it.
    await expect(
      b.segments.count({ audienceId, filter: filterOf("all", []) }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      b.segments.create({ audienceId, name: "x", filter: filterOf("all", []) }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("segments count matches known filters (the same predicate the worker fans out on)", () => {
  async function seed() {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const { id: audienceId } = await caller.audience.audiences.create({ name: "N" });
    await insertContact(teamId, audienceId, {
      email: "ada@x.com",
      firstName: "Ada",
      properties: { plan: "pro" },
    });
    await insertContact(teamId, audienceId, {
      email: "bob@x.com",
      properties: { plan: "free" },
      unsubscribed: true,
    });
    await insertContact(teamId, audienceId, {
      email: "cyd@y.com",
      createdAt: new Date("2020-01-01T00:00:00Z"),
    });
    return { caller, audienceId };
  }

  it("counts text, property, boolean, date, empty, and match=any filters", async () => {
    const { caller, audienceId } = await seed();
    const c = (m: "all" | "any", conds: { field: string; op: string; value: string | null }[]) =>
      caller.segments.count({ audienceId, filter: filterOf(m, conds) });

    expect((await c("all", [])).count).toBe(3); // empty = whole audience
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
    const { caller, audienceId } = await seed();
    const evil = await caller.segments.count({
      audienceId,
      filter: filterOf("all", [{ field: "email", op: "equals", value: "x' OR '1'='1" }]),
    });
    expect(evil.count).toBe(0);
  });
});

describe("segments reject a malformed filter with 422", () => {
  it("rejects an unknown field and an unsupported operator on count and create", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const { id: audienceId } = await caller.audience.audiences.create({ name: "N" });

    await expect(
      caller.segments.count({
        audienceId,
        filter: filterOf("all", [{ field: "ssn", op: "equals", value: "x" }]),
      }),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE_CONTENT" });
    await expect(
      caller.segments.count({
        audienceId,
        filter: filterOf("all", [{ field: "email", op: "bogus", value: "x" }]),
      }),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE_CONTENT" });
    // A bad filter is rejected at create time, not stored to blow up on read.
    await expect(
      caller.segments.create({
        audienceId,
        name: "bad",
        filter: filterOf("all", [{ field: "email", op: "bogus", value: "x" }]),
      }),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE_CONTENT" });
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
});

describe("broadcast create carries a segmentId", () => {
  it("stores the segment, surfaces its name, counts against it, and rejects a foreign one", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const { id: audienceId } = await caller.audience.audiences.create({ name: "N" });
    await insertContact(teamId, audienceId, { email: "ada@x.com" });
    await insertContact(teamId, audienceId, { email: "bob@y.com" });
    const { id: segmentId } = await caller.segments.create({
      audienceId,
      name: "X only",
      filter: filterOf("all", [{ field: "email", op: "ends_with", value: "@x.com" }]),
    });

    const { id: broadcastId } = await caller.broadcasts.create({
      audienceId,
      segmentId,
      from: "Ada <ada@example.com>",
      subject: "Hi",
    });
    const detail = await caller.broadcasts.get({ id: broadcastId });
    expect(detail.segmentId).toBe(segmentId);
    expect(detail.segmentName).toBe("X only");

    // Guard-rail count reflects the segment (1 of 2 contacts), not the whole audience.
    const scoped = await caller.broadcasts.recipientCount({ audienceId, segmentId });
    expect(scoped.count).toBe(1);
    const whole = await caller.broadcasts.recipientCount({ audienceId });
    expect(whole.count).toBe(2);

    // A segment from another audience cannot scope this send.
    const { id: other } = await caller.audience.audiences.create({ name: "Other" });
    const { id: foreign } = await caller.segments.create({
      audienceId: other,
      name: "elsewhere",
      filter: filterOf("all", []),
    });
    await expect(
      caller.broadcasts.create({
        audienceId,
        segmentId: foreign,
        from: "Ada <ada@example.com>",
        subject: "Hi",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
