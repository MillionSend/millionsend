import { randomBytes, randomUUID } from "node:crypto";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { afterEach, beforeEach, expect, it } from "vitest";
import { EnvKeyring } from "../src/crypto/keyring.js";
import {
  encryptWebhookSecret,
  enqueueTeamWebhookDeliveries,
  enqueueTeamWebhookEvents,
  generateWebhookSecret,
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
  expect(enqueued).toEqual([rows[0]?.id]);
});

it("fans a bulk event set out above the driver's bind-parameter cap in bounded slices", async () => {
  // 15 endpoints × 1000 events = 15,000 rows: five parameters each would be
  // 75,000 bound values in one statement, past Postgres's 65,534.
  for (let i = 0; i < 15; i++) await endpoint(null);
  const batches: number[] = [];
  const occurredAt = new Date("2026-09-03T12:00:00Z");
  await enqueueTeamWebhookEvents(db, {
    teamId,
    events: Array.from({ length: 1000 }, (_, i) => ({
      type: "contact.created" as const,
      occurredAt,
      data: { id: `c${i}`, email: `c${i}@example.com`, source: "api" },
    })),
    enqueue: async (rows) => {
      batches.push(rows.length);
    },
  });
  expect(batches.reduce((a, b) => a + b, 0)).toBe(15_000);
  expect(Math.max(...batches)).toBeLessThanOrEqual(2000);
  const stored = await db
    .select({ id: schema.webhookDeliveries.id })
    .from(schema.webhookDeliveries);
  expect(stored).toHaveLength(15_000);
});
