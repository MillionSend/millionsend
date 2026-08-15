import { randomBytes } from "node:crypto";
import { EnvKeyring, generateApiKey } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/app.js";

let db: Db;
let close: () => Promise<void>;
let app: ReturnType<typeof createApi>;
let tokenA: string;
let tokenB: string;

const json = async (res: Response) =>
  (await res.json()) as { id: string; data?: unknown[] } & Record<string, unknown>;

async function call(token: string, method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  for (const [slug, setToken] of [
    ["team-a", (t: string) => (tokenA = t)],
    ["team-b", (t: string) => (tokenB = t)],
  ] as const) {
    const teamId = await createTeam(db, slug);
    const key = generateApiKey("live");
    setToken(key.token);
    await db.insert(schema.apiKeys).values({
      teamId,
      name: slug,
      tokenPrefix: key.tokenPrefix,
      keyHash: key.keyHash,
      last4: key.last4,
    });
  }
  app = createApi({
    db,
    keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
    isCloud: true,
    enqueueEmailSend: async () => {},
  });
});

afterAll(async () => {
  await close();
});

describe("audiences API", () => {
  let audienceId: string;
  let contactId: string;

  it("requires an API key", async () => {
    const res = await app.request("/audiences");
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ statusCode: 401, name: "missing_api_key" });
  });

  it("creates an audience with the audience object name", async () => {
    const res = await call(tokenA, "POST", "/audiences", { name: "news" });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toMatchObject({ object: "audience", name: "news" });
    audienceId = body.id;
  });

  it("serves the same audience as a segment on /segments", async () => {
    const res = await call(tokenA, "GET", `/segments/${audienceId}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ object: "segment", id: audienceId, name: "news" });
  });

  it("allows duplicate audience names", async () => {
    const res = await call(tokenA, "POST", "/audiences", { name: "news" });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.id).not.toBe(audienceId);
    await call(tokenA, "DELETE", `/audiences/${body.id}`);
  });

  it("creates a contact and finds it by uuid or email", async () => {
    const res = await call(tokenA, "POST", `/audiences/${audienceId}/contacts`, {
      email: "Zoe@Example.com",
      first_name: "Zoe",
    });
    expect(res.status).toBe(200);
    contactId = (await json(res)).id;

    const byId = await call(tokenA, "GET", `/audiences/${audienceId}/contacts/${contactId}`);
    expect(byId.status).toBe(200);
    // Lookup by email is case-insensitive.
    const byEmail = await call(tokenA, "GET", `/audiences/${audienceId}/contacts/zoe@example.com`);
    expect(byEmail.status).toBe(200);
    expect((await json(byEmail)).id).toBe(contactId);
  });

  it("409s a duplicate email regardless of case", async () => {
    const res = await call(tokenA, "POST", `/audiences/${audienceId}/contacts`, {
      email: "zoe@example.com",
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ statusCode: 409, name: "conflict" });
  });

  it("patches unsubscribed and clears a name with null", async () => {
    const patch = await call(tokenA, "PATCH", `/audiences/${audienceId}/contacts/${contactId}`, {
      unsubscribed: true,
      first_name: null,
    });
    expect(patch.status).toBe(200);
    const got = await call(tokenA, "GET", `/audiences/${audienceId}/contacts/${contactId}`);
    expect(await got.json()).toMatchObject({ unsubscribed: true, first_name: null });
  });

  it("isolates tenants: team B cannot see or touch team A data", async () => {
    const list = await call(tokenB, "GET", "/audiences");
    expect((await json(list)).data).toEqual([]);

    for (const [method, path, body] of [
      ["GET", `/audiences/${audienceId}`, undefined],
      ["DELETE", `/audiences/${audienceId}`, undefined],
      ["GET", `/audiences/${audienceId}/contacts`, undefined],
      ["POST", `/audiences/${audienceId}/contacts`, { email: "b@example.com" }],
      ["GET", `/audiences/${audienceId}/contacts/${contactId}`, undefined],
      ["PATCH", `/audiences/${audienceId}/contacts/${contactId}`, { unsubscribed: true }],
      ["DELETE", `/audiences/${audienceId}/contacts/${contactId}`, undefined],
    ] as const) {
      const res = await call(tokenB, method, path, body);
      expect(res.status, `${method} ${path}`).toBe(404);
    }

    // Team A still sees its contact untouched.
    const still = await call(tokenA, "GET", `/audiences/${audienceId}/contacts/${contactId}`);
    expect(still.status).toBe(200);
  });

  it("cascades contact deletion with the audience", async () => {
    const del = await call(tokenA, "DELETE", `/audiences/${audienceId}`);
    expect(del.status).toBe(200);
    expect(await del.json()).toMatchObject({ object: "audience", deleted: true });
    const rows = await db.select().from(schema.contacts);
    expect(rows).toEqual([]);
  });
});
