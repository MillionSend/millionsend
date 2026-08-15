import { randomBytes } from "node:crypto";
import { type ServerType, serve } from "@hono/node-server";
import { EnvKeyring, generateApiKey } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { Resend } from "resend";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/app.js";

/**
 * Wire-compat gate for the SDK's top-level /contacts surface: when audienceId
 * is omitted, resend v6 hits GET/POST/PATCH/DELETE /contacts and
 * /contacts/{idOrEmail} directly. Also covers list pagination
 * (limit/after/before), which the SDK sends as query params.
 */

let db: Db;
let closeDb: () => Promise<void>;
let server: ServerType;
let resend: Resend;
let teamId: string;
let audienceId: string;

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
  teamId = await createTeam(db, "contacts-root");
  const key = generateApiKey("test");
  await db.insert(schema.apiKeys).values({
    teamId,
    name: "contract",
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
  });
  const [audience] = await db
    .insert(schema.audiences)
    .values({ teamId, name: "root" })
    .returning({ id: schema.audiences.id });
  if (!audience) throw new Error("audience insert failed");
  audienceId = audience.id;
  const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
  const app = createApi({ db, keyring, isCloud: true, enqueueEmailSend: async () => {} });
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  resend = new Resend(key.token, { baseUrl: `http://127.0.0.1:${address.port}` });
});

afterAll(async () => {
  server.close();
  await closeDb();
});

describe("official resend SDK: top-level /contacts", () => {
  let contactId: string;

  it("rejects audience-less create loudly (contacts require an audience)", async () => {
    const created = await resend.contacts.create({ email: "no-home@example.com" });
    expect(created.data).toBeNull();
    expect(created.error?.statusCode).toBe(422);
    expect(created.error?.name).toBe("validation_error");
    expect(created.error?.message).toContain("audience_id is required");
  });

  it("rejects contact properties loudly instead of stripping them", async () => {
    const created = await resend.contacts.create({
      audienceId,
      email: "props@example.com",
      properties: { plan: "pro" },
    });
    expect(created.data).toBeNull();
    expect(created.error?.statusCode).toBe(422);
    expect(created.error?.message).toContain("properties");
  });

  it("gets a contact by bare id and by email, with the required properties field", async () => {
    const created = await resend.contacts.create({ audienceId, email: "root@example.com" });
    expect(created.error).toBeNull();
    contactId = created.data?.id ?? "";

    // string form → GET /contacts/{id}
    const byId = await resend.contacts.get(contactId);
    expect(byId.error).toBeNull();
    expect(byId.data).toMatchObject({
      object: "contact",
      id: contactId,
      email: "root@example.com",
      properties: {},
    });

    // {email} without audienceId → GET /contacts/{email}
    const byEmail = await resend.contacts.get({ email: "root@example.com" });
    expect(byEmail.error).toBeNull();
    expect(byEmail.data?.id).toBe(contactId);
  });

  it("updates by id without an audienceId and rejects properties", async () => {
    const updated = await resend.contacts.update({ id: contactId, unsubscribed: true });
    expect(updated.error).toBeNull();
    expect(updated.data?.id).toBe(contactId);
    const fetched = await resend.contacts.get(contactId);
    expect(fetched.data?.unsubscribed).toBe(true);

    const rejected = await resend.contacts.update({
      id: contactId,
      properties: { plan: "pro" },
    });
    expect(rejected.data).toBeNull();
    expect(rejected.error?.statusCode).toBe(422);
  });

  it("removes by bare id, then get 404s", async () => {
    const removed = await resend.contacts.remove(contactId);
    expect(removed.error).toBeNull();
    expect(removed.data).toMatchObject({ deleted: true, contact: contactId });

    const gone = await resend.contacts.get(contactId);
    expect(gone.data).toBeNull();
    expect(gone.error?.name).toBe("not_found");
  });

  it("is tenant-isolated: another team's key cannot reach a contact by email", async () => {
    const created = await resend.contacts.create({ audienceId, email: "mine@example.com" });
    expect(created.error).toBeNull();

    const otherTeam = await createTeam(db, "contacts-root-b");
    const otherKey = generateApiKey("test");
    await db.insert(schema.apiKeys).values({
      teamId: otherTeam,
      name: "other",
      tokenPrefix: otherKey.tokenPrefix,
      keyHash: otherKey.keyHash,
      last4: otherKey.last4,
    });
    const intruder = new Resend(otherKey.token, { baseUrl: resend.baseUrl as string });
    for (const attempt of [
      await intruder.contacts.get({ email: "mine@example.com" }),
      await intruder.contacts.update({ email: "mine@example.com", unsubscribed: true }),
      await intruder.contacts.remove({ email: "mine@example.com" }),
    ]) {
      expect(attempt.data).toBeNull();
      expect(attempt.error?.name).toBe("not_found");
    }
    await resend.contacts.remove({ email: "mine@example.com" });
  });

  it("paginates the team-wide contact list with limit/after/before", async () => {
    const emails = ["pg1@example.com", "pg2@example.com", "pg3@example.com"];
    for (const email of emails) {
      const created = await resend.contacts.create({ audienceId, email });
      expect(created.error).toBeNull();
    }

    const page1 = await resend.contacts.list({ limit: 2 });
    expect(page1.error).toBeNull();
    expect(page1.data?.data).toHaveLength(2);
    expect(page1.data?.has_more).toBe(true);

    const cursor = page1.data?.data[1]?.id ?? "";
    const page2 = await resend.contacts.list({ limit: 2, after: cursor });
    expect(page2.error).toBeNull();
    expect(page2.data?.data).toHaveLength(1);
    expect(page2.data?.has_more).toBe(false);
    const seen = new Set(page1.data?.data.map((c) => c.id));
    expect(seen.has(page2.data?.data[0]?.id ?? "")).toBe(false);

    const backCursor = page2.data?.data[0]?.id ?? "";
    const before = await resend.contacts.list({ limit: 5, before: backCursor });
    expect(before.error).toBeNull();
    expect(before.data?.data.map((c) => c.id)).toEqual(page1.data?.data.map((c) => c.id));
    expect(before.data?.has_more).toBe(false);
  });
});
