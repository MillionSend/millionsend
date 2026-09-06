import { generateApiKey } from "@millionsend/core";
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

describe("logs.list filters", () => {
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

  async function insertKey(teamId: string, name: string, revokedAt: Date | null = null) {
    const key = generateApiKey();
    const [k] = await db
      .insert(schema.apiKeys)
      .values({
        teamId,
        name,
        tokenPrefix: key.tokenPrefix,
        keyHash: key.keyHash,
        last4: key.last4,
        revokedAt,
      })
      .returning({ id: schema.apiKeys.id, last4: schema.apiKeys.last4 });
    if (!k) throw new Error("api key insert failed");
    return k;
  }

  async function seed() {
    const teamA = await createTeam(db, "team-a");
    const k = await insertKey(teamA, "k");
    const old = await insertKey(teamA, "old", new Date("2026-01-01T00:00:00Z"));
    await db.insert(schema.oauthClient).values({
      id: "oc1",
      clientId: "client-abc",
      name: "Claude",
      redirectUris: ["https://claude.ai/cb"],
    });
    const byKey = await insertRequest({
      teamId: teamA,
      method: "GET",
      path: "/domains",
      apiKeyId: k.id,
      createdAt: hoursAgo(1),
    });
    const byOldKey = await insertRequest({
      teamId: teamA,
      method: "GET",
      path: "/domains",
      apiKeyId: old.id,
      createdAt: hoursAgo(2),
    });
    const mcpBatch = await insertRequest({
      teamId: teamA,
      path: "/contacts/batch",
      oauthClientId: "client-abc",
      createdAt: hoursAgo(72),
    });
    const underscore = await insertRequest({
      teamId: teamA,
      path: "/contacts/a_b",
      statusCode: 404,
      oauthClientId: "client-gone",
      createdAt: hoursAgo(120),
    });
    // An MCP row logged before the client id was recorded.
    const dash = await insertRequest({
      teamId: teamA,
      path: "/contacts/a-b",
      createdAt: hoursAgo(240),
    });
    return { teamA, k, old, byKey, byOldKey, mcpBatch, underscore, dash };
  }

  it("narrows by method, source and time window", async () => {
    const { teamA, k, byKey, byOldKey, mcpBatch, underscore, dash } = await seed();
    const c = caller(teamA);
    const ids = async (input: Parameters<typeof c.logs.list>[0]) =>
      (await c.logs.list(input)).items.map((r) => r.id);
    expect(await ids({ method: "GET" })).toEqual([byKey, byOldKey]);
    expect(await ids({ source: "api_key" })).toEqual([byKey, byOldKey]);
    expect(await ids({ source: `api_key:${k.id}` })).toEqual([byKey]);
    expect(await ids({ source: "mcp" })).toEqual([mcpBatch, underscore, dash]);
    expect(await ids({ source: "mcp:client-abc" })).toEqual([mcpBatch]);
    expect(await ids({ since: hoursAgo(48) })).toEqual([byKey, byOldKey]);
    // Filters compose with each other and with the status class.
    expect(
      (await c.logs.list({ source: "mcp", statusClass: "4xx" })).items.map((r) => r.id),
    ).toEqual([underscore]);
  });

  it("rejects a malformed source instead of passing it to postgres", async () => {
    const { teamA } = await seed();
    const c = caller(teamA);
    for (const source of ["bogus", "api_key:", "api_key:not-a-uuid", "mcp:"]) {
      await expect(c.logs.list({ source })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
  });

  it("lists the team's keys (revoked flagged, last) and the clients seen in its log", async () => {
    const { teamA, k, old } = await seed();
    const teamB = await createTeam(db, "team-b");
    await insertKey(teamB, "other-team");
    await insertRequest({ teamId: teamB, oauthClientId: "client-elsewhere" });

    const callers = await caller(teamA).logs.callers();
    expect(callers.apiKeys).toEqual([
      { id: k.id, name: "k", tokenPrefix: expect.any(String), last4: k.last4, revoked: false },
      { id: old.id, name: "old", tokenPrefix: expect.any(String), last4: old.last4, revoked: true },
    ]);
    // A client whose registration is gone still appears, by id.
    expect(callers.apps).toEqual([
      { clientId: "client-abc", name: "Claude" },
      { clientId: "client-gone", name: null },
    ]);
  });

  it("searches the path as a literal substring, escaping LIKE wildcards", async () => {
    const { teamA, mcpBatch, underscore, dash } = await seed();
    const c = caller(teamA);
    expect((await c.logs.list({ search: "contacts" })).items.map((r) => r.id)).toEqual([
      mcpBatch,
      underscore,
      dash,
    ]);
    // An unescaped "_" would also match "a-b"; an unescaped "%" would match everything.
    expect((await c.logs.list({ search: "a_b" })).items.map((r) => r.id)).toEqual([underscore]);
    expect((await c.logs.list({ search: "a%b" })).items).toEqual([]);
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

  it("names the caller: key name and revocation, or the connected app", async () => {
    const teamA = await createTeam(db, "team-a");
    const key = generateApiKey();
    const [k] = await db
      .insert(schema.apiKeys)
      .values({
        teamId: teamA,
        name: "prod",
        tokenPrefix: key.tokenPrefix,
        keyHash: key.keyHash,
        last4: key.last4,
        revokedAt: new Date(),
      })
      .returning({ id: schema.apiKeys.id });
    await db.insert(schema.oauthClient).values({
      id: "oc1",
      clientId: "client-abc",
      name: "Claude",
      redirectUris: ["https://claude.ai/cb"],
    });
    const c = caller(teamA);

    const byKey = await c.logs.get({ id: await insertRequest({ teamId: teamA, apiKeyId: k?.id }) });
    expect(byKey).toMatchObject({ apiKeyName: "prod", apiKeyRevoked: true, oauthClientName: null });

    const byApp = await c.logs.get({
      id: await insertRequest({ teamId: teamA, oauthClientId: "client-abc" }),
    });
    expect(byApp).toMatchObject({
      apiKeyName: null,
      apiKeyRevoked: false,
      oauthClientName: "Claude",
    });

    const unknownApp = await c.logs.get({
      id: await insertRequest({ teamId: teamA, oauthClientId: "client-gone" }),
    });
    expect(unknownApp.oauthClientName).toBeNull();
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
