import { randomBytes } from "node:crypto";
import { EnvKeyring, generateApiKey, hashRecipient } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createApi } from "../src/app.js";

let db: Db;
let close: () => Promise<void>;
let app: ReturnType<typeof createApi>;
let teamId: string;
let token: string;

async function call(method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const suppressions = (email: string) =>
  db
    .select({ reason: schema.suppressions.reason })
    .from(schema.suppressions)
    .where(
      and(
        eq(schema.suppressions.teamId, teamId),
        eq(schema.suppressions.emailHash, hashRecipient(email)),
      ),
    );

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "resub");
  const key = generateApiKey();
  await db.insert(schema.apiKeys).values({
    teamId,
    name: "resub",
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
  });
  token = key.token;
  app = createApi({
    db,
    keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
    isCloud: true,
    enqueueEmailSend: async () => {},
  });
});
afterAll(() => close());

it("POST /contacts keeps a retained one-click opt-out; PATCH unsubscribed:false clears it", async () => {
  const email = "opted@example.com";
  await db.insert(schema.suppressions).values({
    teamId,
    email,
    emailHash: hashRecipient(email),
    reason: "one_click_unsubscribe",
  });

  const created = await call("POST", "/contacts", { email });
  expect(created.status).toBe(200);
  const { id } = (await created.json()) as { id: string };
  expect(await suppressions(email)).toHaveLength(1);

  // Restating other fields, or unsubscribing, leaves the opt-out alone.
  expect((await call("PATCH", `/contacts/${id}`, { first_name: "O" })).status).toBe(200);
  expect((await call("PATCH", `/contacts/${id}`, { unsubscribed: true })).status).toBe(200);
  expect(await suppressions(email)).toHaveLength(1);

  expect((await call("PATCH", `/contacts/${id}`, { unsubscribed: false })).status).toBe(200);
  expect(await suppressions(email)).toHaveLength(0);
});

it("an explicit re-subscribe never clears a bounce suppression", async () => {
  const email = "bounced@example.com";
  await db.insert(schema.suppressions).values({
    teamId,
    email,
    emailHash: hashRecipient(email),
    reason: "hard_bounce",
  });
  const created = await call("POST", "/contacts", { email });
  const { id } = (await created.json()) as { id: string };
  expect((await call("PATCH", `/contacts/${id}`, { unsubscribed: false })).status).toBe(200);
  expect(await suppressions(email)).toEqual([{ reason: "hard_bounce" }]);
});
