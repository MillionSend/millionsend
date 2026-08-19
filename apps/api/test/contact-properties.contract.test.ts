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
 * Wire-compat gate for contactProperties: the official `resend` npm SDK
 * against a live MillionSend API — create/list/get/update/remove, plus the
 * typed {type, value} property wrappers on GET /contacts/{id}.
 */

let db: Db;
let closeDb: () => Promise<void>;
let server: ServerType;
let resend: Resend;

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
  const teamId = await createTeam(db, "contact-properties-contract");
  const key = generateApiKey();
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

describe("official resend SDK: contactProperties", () => {
  let planId: string;
  let seatsId: string;

  it("creates a string property with a fallback", async () => {
    const created = await resend.contactProperties.create({
      key: "plan",
      type: "string",
      fallbackValue: "free",
    });
    expect(created.error).toBeNull();
    expect(created.data).toMatchObject({ object: "contact_property", id: expect.any(String) });
    planId = created.data?.id ?? "";
  });

  it("creates a number property", async () => {
    const created = await resend.contactProperties.create({
      key: "seats",
      type: "number",
      fallbackValue: 1,
    });
    expect(created.error).toBeNull();
    seatsId = created.data?.id ?? "";
  });

  it("409s a duplicate key, case-insensitively", async () => {
    const dup = await resend.contactProperties.create({ key: "PLAN", type: "string" });
    expect(dup.data).toBeNull();
    expect(dup.error?.statusCode).toBe(409);
    expect(dup.error?.name).toBe("validation_error");
  });

  it("lists properties with camelCased fields and typed fallbacks", async () => {
    const listed = await resend.contactProperties.list();
    expect(listed.error).toBeNull();
    expect(listed.data?.object).toBe("list");
    expect(listed.data?.has_more).toBe(false);
    expect(listed.data?.data).toEqual([
      {
        id: planId,
        key: "plan",
        type: "string",
        fallbackValue: "free",
        createdAt: expect.any(String),
      },
      {
        id: seatsId,
        key: "seats",
        type: "number",
        fallbackValue: 1,
        createdAt: expect.any(String),
      },
    ]);
  });

  it("gets a property", async () => {
    const fetched = await resend.contactProperties.get(seatsId);
    expect(fetched.error).toBeNull();
    expect(fetched.data).toMatchObject({
      object: "contact_property",
      id: seatsId,
      key: "seats",
      type: "number",
      fallbackValue: 1,
      createdAt: expect.any(String),
    });
  });

  it("updates only the fallback value, keeping it typed", async () => {
    const updated = await resend.contactProperties.update({ id: seatsId, fallbackValue: 3 });
    expect(updated.error).toBeNull();
    expect(updated.data).toMatchObject({ object: "contact_property", id: seatsId });
    const fetched = await resend.contactProperties.get(seatsId);
    expect(fetched.data?.fallbackValue).toBe(3);

    const cleared = await resend.contactProperties.update({ id: seatsId, fallbackValue: null });
    expect(cleared.error).toBeNull();
    expect((await resend.contactProperties.get(seatsId)).data?.fallbackValue).toBeNull();
  });

  it("types contact property values per the registry on GET /contacts/{id}", async () => {
    const created = await resend.contacts.create({
      email: "typed@example.com",
      properties: { plan: "pro", seats: 4, nickname: "woz" },
    });
    expect(created.error).toBeNull();
    const fetched = await resend.contacts.get(created.data?.id ?? "");
    expect(fetched.error).toBeNull();
    expect(fetched.data?.properties).toEqual({
      plan: { type: "string", value: "pro" },
      seats: { type: "number", value: 4 },
      // Unregistered keys default to string.
      nickname: { type: "string", value: "woz" },
    });
  });

  it("422s a non-numeric value for a number-typed property", async () => {
    const bad = await resend.contacts.create({
      email: "badseats@example.com",
      properties: { seats: "lots" },
    });
    expect(bad.data).toBeNull();
    expect(bad.error?.statusCode).toBe(422);
    expect(bad.error?.message).toContain("seats");
  });

  it("removes a property; contact values survive as strings", async () => {
    const removed = await resend.contactProperties.remove(seatsId);
    expect(removed.error).toBeNull();
    expect(removed.data).toMatchObject({ object: "contact_property", id: seatsId, deleted: true });

    const gone = await resend.contactProperties.get(seatsId);
    expect(gone.data).toBeNull();
    expect(gone.error?.name).toBe("not_found");

    const contact = await resend.contacts.get({ email: "typed@example.com" });
    expect(contact.data?.properties.seats).toEqual({ type: "string", value: "4" });
  });
});
