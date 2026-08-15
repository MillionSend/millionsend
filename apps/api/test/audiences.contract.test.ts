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
 * Wire-compat gate for audiences/contacts: the official `resend` npm SDK
 * against a live MillionSend API. Note the SDK's own routing: audiences.*
 * goes to /segments, contacts.* CRUD to /audiences/{id}/contacts, and
 * contacts.list to /segments/{id}/contacts — this suite covers all three.
 */

let db: Db;
let closeDb: () => Promise<void>;
let server: ServerType;
let resend: Resend;

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
  const teamId = await createTeam(db, "aud-contract");
  const key = generateApiKey("test");
  await db.insert(schema.apiKeys).values({
    teamId,
    name: "contract",
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
  });
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

describe("official resend SDK: audiences + contacts", () => {
  let audienceId: string;
  let contactId: string;

  it("creates, lists, and gets an audience", async () => {
    const created = await resend.audiences.create({ name: "newsletter" });
    expect(created.error).toBeNull();
    expect(created.data?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.data?.name).toBe("newsletter");
    audienceId = created.data?.id ?? "";

    const listed = await resend.audiences.list();
    expect(listed.error).toBeNull();
    expect(listed.data?.data).toEqual([
      { id: audienceId, name: "newsletter", created_at: expect.any(String) },
    ]);

    const fetched = await resend.audiences.get(audienceId);
    expect(fetched.error).toBeNull();
    expect(fetched.data).toMatchObject({ id: audienceId, name: "newsletter" });
  });

  it("creates a contact and rejects a duplicate email with 409", async () => {
    const created = await resend.contacts.create({
      audienceId,
      email: "ana@example.com",
      firstName: "Ana",
      lastName: "Souza",
    });
    expect(created.error).toBeNull();
    expect(created.data?.id).toMatch(/^[0-9a-f-]{36}$/);
    contactId = created.data?.id ?? "";

    // Duplicate detection is case-insensitive.
    const dup = await resend.contacts.create({ audienceId, email: "ANA@example.com" });
    expect(dup.data).toBeNull();
    expect(dup.error?.statusCode).toBe(409);
    // Must be a RESEND_ERROR_CODE_KEY member ('conflict' is not one).
    expect(dup.error?.name).toBe("validation_error");
  });

  it("lists contacts through the SDK's segment path", async () => {
    const listed = await resend.contacts.list({ audienceId });
    expect(listed.error).toBeNull();
    expect(listed.data?.data).toEqual([
      {
        id: contactId,
        email: "ana@example.com",
        first_name: "Ana",
        last_name: "Souza",
        created_at: expect.any(String),
        unsubscribed: false,
      },
    ]);
  });

  it("gets a contact by id and by email", async () => {
    const byId = await resend.contacts.get({ audienceId, id: contactId });
    expect(byId.error).toBeNull();
    expect(byId.data).toMatchObject({ id: contactId, email: "ana@example.com" });

    const byEmail = await resend.contacts.get({ audienceId, email: "ana@example.com" });
    expect(byEmail.error).toBeNull();
    expect(byEmail.data?.id).toBe(contactId);
  });

  it("round-trips custom properties through the SDK", async () => {
    const created = await resend.contacts.create({
      audienceId,
      email: "props@example.com",
      properties: { plan: "pro", seats: 3 },
    });
    expect(created.error).toBeNull();
    const id = created.data?.id ?? "";

    const fetched = await resend.contacts.get({ audienceId, id });
    expect(fetched.error).toBeNull();
    // Stored flat string→string; scalars coerced. The SDK types properties as a
    // {type,value} map, so read the runtime shape through a cast.
    expect((fetched.data as unknown as { properties: Record<string, string> }).properties).toEqual({
      plan: "pro",
      seats: "3",
    });

    await resend.contacts.remove({ audienceId, id });
  });

  it("updates a contact by email and reads the change back", async () => {
    const updated = await resend.contacts.update({
      audienceId,
      email: "ana@example.com",
      unsubscribed: true,
      firstName: "Ana Maria",
    });
    expect(updated.error).toBeNull();
    expect(updated.data?.id).toBe(contactId);

    const fetched = await resend.contacts.get({ audienceId, id: contactId });
    expect(fetched.data).toMatchObject({ unsubscribed: true, first_name: "Ana Maria" });
  });

  it("removes a contact by email, then get 404s", async () => {
    const removed = await resend.contacts.remove({ audienceId, email: "ana@example.com" });
    expect(removed.error).toBeNull();
    expect(removed.data).toMatchObject({ deleted: true, contact: contactId });

    const gone = await resend.contacts.get({ audienceId, id: contactId });
    expect(gone.data).toBeNull();
    expect(gone.error?.name).toBe("not_found");
  });

  it("removes the audience", async () => {
    const removed = await resend.audiences.remove(audienceId);
    expect(removed.error).toBeNull();
    expect(removed.data).toMatchObject({ id: audienceId, deleted: true });

    const gone = await resend.audiences.get(audienceId);
    expect(gone.data).toBeNull();
    expect(gone.error?.name).toBe("not_found");
  });
});
