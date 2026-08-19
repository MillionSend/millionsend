import { randomBytes } from "node:crypto";
import { EnvKeyring, generateApiKey, signWebhook, verifyWebhookSignature } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApi } from "../src/app.js";

let db: Db;
let close: () => Promise<void>;
let app: ReturnType<typeof createApi>;
let keyring: EnvKeyring;
let teamId: string;
let fullKey: string;
let sendKey: string;
let otherTeamKey: string;

function call(token: string, method: string, path: string, body?: unknown) {
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
  team: string,
  overrides: Partial<typeof schema.apiKeys.$inferInsert> = {},
) {
  const key = generateApiKey();
  await db.insert(schema.apiKeys).values({
    teamId: team,
    name: "seed",
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
    ...overrides,
  });
  return key.token;
}

async function createWebhook(body: unknown): Promise<{ id: string; signing_secret: string }> {
  const res = await call(fullKey, "POST", "/webhooks", body);
  expect(res.status).toBe(200);
  return (await res.json()) as { id: string; signing_secret: string };
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "webhooks-team");
  const otherTeamId = await createTeam(db, "webhooks-other-team");
  fullKey = await insertKey(teamId);
  sendKey = await insertKey(teamId, { permission: "sending_access" });
  otherTeamKey = await insertKey(otherTeamId);
  keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
  app = createApi({ db, keyring, isCloud: false, enqueueEmailSend: async () => {} });
});
afterAll(() => close());

describe("POST /webhooks", () => {
  it("creates an endpoint, storing the secret only encrypted", async () => {
    const created = await createWebhook({
      endpoint: "https://example.com/hooks",
      events: ["email.delivered", "email.bounced", "email.delivered"],
    });
    expect(created.signing_secret).toMatch(/^whsec_/);

    const [row] = await db
      .select()
      .from(schema.webhookEndpoints)
      .where(eq(schema.webhookEndpoints.id, created.id));
    expect(row).toMatchObject({
      teamId,
      url: "https://example.com/hooks",
      status: "enabled",
      // Duplicates collapse.
      events: ["email.delivered", "email.bounced"],
      secretLast4: created.signing_secret.slice(-4),
    });
    // No column of the persisted row contains the plaintext secret.
    for (const [column, value] of Object.entries(row ?? {})) {
      expect(String(value), `column ${column}`).not.toContain(created.signing_secret);
    }
    // The secret signs verifiable Standard Webhooks signatures.
    const headers = {
      msgId: "msg_test",
      timestamp: Math.floor(Date.now() / 1000),
      payload: '{"type":"email.delivered"}',
    };
    const signed = signWebhook(created.signing_secret, headers);
    expect(
      verifyWebhookSignature(
        created.signing_secret,
        {
          id: signed["webhook-id"],
          timestamp: signed["webhook-timestamp"],
          signature: signed["webhook-signature"],
        },
        headers.payload,
      ),
    ).toBe(true);
  });

  it("redacts signing_secret from the request log", async () => {
    const created = await createWebhook({
      endpoint: "https://example.com/hooks/logged",
      events: ["email.sent"],
    });
    await vi.waitFor(async () => {
      const logs = await db
        .select()
        .from(schema.apiRequests)
        .where(eq(schema.apiRequests.path, "/webhooks"));
      const entry = logs.find(
        (l) => l.method === "POST" && (l.responseBody as { id?: string } | null)?.id === created.id,
      );
      expect(entry).toBeDefined();
      expect(entry?.responseBody).toMatchObject({ signing_secret: "[redacted]" });
      expect(JSON.stringify(entry)).not.toContain(created.signing_secret);
    });
  });

  it("422s http endpoints, unknown events, and empty events", async () => {
    for (const body of [
      { endpoint: "http://example.com/hooks", events: ["email.sent"] },
      { endpoint: "https://example.com/hooks", events: ["contact.created"] },
      { endpoint: "https://example.com/hooks", events: [] },
      { endpoint: "https://example.com/hooks" },
    ]) {
      const res = await call(fullKey, "POST", "/webhooks", body);
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
  });
});

describe("GET /webhooks and GET /webhooks/{id}", () => {
  it("get returns the signing secret; list rows never do", async () => {
    const created = await createWebhook({
      endpoint: "https://example.com/hooks/get",
      events: ["email.opened"],
    });

    const got = await call(fullKey, "GET", `/webhooks/${created.id}`);
    expect(got.status).toBe(200);
    expect(await got.json()).toEqual({
      object: "webhook",
      id: created.id,
      endpoint: "https://example.com/hooks/get",
      status: "enabled",
      events: ["email.opened"],
      created_at: expect.any(String),
      signing_secret: created.signing_secret,
    });

    const list = await call(fullKey, "GET", "/webhooks?limit=100");
    const listBody = (await list.json()) as {
      object: string;
      data: Record<string, unknown>[];
      has_more: boolean;
    };
    expect(listBody.object).toBe("list");
    const row = listBody.data.find((r) => r.id === created.id);
    expect(row).toBeDefined();
    expect(Object.keys(row ?? {}).sort()).toEqual([
      "created_at",
      "endpoint",
      "events",
      "id",
      "status",
    ]);
    expect(JSON.stringify(listBody)).not.toContain(created.signing_secret);
  });

  it("paginates with keyset cursors", async () => {
    const first = await call(fullKey, "GET", "/webhooks?limit=1");
    const firstBody = (await first.json()) as { data: { id: string }[]; has_more: boolean };
    expect(firstBody.data).toHaveLength(1);
    expect(firstBody.has_more).toBe(true);

    const next = await call(fullKey, "GET", `/webhooks?limit=100&after=${firstBody.data[0]?.id}`);
    const nextBody = (await next.json()) as { data: { id: string }[] };
    expect(nextBody.data.some((r) => r.id === firstBody.data[0]?.id)).toBe(false);
  });

  it("serializes dashboard states: null events stay null, auto_disabled reads disabled", async () => {
    const created = await createWebhook({
      endpoint: "https://example.com/hooks/dash",
      events: ["email.sent"],
    });
    await db
      .update(schema.webhookEndpoints)
      .set({ events: null, status: "auto_disabled" })
      .where(eq(schema.webhookEndpoints.id, created.id));

    const got = await call(fullKey, "GET", `/webhooks/${created.id}`);
    expect(await got.json()).toMatchObject({ events: null, status: "disabled" });
  });

  it("404s a foreign team's webhook", async () => {
    const created = await createWebhook({
      endpoint: "https://example.com/hooks/foreign",
      events: ["email.sent"],
    });
    expect((await call(otherTeamKey, "GET", `/webhooks/${created.id}`)).status).toBe(404);
  });
});

describe("PATCH /webhooks/{id}", () => {
  it("updates endpoint, events, and status independently", async () => {
    const created = await createWebhook({
      endpoint: "https://example.com/hooks/patch",
      events: ["email.sent"],
    });

    const res = await call(fullKey, "PATCH", `/webhooks/${created.id}`, {
      endpoint: "https://example.com/hooks/patched",
      events: ["email.bounced", "email.complained"],
      status: "disabled",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ object: "webhook", id: created.id });

    const got = (await (await call(fullKey, "GET", `/webhooks/${created.id}`)).json()) as Record<
      string,
      unknown
    >;
    expect(got).toMatchObject({
      endpoint: "https://example.com/hooks/patched",
      events: ["email.bounced", "email.complained"],
      status: "disabled",
    });

    // Re-enable only; other fields untouched. An empty body is a valid no-op.
    await call(fullKey, "PATCH", `/webhooks/${created.id}`, { status: "enabled" });
    expect((await call(fullKey, "PATCH", `/webhooks/${created.id}`, {})).status).toBe(200);
    const after = (await (await call(fullKey, "GET", `/webhooks/${created.id}`)).json()) as Record<
      string,
      unknown
    >;
    expect(after).toMatchObject({
      endpoint: "https://example.com/hooks/patched",
      status: "enabled",
    });
  });

  it("422s bad updates and 404s foreign ids", async () => {
    const created = await createWebhook({
      endpoint: "https://example.com/hooks/patch-bad",
      events: ["email.sent"],
    });
    for (const body of [
      { endpoint: "http://plain.example.com" },
      { events: ["nope"] },
      { events: [] },
      { status: "auto_disabled" },
    ]) {
      const res = await call(fullKey, "PATCH", `/webhooks/${created.id}`, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
    expect(
      (await call(otherTeamKey, "PATCH", `/webhooks/${created.id}`, { status: "disabled" })).status,
    ).toBe(404);
  });
});

describe("DELETE /webhooks/{id}", () => {
  it("hard-deletes the endpoint and its deliveries", async () => {
    const created = await createWebhook({
      endpoint: "https://example.com/hooks/doomed",
      events: ["email.sent"],
    });
    await db.insert(schema.webhookDeliveries).values({
      endpointId: created.id,
      messageId: "msg_doomed",
      eventType: "email.sent",
      payload: { type: "email.sent" },
    });

    const res = await call(fullKey, "DELETE", `/webhooks/${created.id}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ object: "webhook", id: created.id, deleted: true });

    expect((await call(fullKey, "GET", `/webhooks/${created.id}`)).status).toBe(404);
    const deliveries = await db
      .select()
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.endpointId, created.id));
    expect(deliveries).toHaveLength(0);

    expect((await call(fullKey, "DELETE", `/webhooks/${created.id}`)).status).toBe(404);
  });

  it("404s a foreign team's webhook without deleting it", async () => {
    const created = await createWebhook({
      endpoint: "https://example.com/hooks/kept",
      events: ["email.sent"],
    });
    expect((await call(otherTeamKey, "DELETE", `/webhooks/${created.id}`)).status).toBe(404);
    expect((await call(fullKey, "GET", `/webhooks/${created.id}`)).status).toBe(200);
  });
});

describe("permission confinement", () => {
  it("403s a sending_access key on every /webhooks route", async () => {
    for (const [method, path, body] of [
      ["GET", "/webhooks", undefined],
      ["POST", "/webhooks", { endpoint: "https://example.com/x", events: ["email.sent"] }],
      ["GET", `/webhooks/${crypto.randomUUID()}`, undefined],
      ["PATCH", `/webhooks/${crypto.randomUUID()}`, { status: "disabled" }],
      ["DELETE", `/webhooks/${crypto.randomUUID()}`, undefined],
    ] as const) {
      const res = await call(sendKey, method, path, body);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(await res.json()).toMatchObject({ statusCode: 403, name: "restricted_api_key" });
    }
  });
});
