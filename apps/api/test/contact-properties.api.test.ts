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
    numberId = (await json(res)).id as string;

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
