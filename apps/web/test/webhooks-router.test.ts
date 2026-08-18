import { WEBHOOK_EVENT_TYPES as CORE_WEBHOOK_EVENT_TYPES } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WEBHOOK_EVENT_TYPES as WEB_WEBHOOK_EVENT_TYPES,
  WEBHOOK_EVENT_GROUPS,
  WEBHOOK_EVENT_META,
} from "@/lib/webhook-events";
import { createCaller } from "@/server/routers";

// vitest.config sets SKIP_ENV_VALIDATION (env reads stay live), so setting
// the KEK here is enough for the router's lazily built keyring.
const TEST_KEK = Buffer.alloc(32, 7).toString("base64");
process.env.MASTER_ENCRYPTION_KEY = TEST_KEK;

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});

afterEach(async () => {
  await close();
});

function callerFor(teamId: string, role: "owner" | "admin" | "member" = "owner") {
  return createCaller({
    db,
    session: { user: { id: "u1", email: "u1@example.com", name: "u1" } },
    teamId,
    role,
  });
}

async function endpointRow(id: string) {
  const [row] = await db
    .select()
    .from(schema.webhookEndpoints)
    .where(eq(schema.webhookEndpoints.id, id));
  if (!row) throw new Error("endpoint row missing");
  return row;
}

async function insertDelivery(
  endpointId: string,
  status: "pending" | "success" | "failed" | "exhausted",
) {
  const [row] = await db
    .insert(schema.webhookDeliveries)
    .values({
      endpointId,
      messageId: `msg_${Math.random().toString(36).slice(2)}`,
      eventType: "email.delivered",
      payload: { type: "email.delivered" },
      status,
    })
    .returning({ id: schema.webhookDeliveries.id });
  if (!row) throw new Error("delivery insert failed");
  return row.id;
}

it("keeps the client event-type mirror in lockstep with core", () => {
  expect([...WEB_WEBHOOK_EVENT_TYPES]).toEqual([...CORE_WEBHOOK_EVENT_TYPES]);
});

it("annotates every event type in WEBHOOK_EVENT_META with a known group and no orphans", () => {
  expect(Object.keys(WEBHOOK_EVENT_META).sort()).toEqual([...WEB_WEBHOOK_EVENT_TYPES].sort());
  for (const meta of Object.values(WEBHOOK_EVENT_META)) {
    expect(WEBHOOK_EVENT_GROUPS).toContain(meta.group);
    expect(meta.dot).toMatch(/^var\(--ms-dot-/);
  }
});

describe("webhooks.create", () => {
  it("forbids ordinary members from creating an external event sink", async () => {
    const teamId = await createTeam(db, "team-a");
    await expect(
      callerFor(teamId, "member").webhooks.create({ url: "https://attacker.example/hooks" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("returns the whsec_ secret once and stores only ciphertext + last4", async () => {
    const teamId = await createTeam(db, "team-a");
    const { id, secret } = await callerFor(teamId).webhooks.create({
      url: "https://example.com/hooks",
    });

    expect(secret).toMatch(/^whsec_/);
    const row = await endpointRow(id);
    expect(row.teamId).toBe(teamId);
    expect(row.secretLast4).toBe(secret.slice(-4));
    // The plaintext never touches the row: the ciphertext must not embed it.
    expect(Buffer.from(row.secretCiphertext).includes(Buffer.from(secret, "utf8"))).toBe(false);
    // null events = subscribed to everything.
    expect(row.events).toBeNull();

    // get exposes only the mask input, never the secret or its ciphertext.
    const fetched = await callerFor(teamId).webhooks.get({ id });
    expect(fetched.secretLast4).toBe(secret.slice(-4));
    expect(JSON.stringify(fetched)).not.toContain(secret);
    expect(fetched).not.toHaveProperty("secretCiphertext");
  });

  it("rejects non-https urls", async () => {
    const teamId = await createTeam(db, "team-a");
    await expect(
      callerFor(teamId).webhooks.create({ url: "http://example.com/hooks" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("stores an event subset and description; empty subset means all", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const subset = await caller.webhooks.create({
      url: "https://example.com/a",
      description: "prod",
      eventTypes: ["email.delivered", "email.bounced"],
    });
    expect((await endpointRow(subset.id)).events).toEqual(["email.delivered", "email.bounced"]);
    expect((await endpointRow(subset.id)).description).toBe("prod");

    const all = await caller.webhooks.create({ url: "https://example.com/b", eventTypes: [] });
    expect((await endpointRow(all.id)).events).toBeNull();
    const listed = await caller.webhooks.list();
    expect(listed.find((w) => w.id === all.id)?.eventTypes).toBeNull();
    expect(listed.find((w) => w.id === subset.id)?.eventTypes).toEqual([
      "email.delivered",
      "email.bounced",
    ]);
  });
});

describe("tenant isolation", () => {
  it("blocks cross-team get/update/delete/testDelivery and delivery reads", async () => {
    const teamA = await createTeam(db, "team-a");
    const teamB = await createTeam(db, "team-b");
    const { id } = await callerFor(teamA).webhooks.create({ url: "https://example.com/hooks" });
    const deliveryId = await insertDelivery(id, "success");

    const b = callerFor(teamB);
    await expect(b.webhooks.get({ id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(b.webhooks.update({ id, enabled: false })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(b.webhooks.delete({ id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(b.webhooks.testDelivery({ id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(b.webhooks.deliveries.list({ endpointId: id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(b.webhooks.deliveries.get({ id: deliveryId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    // The endpoint survives all of it.
    expect((await endpointRow(id)).id).toBe(id);
    // list is scoped, not errored.
    expect(await b.webhooks.list()).toEqual([]);
  });
});

describe("webhooks.update", () => {
  it("toggles enabled through the status column", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const { id } = await caller.webhooks.create({ url: "https://example.com/hooks" });

    const disabled = await caller.webhooks.update({ id, enabled: false });
    expect(disabled.enabled).toBe(false);
    expect((await endpointRow(id)).status).toBe("disabled");

    const enabled = await caller.webhooks.update({ id, enabled: true });
    expect(enabled.enabled).toBe(true);
    expect((await endpointRow(id)).status).toBe("enabled");
  });

  it("updates url and event subset", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const { id } = await caller.webhooks.create({
      url: "https://example.com/hooks",
      eventTypes: ["email.sent"],
    });
    await caller.webhooks.update({
      id,
      url: "https://example.com/v2",
      eventTypes: ["email.opened"],
    });
    const row = await endpointRow(id);
    expect(row.url).toBe("https://example.com/v2");
    expect(row.events).toEqual(["email.opened"]);
  });
});

describe("webhooks.delete", () => {
  it("cascades the endpoint's deliveries", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const { id } = await caller.webhooks.create({ url: "https://example.com/hooks" });
    await insertDelivery(id, "success");
    await insertDelivery(id, "failed");

    await caller.webhooks.delete({ id });
    const remaining = await db
      .select({ id: schema.webhookDeliveries.id })
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.endpointId, id));
    expect(remaining).toEqual([]);
  });
});

describe("webhooks.list success rate", () => {
  it("computes success/settled over recent deliveries, ignoring pending", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const withStats = await caller.webhooks.create({ url: "https://example.com/a" });
    const fresh = await caller.webhooks.create({ url: "https://example.com/b" });

    for (const status of ["success", "success", "success", "failed", "pending"] as const) {
      await insertDelivery(withStats.id, status);
    }

    const listed = await caller.webhooks.list();
    // 3 success / 4 settled — the pending row counts for neither side.
    expect(listed.find((w) => w.id === withStats.id)?.successRate).toBe(75);
    expect(listed.find((w) => w.id === fresh.id)?.successRate).toBeNull();
  });
});

describe("webhooks.testDelivery", () => {
  it("delivers the test event synchronously and records the outcome", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    // Even an endpoint subscribed to other events accepts a test fire.
    // SSRF-blocked target: the attempt settles immediately and
    // deterministically — the pin is that the row is NEVER left pending.
    const { id } = await caller.webhooks.create({
      url: "https://10.0.0.1/hooks",
      eventTypes: ["email.bounced"],
    });

    const result = await caller.webhooks.testDelivery({ id });
    expect(result.ok).toBe(false);
    const delivery = await caller.webhooks.deliveries.get({ id: result.id });
    expect(delivery.status).toBe("failed");
    expect(delivery.eventType).toBe("email.sent");
    expect(delivery.attempts).toBe(1);
    expect(delivery.payload).toMatchObject({ type: "email.sent", test: true });
    expect(delivery.messageId).toMatch(/^msg_/);
  });
});

describe("webhooks.deliveries.list", () => {
  it("pages newest-first with a total", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const { id } = await caller.webhooks.create({ url: "https://example.com/hooks" });
    for (let i = 0; i < 3; i++) await insertDelivery(id, "success");

    const page = await caller.webhooks.deliveries.list({ endpointId: id, offset: 0, limit: 2 });
    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(2);
    const rest = await caller.webhooks.deliveries.list({ endpointId: id, offset: 2, limit: 2 });
    expect(rest.items).toHaveLength(1);
    // No page leaks the payload; only deliveries.get carries it.
    expect(page.items[0]).not.toHaveProperty("payload");
  });
});
