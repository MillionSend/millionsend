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
let broadcastId: string;

const body = { from: "Acme <a@acme.dev>", to: ["r@example.com"], subject: "s", text: "t" };

async function call(method: string, path: string, payload?: unknown) {
  return app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(payload !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
  });
}

const setSuspended = (on: boolean) =>
  db
    .update(schema.teams)
    .set(
      on
        ? { suspendedAt: new Date(), suspensionReason: "manual" }
        : { suspendedAt: null, suspensionReason: null },
    )
    .where(eq(schema.teams.id, teamId));

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "suspended-team");
  await db.insert(schema.domains).values({
    teamId,
    name: "acme.dev",
    region: "us-east-1",
    status: "verified",
    verifiedAt: new Date(),
  });
  const key = generateApiKey();
  token = key.token;
  await db.insert(schema.apiKeys).values({
    teamId,
    name: "t",
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
  });
  const [bc] = await db
    .insert(schema.broadcasts)
    .values({ teamId, from: "Acme <hi@acme.dev>", subject: "s", html: "<p>hi</p>" })
    .returning({ id: schema.broadcasts.id });
  if (!bc) throw new Error("broadcast insert failed");
  broadcastId = bc.id;
  app = createApi({
    db,
    keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
    isCloud: true,
    enqueueEmailSend: async () => {},
    enqueueBroadcastSend: async () => {},
    appBaseUrl: "https://app.example.test",
  });
});
afterAll(() => close());

it("refuses every send surface with 403 team_suspended while the key still authenticates", async () => {
  await setSuspended(true);

  const single = await call("POST", "/emails", body);
  expect(single.status).toBe(403);
  expect(await single.json()).toMatchObject({ statusCode: 403, name: "team_suspended" });

  const batch = await call("POST", "/emails/batch", [body, { ...body, to: ["b@example.com"] }]);
  expect(batch.status).toBe(403);
  expect(await batch.json()).toMatchObject({ name: "team_suspended" });

  const send = await call("POST", `/broadcasts/${broadcastId}/send`, {});
  expect(send.status).toBe(403);
  expect(await send.json()).toMatchObject({ name: "team_suspended" });
  const [row] = await db
    .select({ status: schema.broadcasts.status })
    .from(schema.broadcasts)
    .where(eq(schema.broadcasts.id, broadcastId));
  expect(row?.status).toBe("draft");

  // Nothing was accepted, and the 403 (not a 401) shows the key authenticated.
  expect(await db.select().from(schema.emails).where(eq(schema.emails.teamId, teamId))).toEqual([]);
});

it("accepts again once the suspension is cleared", async () => {
  await setSuspended(false);
  const res = await call("POST", "/emails", body);
  expect(res.status).toBe(200);
  const { id } = (await res.json()) as { id: string };
  const got = await call("GET", `/emails/${id}`);
  expect(got.status).toBe(200);
  expect(await got.json()).toMatchObject({ id, subject: "s" });
});
