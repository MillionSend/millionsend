import { randomBytes } from "node:crypto";
import { EnvKeyring, generateApiKey } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createApi } from "../src/app.js";

let db: Db;
let close: () => Promise<void>;
let app: ReturnType<typeof createApi>;
let teamId: string;
let token: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "webhooks-notif-team");
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
  });
});
afterAll(() => close());

async function createWebhook(endpoint: string): Promise<string> {
  const res = await app.request("/webhooks", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ endpoint, events: ["email.sent"] }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

it("DELETE /webhooks/{id} forgets the endpoint's notification claims and no other", async () => {
  const gone = await createWebhook("https://example.com/hooks/gone");
  const kept = await createWebhook("https://example.com/hooks/kept");
  await db.insert(schema.teamNotifications).values([
    { teamId, kind: `webhook.failing:${gone}`, periodKey: "episode" },
    { teamId, kind: `webhook.backlog:${gone}`, periodKey: "2026-01-01" },
    { teamId, kind: `webhook.failing:${kept}`, periodKey: "episode" },
    { teamId, kind: "quota.warning", periodKey: "2026-01-01" },
  ]);

  const res = await app.request(`/webhooks/${gone}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const left = await db
    .select({ kind: schema.teamNotifications.kind })
    .from(schema.teamNotifications)
    .where(eq(schema.teamNotifications.teamId, teamId));
  expect(left.map((r) => r.kind).sort()).toEqual(
    [`webhook.failing:${kept}`, "quota.warning"].sort(),
  );
});
