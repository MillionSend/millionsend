import { randomBytes } from "node:crypto";
import { type ServerType, serve } from "@hono/node-server";
import { EnvKeyring, generateApiKey, signWebhook } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { Resend } from "resend";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/app.js";

/**
 * Wire-compat gate for webhooks: the official `resend` npm SDK against a live
 * MillionSend API — create/list/get/update/remove, signing_secret placement
 * (create + get, never list rows), and that the secret we mint verifies with
 * the SDK's own standardwebhooks-based `webhooks.verify`.
 */

let db: Db;
let closeDb: () => Promise<void>;
let server: ServerType;
let resend: Resend;

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
  const teamId = await createTeam(db, "webhooks-contract");
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

describe("official resend SDK: webhooks", () => {
  let webhookId: string;
  let signingSecret: string;

  it("creates a webhook, returning the signing secret", async () => {
    const created = await resend.webhooks.create({
      endpoint: "https://example.com/hooks/contract",
      events: ["email.sent", "email.delivered"],
    });
    expect(created.error).toBeNull();
    expect(created.data).toMatchObject({
      object: "webhook",
      id: expect.any(String),
      signing_secret: expect.stringMatching(/^whsec_/),
    });
    webhookId = created.data?.id ?? "";
    signingSecret = created.data?.signing_secret ?? "";
  });

  it("gets the webhook, signing secret included", async () => {
    const fetched = await resend.webhooks.get(webhookId);
    expect(fetched.error).toBeNull();
    expect(fetched.data).toEqual({
      object: "webhook",
      id: webhookId,
      created_at: expect.any(String),
      status: "enabled",
      endpoint: "https://example.com/hooks/contract",
      events: ["email.sent", "email.delivered"],
      signing_secret: signingSecret,
    });
  });

  it("lists webhooks without signing secrets", async () => {
    const listed = await resend.webhooks.list();
    expect(listed.error).toBeNull();
    expect(listed.data?.object).toBe("list");
    expect(listed.data?.has_more).toBe(false);
    expect(listed.data?.data).toEqual([
      {
        id: webhookId,
        endpoint: "https://example.com/hooks/contract",
        created_at: expect.any(String),
        status: "enabled",
        events: ["email.sent", "email.delivered"],
      },
    ]);
    expect(JSON.stringify(listed.data)).not.toContain(signingSecret);
  });

  it("verifies our signatures via the SDK's webhooks.verify under both header names", () => {
    const payload = JSON.stringify({
      type: "email.delivered",
      created_at: new Date().toISOString(),
      data: { email_id: "00000000-0000-0000-0000-000000000000" },
    });
    const headers = signWebhook(signingSecret, {
      msgId: "msg_contract",
      timestamp: Math.floor(Date.now() / 1000),
      payload,
    });
    // Resend's docs tell receivers to read svix-*; Standard Webhooks says webhook-*.
    for (const prefix of ["webhook", "svix"] as const) {
      const event = resend.webhooks.verify({
        payload,
        webhookSecret: signingSecret,
        headers: {
          id: headers[`${prefix}-id`],
          timestamp: headers[`${prefix}-timestamp`],
          signature: headers[`${prefix}-signature`],
        },
      });
      expect(event, prefix).toMatchObject({ type: "email.delivered" });
    }
  });

  it("keeps a secret carried over from Resend: create with it, read it back, verify", async () => {
    // Resend's GET /webhooks/{id} returns the secret; a migrating user passes
    // it on create so the receiver they already run verifies unchanged.
    const carried = `whsec_${randomBytes(24).toString("base64")}`;
    const created = await resend.post<{ object: "webhook"; id: string; signing_secret: string }>(
      "/webhooks",
      {
        endpoint: "https://example.com/hooks/migrated",
        events: ["email.delivered"],
        signing_secret: carried,
      },
    );
    expect(created.error).toBeNull();
    expect(created.data?.signing_secret).toBe(carried);
    const id = created.data?.id ?? "";

    const fetched = await resend.webhooks.get(id);
    expect(fetched.data?.signing_secret).toBe(carried);

    const payload = JSON.stringify({
      type: "email.delivered",
      created_at: new Date().toISOString(),
      data: { email_id: "00000000-0000-0000-0000-000000000000" },
    });
    const headers = signWebhook(carried, {
      msgId: "msg_migrated",
      timestamp: Math.floor(Date.now() / 1000),
      payload,
    });
    const event = resend.webhooks.verify({
      payload,
      webhookSecret: carried,
      headers: {
        id: headers["svix-id"],
        timestamp: headers["svix-timestamp"],
        signature: headers["svix-signature"],
      },
    });
    expect(event).toMatchObject({ type: "email.delivered" });

    const removed = await resend.webhooks.remove(id);
    expect(removed.error).toBeNull();
  });

  it("updates endpoint, events, and status", async () => {
    const updated = await resend.webhooks.update(webhookId, {
      endpoint: "https://example.com/hooks/contract-v2",
      events: ["email.bounced"],
      status: "disabled",
    });
    expect(updated.error).toBeNull();
    expect(updated.data).toMatchObject({ object: "webhook", id: webhookId });

    const fetched = await resend.webhooks.get(webhookId);
    expect(fetched.data).toMatchObject({
      endpoint: "https://example.com/hooks/contract-v2",
      events: ["email.bounced"],
      status: "disabled",
    });
  });

  it("422s events outside the emitted union", async () => {
    const bad = await resend.webhooks.create({
      endpoint: "https://example.com/hooks/bad",
      events: ["contact.created"],
    });
    expect(bad.data).toBeNull();
    expect(bad.error?.statusCode).toBe(422);
    expect(bad.error?.name).toBe("validation_error");

    const badSecret = await resend.post("/webhooks", {
      endpoint: "https://example.com/hooks/bad",
      events: ["email.sent"],
      signing_secret: "whsec_nope",
    });
    expect(badSecret.data).toBeNull();
    expect(badSecret.error).toMatchObject({
      statusCode: 422,
      name: "validation_error",
      message: "signing_secret must be whsec_ followed by base64 of 24-64 bytes",
    });
  });

  it("removes the webhook", async () => {
    const removed = await resend.webhooks.remove(webhookId);
    expect(removed.error).toBeNull();
    expect(removed.data).toMatchObject({ object: "webhook", id: webhookId, deleted: true });

    const gone = await resend.webhooks.get(webhookId);
    expect(gone.data).toBeNull();
    expect(gone.error?.name).toBe("not_found");
  });
});
