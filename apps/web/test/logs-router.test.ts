import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCaller } from "@/server/routers";
import type { Context } from "@/server/trpc";

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});

afterEach(async () => {
  await close();
});

function caller(teamId: string, role: Context["role"] = "owner") {
  const ctx: Context = {
    db,
    session: { user: { id: "u1", email: "u1@example.com", name: "u1" } },
    teamId,
    role,
  };
  return createCaller(ctx);
}

async function insertRequest(
  values: Partial<typeof schema.apiRequests.$inferInsert> & { teamId: string },
): Promise<string> {
  const [row] = await db
    .insert(schema.apiRequests)
    .values({ method: "POST", path: "/emails", statusCode: 200, ...values })
    .returning({ id: schema.apiRequests.id });
  if (!row) throw new Error("api request insert failed");
  return row.id;
}

describe("logs.list", () => {
  it("scopes rows to the caller's team", async () => {
    const teamA = await createTeam(db, "team-a");
    const teamB = await createTeam(db, "team-b");
    const a1 = await insertRequest({ teamId: teamA, createdAt: new Date("2026-08-01T10:00:00Z") });
    const a2 = await insertRequest({ teamId: teamA, createdAt: new Date("2026-08-02T10:00:00Z") });
    const b1 = await insertRequest({ teamId: teamB, createdAt: new Date("2026-08-03T10:00:00Z") });

    const resA = await caller(teamA).logs.list({});
    expect(resA.items.map((r) => r.id)).toEqual([a2, a1]);

    const resB = await caller(teamB).logs.list({});
    expect(resB.items.map((r) => r.id)).toEqual([b1]);
  });

  it("filters by status class", async () => {
    const teamA = await createTeam(db, "team-a");
    const ok = await insertRequest({ teamId: teamA, statusCode: 200 });
    const clientErr = await insertRequest({ teamId: teamA, statusCode: 422 });
    const serverErr = await insertRequest({ teamId: teamA, statusCode: 500 });

    const twoXx = await caller(teamA).logs.list({ statusClass: "2xx" });
    expect(twoXx.items.map((r) => r.id)).toEqual([ok]);

    const fourXx = await caller(teamA).logs.list({ statusClass: "4xx" });
    expect(fourXx.items.map((r) => r.id)).toEqual([clientErr]);

    const fiveXx = await caller(teamA).logs.list({ statusClass: "5xx" });
    expect(fiveXx.items.map((r) => r.id)).toEqual([serverErr]);
  });

  it("pages with a keyset cursor without overlap", async () => {
    const teamA = await createTeam(db, "team-a");
    const ids = [];
    for (let i = 0; i < 3; i++) {
      ids.push(
        await insertRequest({ teamId: teamA, createdAt: new Date(Date.UTC(2026, 7, 1 + i)) }),
      );
    }

    const page1 = await caller(teamA).logs.list({ limit: 2 });
    expect(page1.items.map((r) => r.id)).toEqual([ids[2], ids[1]]);
    if (!page1.nextCursor) throw new Error("expected a next cursor");

    const page2 = await caller(teamA).logs.list({ limit: 2, cursor: page1.nextCursor });
    expect(page2.items.map((r) => r.id)).toEqual([ids[0]]);
    expect(page2.nextCursor).toBeNull();
  });

  it("does not skip same-millisecond rows differing only in microseconds", async () => {
    const teamA = await createTeam(db, "team-a");
    const newer = await insertRequest({
      teamId: teamA,
      createdAt: sql`timestamptz '2026-08-01 10:00:00.123456+00'` as unknown as Date,
    });
    const older = await insertRequest({
      teamId: teamA,
      createdAt: sql`timestamptz '2026-08-01 10:00:00.123400+00'` as unknown as Date,
    });

    const page1 = await caller(teamA).logs.list({ limit: 1 });
    expect(page1.items.map((r) => r.id)).toEqual([newer]);
    if (!page1.nextCursor) throw new Error("expected a next cursor");

    const page2 = await caller(teamA).logs.list({ limit: 1, cursor: page1.nextCursor });
    expect(page2.items.map((r) => r.id)).toEqual([older]);
  });
});

describe("logs.get", () => {
  it("returns the full row within the team only", async () => {
    const teamA = await createTeam(db, "team-a");
    const teamB = await createTeam(db, "team-b");
    const id = await insertRequest({
      teamId: teamA,
      statusCode: 422,
      requestBody: { subject: "s", html: "[redacted]" },
      responseBody: { statusCode: 422, name: "validation_error" },
    });

    const row = await caller(teamA).logs.get({ id });
    expect(row.method).toBe("POST");
    expect(row.path).toBe("/emails");
    expect(row.statusCode).toBe(422);
    expect(row.requestBody).toEqual({ subject: "s", html: "[redacted]" });
    expect(row.responseBody).toEqual({ statusCode: 422, name: "validation_error" });

    await expect(caller(teamB).logs.get({ id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("hides request/response bodies from role member, keeping the metadata", async () => {
    const teamA = await createTeam(db, "team-a");
    const id = await insertRequest({
      teamId: teamA,
      requestBody: { to: "ada@example.com" },
      responseBody: { id: "e1" },
    });
    const row = await caller(teamA, "member").logs.get({ id });
    expect(row.path).toBe("/emails");
    expect(row.requestBody).toBeNull();
    expect(row.responseBody).toBeNull();
    expect((await caller(teamA, "admin").logs.get({ id })).requestBody).toEqual({
      to: "ada@example.com",
    });
  });
});
