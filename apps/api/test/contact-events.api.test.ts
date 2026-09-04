import { randomBytes } from "node:crypto";
import {
  deriveUnsubscribeKey,
  EnvKeyring,
  generateApiKey,
  verifyUnsubscribeToken,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/app.js";

let db: Db;
let close: () => Promise<void>;
let app: ReturnType<typeof createApi>;
let teamId: string;
let token: string;
let endpointId: string;
const enqueued: string[] = [];
const masterKey = randomBytes(32);

function call(method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function deliveries() {
  const rows = await db
    .select({
      id: schema.webhookDeliveries.id,
      eventType: schema.webhookDeliveries.eventType,
      payload: schema.webhookDeliveries.payload,
    })
    .from(schema.webhookDeliveries)
    .where(eq(schema.webhookDeliveries.endpointId, endpointId))
    .orderBy(desc(schema.webhookDeliveries.createdAt), desc(schema.webhookDeliveries.id));
  return rows.map((r) => ({
    ...r,
    data: (r.payload as { data: Record<string, unknown> }).data,
  }));
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "contact-events");
  const key = generateApiKey();
  await db.insert(schema.apiKeys).values({
    teamId,
    name: "seed",
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
  });
  token = key.token;
  app = createApi({
    db,
    keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
    isCloud: false,
    enqueueEmailSend: async () => {},
    enqueueWebhookDelivery: async (id) => {
      enqueued.push(id);
    },
    appBaseUrl: "https://app.example.com",
    unsubscribeSecretKey: deriveUnsubscribeKey(masterKey),
  });
  const created = await call("POST", "/webhooks", {
    endpoint: "https://example.com/hooks/audience",
    events: [
      "contact.created",
      "contact.updated",
      "contact.deleted",
      "contact.unsubscribed",
      "contact.resubscribed",
      "contact.topic_opt_out",
      "suppression.added",
      "suppression.removed",
    ],
  });
  expect(created.status).toBe(200);
  endpointId = ((await created.json()) as { id: string }).id;
});
afterAll(() => close());

describe("audience webhook events", () => {
  it("publish contact lifecycle changes in Resend's shape with the API as source", async () => {
    const res = await call("POST", "/contacts", {
      email: "Ana@example.com",
      first_name: "Ana",
    });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };

    let rows = await deliveries();
    expect(rows.map((r) => r.eventType)).toEqual(["contact.created"]);
    expect(rows[0]?.data).toMatchObject({
      id,
      email: "Ana@example.com",
      first_name: "Ana",
      last_name: null,
      unsubscribed: false,
      source: "api",
    });
    expect(typeof rows[0]?.data.created_at).toBe("string");
    expect(enqueued).toContain(rows[0]?.id);

    expect((await call("PATCH", `/contacts/${id}`, { unsubscribed: true })).status).toBe(200);
    rows = await deliveries();
    expect(
      rows
        .slice(0, 2)
        .map((r) => r.eventType)
        .sort(),
    ).toEqual(["contact.unsubscribed", "contact.updated"]);
    expect(rows.find((r) => r.eventType === "contact.unsubscribed")?.data).toMatchObject({
      id,
      unsubscribed: true,
      source: "api",
    });

    // A retained one-click opt-out leaves the list with the re-subscribe.
    const retained = (await (
      await call("POST", "/suppressions", { email: "ana@example.com", origin: "unsubscribe" })
    ).json()) as { id: string };
    expect((await call("PATCH", `/contacts/${id}`, { unsubscribed: false })).status).toBe(200);
    rows = await deliveries();
    expect(rows.some((r) => r.eventType === "contact.resubscribed")).toBe(true);
    expect(rows.find((r) => r.eventType === "suppression.removed")?.data).toMatchObject({
      id: retained.id,
      origin: "unsubscribe",
      source: "api",
    });

    expect((await call("DELETE", `/contacts/${id}`)).status).toBe(200);
    rows = await deliveries();
    expect(rows[0]?.eventType).toBe("contact.deleted");
    // Deleting is an erasure: the stored payload no longer carries the address.
    expect(rows[0]?.data).toMatchObject({ id, email: "[erased]", source: "api" });
  });

  it("publish topic opt-outs with the topic named", async () => {
    const topic = (await (
      await call("POST", "/topics", { name: "Digest", default_subscription: "opt_in" })
    ).json()) as { id: string };
    const contact = (await (
      await call("POST", "/contacts", { email: "digest@example.com" })
    ).json()) as { id: string };
    expect(
      (
        await call("PATCH", `/contacts/${contact.id}/topics`, [
          { id: topic.id, subscription: "opt_out" },
        ])
      ).status,
    ).toBe(200);
    const row = (await deliveries()).find((r) => r.eventType === "contact.topic_opt_out");
    expect(row?.data).toMatchObject({
      id: contact.id,
      email: "digest@example.com",
      topic_id: topic.id,
      topic_name: "Digest",
      source: "api",
    });
  });

  it("publish suppression list changes with origin and source", async () => {
    const added = await call("POST", "/suppressions", {
      email: "blocked@example.com",
      origin: "unsubscribe",
    });
    expect(added.status).toBe(200);
    const { id } = (await added.json()) as { id: string };
    let row = (await deliveries()).find((r) => r.eventType === "suppression.added");
    expect(row?.data).toMatchObject({
      id,
      email: "blocked@example.com",
      origin: "unsubscribe",
      source: "api",
    });
    // Re-adding an already suppressed address publishes nothing.
    const before = (await deliveries()).length;
    await call("POST", "/suppressions", { email: "blocked@example.com" });
    expect((await deliveries()).length).toBe(before);

    expect((await call("DELETE", `/suppressions/${id}`)).status).toBe(200);
    row = (await deliveries()).find((r) => r.eventType === "suppression.removed");
    expect(row?.data).toMatchObject({ id, email: "blocked@example.com", origin: "unsubscribe" });
  });
});

describe("POST /contacts/{id}/preferences-link", () => {
  it("mints the contact's hosted preference page URL, verifiable with the unsubscribe key", async () => {
    const contact = (await (
      await call("POST", "/contacts", { email: "prefs@example.com" })
    ).json()) as { id: string };
    const res = await call("POST", `/contacts/${contact.id}/preferences-link`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { object: string; contact: string; url: string };
    expect(body.object).toBe("preferences_link");
    expect(body.contact).toBe(contact.id);
    const url = new URL(body.url);
    expect(url.origin).toBe("https://app.example.com");
    const token = url.pathname.split("/").pop() ?? "";
    expect(verifyUnsubscribeToken(token, deriveUnsubscribeKey(masterKey))).toEqual({
      contactId: contact.id,
      topicId: null,
    });
    // By email too, like every other contact route.
    expect((await call("POST", "/contacts/prefs@example.com/preferences-link")).status).toBe(200);
    expect((await call("POST", "/contacts/nobody@example.com/preferences-link")).status).toBe(404);
  });

  it("422s when the instance cannot build hosted links", async () => {
    const bare = createApi({
      db,
      keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
      isCloud: false,
      enqueueEmailSend: async () => {},
    });
    const res = await bare.request("/contacts/prefs@example.com/preferences-link", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(422);
  });
});

describe("GET /contacts/{id}/topics", () => {
  it("reports each topic's visibility so callers can mirror the hosted page", async () => {
    await call("POST", "/topics", { name: "Private notes", default_subscription: "opt_out" });
    const contact = (await (
      await call("POST", "/contacts", { email: "vis@example.com" })
    ).json()) as { id: string };
    const res = await call("GET", `/contacts/${contact.id}/topics`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { name: string; visibility: string }[] };
    expect(data.length).toBeGreaterThan(0);
    for (const topic of data) expect(["public", "private"]).toContain(topic.visibility);
  });
});
