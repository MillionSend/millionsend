import { randomBytes } from "node:crypto";
import { EnvKeyring, generateApiKey } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createApi } from "../src/app.js";

let db: Db;
let close: () => Promise<void>;
let app: ReturnType<typeof createApi>;
let token: string;

const body = { from: "Acme <a@acme.dev>", subject: "s", text: "t" };

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  const teamId = await createTeam(db, "ceiling-team");
  // A monthly plan with room for the month, held to two sends a day by the operator.
  await db
    .update(schema.teams)
    .set({ plan: "pro", planQuota: 100_000, dailySendCeiling: 2 })
    .where(eq(schema.teams.id, teamId));
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

it("a batch past the day's ceiling on a monthly plan parks its tail instead of refusing the month", async () => {
  const res = await app.request("/emails/batch", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify([1, 2, 3].map((i) => ({ ...body, to: [`r${i}@example.com`] }))),
  });
  expect(res.status).toBe(200);
  const { data } = (await res.json()) as { data: { id: string }[] };
  expect(data).toHaveLength(3);
  const rows = await db
    .select({ id: schema.emails.id, status: schema.emails.latestStatus })
    .from(schema.emails)
    .where(
      inArray(
        schema.emails.id,
        data.map((d) => d.id),
      ),
    );
  expect(data.map((d) => rows.find((r) => r.id === d.id)?.status)).toEqual([
    "queued",
    "queued",
    "queued_quota",
  ]);
});
