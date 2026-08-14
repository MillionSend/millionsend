import { randomBytes } from "node:crypto";
import {
  EnvKeyring,
  encryptWebhookSecret,
  generateWebhookSecret,
  verifyWebhookSignature,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type DeliverDeps, deliverWebhook } from "../src/handlers/deliver-webhook.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
const secret = generateWebhookSecret();

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "deliver-team");
});
afterAll(() => close());

async function insertEndpoint(
  overrides: Partial<typeof schema.webhookEndpoints.$inferInsert> = {},
): Promise<string> {
  const encrypted = await encryptWebhookSecret(secret, keyring);
  const [row] = await db
    .insert(schema.webhookEndpoints)
    .values({
      teamId,
      url: "https://receiver.example.com/hook",
      secretCiphertext: encrypted.ciphertext,
      secretIv: encrypted.iv,
      secretWrappedDek: encrypted.wrappedDek,
      secretKeyVersion: encrypted.keyVersion,
      secretLast4: secret.slice(-4),
      events: null,
      ...overrides,
    })
    .returning({ id: schema.webhookEndpoints.id });
  if (!row) throw new Error("endpoint insert failed");
  return row.id;
}

async function insertDelivery(
  endpointId: string,
  overrides: Partial<typeof schema.webhookDeliveries.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(schema.webhookDeliveries)
    .values({
      endpointId,
      messageId: `msg_${randomBytes(8).toString("hex")}`,
      eventType: "email.delivered",
      payload: { type: "email.delivered", data: { email_id: "e-1" } },
      ...overrides,
    })
    .returning({ id: schema.webhookDeliveries.id });
  if (!row) throw new Error("delivery insert failed");
  return row.id;
}

interface FakePost {
  url: string;
  body: string;
  headers: Record<string, string>;
}

function fakeDeps(
  respond: () => Promise<{ status: number; body: string }>,
): DeliverDeps & { posts: FakePost[]; reenqueued: { id: string; at: Date }[] } {
  const posts: FakePost[] = [];
  const reenqueued: { id: string; at: Date }[] = [];
  return {
    keyring,
    posts,
    reenqueued,
    post: async (url, body, headers) => {
      posts.push({ url, body, headers });
      return respond();
    },
    reenqueue: async (id, at) => {
      reenqueued.push({ id, at });
    },
  };
}

async function deliveryRow(id: string) {
  const [row] = await db
    .select()
    .from(schema.webhookDeliveries)
    .where(eq(schema.webhookDeliveries.id, id));
  if (!row) throw new Error("delivery row missing");
  return row;
}

it("2xx: signs with Standard Webhooks headers and marks success", async () => {
  const endpointId = await insertEndpoint();
  const id = await insertDelivery(endpointId);
  const deps = fakeDeps(async () => ({ status: 200, body: "ok" }));

  expect(await deliverWebhook(db, deps, { deliveryId: id })).toBe("success");

  expect(deps.posts).toHaveLength(1);
  const post = deps.posts[0];
  if (!post) throw new Error("no post");
  expect(post.url).toBe("https://receiver.example.com/hook");
  expect(JSON.parse(post.body)).toEqual({ type: "email.delivered", data: { email_id: "e-1" } });
  expect(
    verifyWebhookSignature(
      secret,
      {
        id: post.headers["webhook-id"] ?? "",
        timestamp: post.headers["webhook-timestamp"] ?? "",
        signature: post.headers["webhook-signature"] ?? "",
      },
      post.body,
    ),
  ).toBe(true);

  const row = await deliveryRow(id);
  expect(row.status).toBe("success");
  expect(row.attempts).toBe(1);
  expect(row.lastResponseCode).toBe(200);
  expect(row.lastResponseBody).toBe("ok");
  expect(row.nextAttemptAt).toBeNull();
  expect(deps.reenqueued).toHaveLength(0);
});

it("failure: schedules the next attempt on the backoff ladder", async () => {
  const endpointId = await insertEndpoint();
  const id = await insertDelivery(endpointId);
  const deps = fakeDeps(async () => ({ status: 500, body: "boom" }));
  const before = Date.now();

  expect(await deliverWebhook(db, deps, { deliveryId: id })).toBe("retry");

  const row = await deliveryRow(id);
  expect(row.status).toBe("failed");
  expect(row.attempts).toBe(1);
  expect(row.lastResponseCode).toBe(500);
  const next = row.nextAttemptAt?.getTime() ?? 0;
  expect(next).toBeGreaterThanOrEqual(before + 5_000);
  expect(next).toBeLessThan(before + 60_000);
  expect(deps.reenqueued).toEqual([{ id, at: row.nextAttemptAt }]);

  // Second failure: 5 minutes out.
  await deliverWebhook(db, deps, { deliveryId: id });
  const row2 = await deliveryRow(id);
  expect(row2.attempts).toBe(2);
  expect(row2.nextAttemptAt?.getTime() ?? 0).toBeGreaterThanOrEqual(before + 5 * 60_000);
});

it("network error: records the message and retries", async () => {
  const endpointId = await insertEndpoint();
  const id = await insertDelivery(endpointId);
  const deps = fakeDeps(async () => {
    throw new Error("connect ECONNREFUSED");
  });

  expect(await deliverWebhook(db, deps, { deliveryId: id })).toBe("retry");
  const row = await deliveryRow(id);
  expect(row.status).toBe("failed");
  expect(row.lastResponseCode).toBeNull();
  expect(row.lastResponseBody).toContain("ECONNREFUSED");
});

it("sixth failed attempt exhausts the delivery", async () => {
  const endpointId = await insertEndpoint();
  const id = await insertDelivery(endpointId, { status: "failed", attempts: 5 });
  const deps = fakeDeps(async () => ({ status: 500, body: "still down" }));

  expect(await deliverWebhook(db, deps, { deliveryId: id })).toBe("exhausted");
  const row = await deliveryRow(id);
  expect(row.status).toBe("exhausted");
  expect(row.attempts).toBe(6);
  expect(row.nextAttemptAt).toBeNull();
  expect(deps.reenqueued).toHaveLength(0);
});

it("redelivery of a terminal delivery is a no-op", async () => {
  const endpointId = await insertEndpoint();
  const id = await insertDelivery(endpointId, { status: "success", attempts: 1 });
  const deps = fakeDeps(async () => ({ status: 200, body: "ok" }));

  expect(await deliverWebhook(db, deps, { deliveryId: id })).toBe("skipped");
  expect(deps.posts).toHaveLength(0);
});

it("disabled endpoint: no request, delivery abandoned", async () => {
  const endpointId = await insertEndpoint({ status: "disabled" });
  const id = await insertDelivery(endpointId);
  const deps = fakeDeps(async () => ({ status: 200, body: "ok" }));

  expect(await deliverWebhook(db, deps, { deliveryId: id })).toBe("skipped");
  expect(deps.posts).toHaveLength(0);
  expect((await deliveryRow(id)).status).toBe("exhausted");
});
