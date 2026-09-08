import { randomBytes, randomUUID } from "node:crypto";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { afterEach, beforeEach, expect, it } from "vitest";
import { EnvKeyring } from "../src/crypto/keyring.js";
import {
  clearWebhookEndpointNotifications,
  encryptWebhookSecret,
  enqueueTeamWebhookDeliveries,
  enqueueTeamWebhookEvents,
  generateWebhookSecret,
  retryAfterMs,
} from "../src/webhooks.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "team-webhooks");
});
afterEach(() => close());

async function endpoint(events: string[] | null): Promise<string> {
  const id = randomUUID();
  const secret = generateWebhookSecret();
  const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
  const encrypted = await encryptWebhookSecret(secret, keyring, { teamId, rowId: id });
  await db.insert(schema.webhookEndpoints).values({
    id,
    teamId,
    url: "https://receiver.example.com/hook",
    secretCiphertext: encrypted.ciphertext,
    secretIv: encrypted.iv,
    secretWrappedDek: encrypted.wrappedDek,
    secretKeyVersion: encrypted.keyVersion,
    secretLast4: secret.slice(-4),
    events,
  });
  return id;
}

it("fans a team-level event out to subscribed endpoints with no email attached", async () => {
  const all = await endpoint(null);
  await endpoint(["quota.reached"]);
  const enqueued: string[] = [];
  const occurredAt = new Date("2026-09-03T12:00:00Z");
  await enqueueTeamWebhookDeliveries(db, {
    teamId,
    type: "quota.warning",
    occurredAt,
    data: { used: 80, limit: 100 },
    enqueue: async (rows) => {
      enqueued.push(...rows.map((r) => r.id));
    },
  });
  const rows = await db.select().from(schema.webhookDeliveries);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    endpointId: all,
    emailId: null,
    eventType: "quota.warning",
    payload: {
      type: "quota.warning",
      created_at: occurredAt.toISOString(),
      data: { used: 80, limit: 100 },
    },
  });
  // Due at once: the drain claims on nextAttemptAt, which a column default never sets.
  expect(rows[0]?.nextAttemptAt).toBeInstanceOf(Date);
  expect(enqueued).toEqual([rows[0]?.id]);
});

it("reads Retry-After as delta-seconds or an HTTP-date, a minute by default, an hour at most", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  expect(retryAfterMs("30", now)).toBe(30_000);
  expect(retryAfterMs("Thu, 01 Jan 2026 00:00:45 GMT", now)).toBe(45_000);
  expect(retryAfterMs(undefined, now)).toBe(60_000);
  expect(retryAfterMs("soon", now)).toBe(60_000);
  expect(retryAfterMs("86400", now)).toBe(3_600_000);
});

it("floors Retry-After at a second: zero or a past date must not re-arm in a hot loop", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  expect(retryAfterMs("0", now)).toBe(1_000);
  expect(retryAfterMs("-5", now)).toBe(1_000);
  expect(retryAfterMs("Wed, 31 Dec 2025 23:00:00 GMT", now)).toBe(1_000);
});

it("deleting an endpoint forgets its notification claims and no other endpoint's", async () => {
  const gone = await endpoint(null);
  const kept = await endpoint(null);
  await db.insert(schema.teamNotifications).values([
    { teamId, kind: `webhook.failing:${gone}`, periodKey: "episode" },
    { teamId, kind: `webhook.backlog:${gone}`, periodKey: "2026-01-01" },
    { teamId, kind: `webhook.failing:${kept}`, periodKey: "episode" },
    { teamId, kind: "quota.warning", periodKey: "2026-01-01" },
  ]);
  await clearWebhookEndpointNotifications(db, { teamId, endpointId: gone });
  const left = await db
    .select({ kind: schema.teamNotifications.kind })
    .from(schema.teamNotifications);
  expect(left.map((r) => r.kind).sort()).toEqual(
    [`webhook.failing:${kept}`, "quota.warning"].sort(),
  );
});

it("fans a bulk event set out in slices that stay under the driver's bind-parameter cap", async () => {
  // 2 endpoints × 1001 events = 2,002 rows, one more than a slice holds, so the
  // insert has to split. A slice of 2,000 rows × 5 parameters is 10,000 bound
  // values, under Postgres's 65,534; one unsliced statement of 15,000 rows
  // would not be, and PGlite is too slow for that many rows in CI.
  for (let i = 0; i < 2; i++) await endpoint(null);
  const batches: number[] = [];
  const occurredAt = new Date("2026-09-03T12:00:00Z");
  await enqueueTeamWebhookEvents(db, {
    teamId,
    events: Array.from({ length: 1001 }, (_, i) => ({
      type: "contact.created" as const,
      occurredAt,
      data: { id: `c${i}`, email: `c${i}@example.com`, source: "api" },
    })),
    enqueue: async (rows) => {
      batches.push(rows.length);
    },
  });
  expect(batches).toEqual([2000, 2]);
  const stored = await db
    .select({ id: schema.webhookDeliveries.id })
    .from(schema.webhookDeliveries);
  expect(stored).toHaveLength(2002);
}, 30_000);
