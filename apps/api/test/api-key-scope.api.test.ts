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
let fullKey: string;
let sendKey: string;
let domainKey: string;

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

async function insertKey(
  teamId: string,
  overrides: Partial<typeof schema.apiKeys.$inferInsert> = {},
) {
  const key = generateApiKey("live");
  await db.insert(schema.apiKeys).values({
    teamId,
    name: "k",
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
    ...overrides,
  });
  return key.token;
}

const fromAcme = { from: "Acme <a@acme.dev>", to: ["r@example.com"], subject: "s", text: "t" };
const fromOther = { from: "Other <a@other.dev>", to: ["r@example.com"], subject: "s", text: "t" };

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  const teamId = await createTeam(db, "scope-team");
  const [acme] = await db
    .insert(schema.domains)
    .values({ teamId, name: "acme.dev", region: "us-east-1", status: "verified" })
    .returning({ id: schema.domains.id });
  await db
    .insert(schema.domains)
    .values({ teamId, name: "other.dev", region: "us-east-1", status: "verified" });
  if (!acme) throw new Error("domain insert failed");

  fullKey = await insertKey(teamId);
  sendKey = await insertKey(teamId, { permission: "sending_access" });
  domainKey = await insertKey(teamId, { domainId: acme.id });

  app = createApi({
    db,
    keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
    isCloud: true,
    enqueueEmailSend: async () => {},
  });
});
afterAll(() => close());

describe("sending_access keys are confined to the send surface", () => {
  it("403s on a management route", async () => {
    const res = await call(sendKey, "GET", "/contacts");
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ statusCode: 403, name: "restricted_api_key" });
  });

  it("403s on broadcast management too", async () => {
    const res = await call(sendKey, "GET", "/broadcasts");
    expect(res.status).toBe(403);
  });

  it("still sends via POST /emails", async () => {
    const res = await call(sendKey, "POST", "/emails", fromAcme);
    expect(res.status).toBe(200);
  });

  it("still reaches the send surface's other routes (not 403)", async () => {
    // A nonexistent id is a 404 from the handler — proof the scope gate let it through.
    const res = await call(sendKey, "POST", `/emails/${crypto.randomUUID()}/cancel`);
    expect(res.status).not.toBe(403);
  });
});

describe("domain-scoped keys may only send from their domain", () => {
  it("403s sending from another verified domain", async () => {
    const res = await call(domainKey, "POST", "/emails", fromOther);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ statusCode: 403, name: "restricted_api_key" });
  });

  it("sends from its own domain", async () => {
    const res = await call(domainKey, "POST", "/emails", fromAcme);
    expect(res.status).toBe(200);
  });

  it("enforces the same rule in a batch", async () => {
    const mixed = await call(domainKey, "POST", "/emails/batch", [fromAcme, fromOther]);
    expect(mixed.status).toBe(403);
    const ok = await call(domainKey, "POST", "/emails/batch", [fromAcme, fromAcme]);
    expect(ok.status).toBe(200);
  });
});

describe("full_access, unrestricted keys are unaffected", () => {
  it("reaches management and both domains", async () => {
    expect((await call(fullKey, "GET", "/contacts")).status).toBe(200);
    expect((await call(fullKey, "POST", "/emails", fromAcme)).status).toBe(200);
    expect((await call(fullKey, "POST", "/emails", fromOther)).status).toBe(200);
  });
});
