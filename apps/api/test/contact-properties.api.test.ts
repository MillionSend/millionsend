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
let sendToken: string;

const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

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

async function seedTeam(slug: string, permission?: "sending_access"): Promise<string> {
  const teamId = await createTeam(db, slug);
  const key = generateApiKey();
  await db.insert(schema.apiKeys).values({
    teamId,
    name: slug,
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
    ...(permission ? { permission } : {}),
  });
  return key.token;
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  tokenA = await seedTeam("props-a");
  tokenB = await seedTeam("props-b");
  sendToken = await seedTeam("props-send", "sending_access");
  app = createApi({
    db,
    keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
    isCloud: true,
    enqueueEmailSend: async () => {},
  });
});
afterAll(() => close());

describe("contact properties API (/contact-properties)", () => {
  let numberId: string;

  it("requires an API key, and a full-access one", async () => {
    expect((await app.request("/contact-properties")).status).toBe(401);
    expect((await call(sendToken, "GET", "/contact-properties")).status).toBe(403);
  });

  it("422s a non-numeric fallback for a number property", async () => {
    const res = await call(tokenA, "POST", "/contact-properties", {
      key: "seats",
      type: "number",
      fallback_value: "many",
    });
    expect(res.status).toBe(422);
    expect((await json(res)).message).toBe("fallback_value must be a number");
  });

  it("creates a number property, coercing a numeric-string fallback", async () => {
    const res = await call(tokenA, "POST", "/contact-properties", {
      key: "seats",
      type: "number",
      fallback_value: "2",
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    // Full object on create — an agent can confirm what it made without a re-read.
    expect(body).toMatchObject({
      object: "contact_property",
      key: "seats",
      type: "number",
      fallback_value: 2,
    });
    numberId = body.id as string;

    const fetched = await json(await call(tokenA, "GET", `/contact-properties/${numberId}`));
    expect(fetched).toMatchObject({ key: "seats", type: "number", fallback_value: 2 });
  });

  it("409s a duplicate key regardless of case", async () => {
    const res = await call(tokenA, "POST", "/contact-properties", { key: "SEATS", type: "string" });
    expect(res.status).toBe(409);
    expect((await json(res)).name).toBe("validation_error");
  });

  it("PATCH without fallback_value is a valid no-op; a mismatch 422s", async () => {
    const noop = await call(tokenA, "PATCH", `/contact-properties/${numberId}`, {});
    expect(noop.status).toBe(200);
    expect((await json(noop)).id).toBe(numberId);

    const bad = await call(tokenA, "PATCH", `/contact-properties/${numberId}`, {
      fallback_value: "not-a-number",
    });
    expect(bad.status).toBe(422);
  });

  it("is tenant-isolated: another team's key cannot reach a property", async () => {
    for (const res of [
      await call(tokenB, "GET", `/contact-properties/${numberId}`),
      await call(tokenB, "PATCH", `/contact-properties/${numberId}`, { fallback_value: 9 }),
      await call(tokenB, "DELETE", `/contact-properties/${numberId}`),
    ]) {
      expect(res.status).toBe(404);
    }
  });
});

describe("number-typed property values on /contacts", () => {
  let contactId: string;

  it("coerces a numeric string on create and serves it typed", async () => {
    const created = await call(tokenA, "POST", "/contacts", {
      email: "seats@example.com",
      properties: { seats: "3", plan: "pro" },
    });
    expect(created.status).toBe(200);
    contactId = (await json(created)).id as string;

    const fetched = await json(await call(tokenA, "GET", `/contacts/${contactId}`));
    expect(fetched.properties).toEqual({
      seats: { type: "number", value: 3 },
      plan: { type: "string", value: "pro" },
    });
  });

  it("422s non-numeric values for the number property on create and update", async () => {
    const badCreate = await call(tokenA, "POST", "/contacts", {
      email: "badseats@example.com",
      properties: { seats: "abc" },
    });
    expect(badCreate.status).toBe(422);
    expect((await json(badCreate)).message).toContain("seats");

    const badPatch = await call(tokenA, "PATCH", `/contacts/${contactId}`, {
      properties: { seats: true },
    });
    expect(badPatch.status).toBe(422);
  });

  it("keeps rejecting nested values", async () => {
    const res = await call(tokenA, "PATCH", `/contacts/${contactId}`, {
      properties: { seats: { nested: 1 } },
    });
    expect(res.status).toBe(422);
    expect((await json(res)).message).toContain("flat");
  });

  it("the same key on another team stays untyped (string)", async () => {
    const created = await call(tokenB, "POST", "/contacts", {
      email: "other@example.com",
      properties: { seats: "plenty" },
    });
    expect(created.status).toBe(200);
    const id = (await json(created)).id as string;
    const fetched = await json(await call(tokenB, "GET", `/contacts/${id}`));
    expect(fetched.properties).toEqual({ seats: { type: "string", value: "plenty" } });
  });

  it("deleting the definition reverts values to strings", async () => {
    const list = await json(await call(tokenA, "GET", "/contact-properties"));
    const seats = (list.data as { id: string; key: string }[]).find((p) => p.key === "seats");
    expect(seats).toBeDefined();
    const removed = await call(tokenA, "DELETE", `/contact-properties/${seats?.id}`);
    expect(removed.status).toBe(200);

    const fetched = await json(await call(tokenA, "GET", `/contacts/${contactId}`));
    expect((fetched.properties as Record<string, unknown>).seats).toEqual({
      type: "string",
      value: "3",
    });
  });
});

describe("PATCH /contacts/{id} merges properties", () => {
  let contactId: string;
  let segmentId: string;

  beforeAll(async () => {
    const created = await call(tokenA, "POST", "/contacts", {
      email: "merge@example.com",
      properties: { plan: "free", source: "web", persona: "dev" },
    });
    expect(created.status).toBeLessThan(300);
    contactId = (await json(created)).id as string;
    const segment = await call(tokenA, "POST", "/segments", { name: "merge-alias" });
    segmentId = (await json(segment)).id as string;
  });

  const properties = async () =>
    ((await json(await call(tokenA, "GET", `/contacts/${contactId}`))).properties ?? {}) as Record<
      string,
      { type: string; value: unknown }
    >;

  it("keeps the keys a PATCH does not mention", async () => {
    const res = await call(tokenA, "PATCH", `/contacts/${contactId}`, {
      properties: { plan: "pro" },
    });
    expect(res.status).toBe(200);
    const stored = await properties();
    expect(stored.plan?.value).toBe("pro");
    expect(stored.source?.value).toBe("web");
    expect(stored.persona?.value).toBe("dev");
  });

  it("removes only the keys set to null", async () => {
    const res = await call(tokenA, "PATCH", `/contacts/${contactId}`, {
      properties: { source: null },
    });
    expect(res.status).toBe(200);
    const stored = await properties();
    expect(Object.keys(stored).sort()).toEqual(["persona", "plan"]);
  });

  it("leaves properties alone when the PATCH has none, and treats an empty map as a no-op", async () => {
    expect(
      (await call(tokenA, "PATCH", `/contacts/${contactId}`, { unsubscribed: true })).status,
    ).toBe(200);
    expect((await call(tokenA, "PATCH", `/contacts/${contactId}`, { properties: {} })).status).toBe(
      200,
    );
    expect(Object.keys(await properties()).sort()).toEqual(["persona", "plan"]);
  });

  it("merges through the audiences alias as well", async () => {
    const res = await call(tokenA, "PATCH", `/audiences/${segmentId}/contacts/${contactId}`, {
      properties: { persona: "ops" },
    });
    expect(res.status).toBe(200);
    const stored = await properties();
    expect(stored.persona?.value).toBe("ops");
    expect(stored.plan?.value).toBe("pro");
  });

  it("caps the stored map at 100 keys, and a removal frees a slot", async () => {
    const full = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, "v"]));
    const created = await call(tokenA, "POST", "/contacts", {
      email: "capped@example.com",
      properties: full,
    });
    expect(created.status).toBeLessThan(300);
    const id = (await json(created)).id as string;
    const over = await call(tokenA, "PATCH", `/contacts/${id}`, { properties: { extra: "v" } });
    expect(over.status).toBe(422);
    expect((await json(over)).message).toContain("at most 100 properties");
    const swap = await call(tokenA, "PATCH", `/contacts/${id}`, {
      properties: { k0: null, extra: "v" },
    });
    expect(swap.status).toBe(200);
    const stored = (await json(await call(tokenA, "GET", `/contacts/${id}`))).properties as Record<
      string,
      unknown
    >;
    expect(Object.keys(stored)).toHaveLength(100);
    expect(stored.k0).toBeUndefined();
    expect(stored.extra).toBeDefined();
  });
});

describe("date properties", () => {
  let renewalId: string;

  it("creates a date property, with or without a fallback that reads as a date", async () => {
    const plain = await call(tokenA, "POST", "/contact-properties", {
      key: "last_login",
      type: "date",
    });
    expect(plain.status).toBe(200);
    expect(await json(plain)).toMatchObject({
      object: "contact_property",
      key: "last_login",
      type: "date",
      fallback_value: null,
    });

    const withFallback = await call(tokenA, "POST", "/contact-properties", {
      key: "renewal",
      type: "date",
      fallback_value: " 2026-01-08 ",
    });
    expect(withFallback.status).toBe(200);
    const body = await json(withFallback);
    // Stored trimmed, never rewritten into another form.
    expect(body).toMatchObject({ key: "renewal", type: "date", fallback_value: "2026-01-08" });
    renewalId = body.id as string;

    const list = await json(await call(tokenA, "GET", "/contact-properties"));
    expect(list.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "last_login", type: "date", fallback_value: null }),
        expect.objectContaining({ key: "renewal", type: "date", fallback_value: "2026-01-08" }),
      ]),
    );
  });

  it("422s a fallback that reads as no date, on create and update", async () => {
    for (const fallback_value of ["2026-02-30", "3", "soon"]) {
      const res = await call(tokenA, "POST", "/contact-properties", {
        key: "trial_end",
        type: "date",
        fallback_value,
      });
      expect(res.status, fallback_value).toBe(422);
      expect(await json(res)).toMatchObject({
        name: "validation_error",
        message: "fallback_value must be a date",
      });
    }
    const bad = await call(tokenA, "PATCH", `/contact-properties/${renewalId}`, {
      fallback_value: "next week",
    });
    expect(bad.status).toBe(422);
    expect((await json(bad)).message).toBe("fallback_value must be a date");

    const epoch = await call(tokenA, "PATCH", `/contact-properties/${renewalId}`, {
      fallback_value: 1767225600,
    });
    expect(epoch.status).toBe(200);
    const fetched = await json(await call(tokenA, "GET", `/contact-properties/${renewalId}`));
    expect(fetched.fallback_value).toBe("1767225600");
  });

  it("422s a contact value that reads as no date, matching the key in any case", async () => {
    for (const properties of [
      { last_login: "yesterday" },
      { LAST_LOGIN: "3" },
      { last_login: true },
      { last_login: "2026-02-30" },
    ]) {
      const res = await call(tokenA, "POST", "/contacts", {
        email: "badlogin@example.com",
        properties,
      });
      expect(res.status, JSON.stringify(properties)).toBe(422);
      const body = await json(res);
      expect(body.name).toBe("validation_error");
      expect(body.message).toContain("must be a date");
    }

    const batch = await call(tokenA, "POST", "/contacts/batch", [
      { email: "batch-ok@example.com", properties: { last_login: "2026-01-08" } },
      { email: "batch-bad@example.com", properties: { last_login: "soon" } },
    ]);
    expect(batch.status).toBe(422);
    expect((await json(batch)).message).toContain("last_login");
  });

  it("stores a date as written, trimmed, and serves it typed as date", async () => {
    const created = await call(tokenA, "POST", "/contacts", {
      email: "login@example.com",
      properties: { last_login: " 2026-01-08T10:30:00Z ", plan: "pro" },
    });
    expect(created.status).toBe(200);
    const id = (await json(created)).id as string;
    const fetched = await json(await call(tokenA, "GET", `/contacts/${id}`));
    expect(fetched.properties).toEqual({
      last_login: { type: "date", value: "2026-01-08T10:30:00Z" },
      plan: { type: "string", value: "pro" },
    });

    const patched = await call(tokenA, "PATCH", `/contacts/${id}`, {
      properties: { last_login: 1767225600 },
    });
    expect(patched.status).toBe(200);
    const listed = await json(await call(tokenA, "GET", "/contacts?include=properties"));
    const row = (listed.data as { id: string; properties: Record<string, unknown> }[]).find(
      (c) => c.id === id,
    );
    expect(row?.properties.last_login).toEqual({ type: "date", value: "1767225600" });
  });

  it("serves a value stored before its key was typed as date as a string while it reads as no date", async () => {
    const created = await call(tokenA, "POST", "/contacts", {
      email: "signup@example.com",
      properties: { signup: "soon", joined: "2026-01-08" },
    });
    const id = (await json(created)).id as string;
    for (const key of ["signup", "joined"]) {
      expect(
        (await call(tokenA, "POST", "/contact-properties", { key, type: "date" })).status,
      ).toBe(200);
    }
    const fetched = await json(await call(tokenA, "GET", `/contacts/${id}`));
    expect(fetched.properties).toEqual({
      signup: { type: "string", value: "soon" },
      joined: { type: "date", value: "2026-01-08" },
    });
  });
});
