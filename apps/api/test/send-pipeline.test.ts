import { randomBytes } from "node:crypto";
import {
  DAY_MS,
  EnvKeyring,
  generateApiKey,
  PLAN_DAILY_LIMIT,
  QUOTA_TOLERANCE,
  utcDay,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createApi } from "../src/app.js";

/**
 * The accept → queue seam: every accepted email must PRODUCE a send job
 * (an email without one sits in "queued" forever), scheduled sends carry
 * their due time, and quota-parked emails wait for the drain instead.
 */

let db: Db;
let close: () => Promise<void>;
let app: ReturnType<typeof createApi>;
let teamId: string;
let token: string;
let enqueued: { emailId: string; startAfter?: Date }[];

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "pipeline-team");
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
    enqueueEmailSend: async (emailId, opts) => {
      enqueued.push({ emailId, ...(opts?.startAfter ? { startAfter: opts.startAfter } : {}) });
    },
  });
});
beforeEach(() => {
  enqueued = [];
});
afterAll(() => close());

async function post(body: unknown) {
  return app.request("/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const base = { from: "Acme <a@acme.dev>", to: ["r@example.com"], subject: "s", text: "t" };

it("an accepted email is handed to the send queue", async () => {
  const res = await post(base);
  expect(res.status).toBe(200);
  const { id } = (await res.json()) as { id: string };
  expect(enqueued).toEqual([{ emailId: id }]);
});

it("a scheduled email's job carries its due time", async () => {
  const due = new Date(Date.now() + 60 * 60 * 1000);
  const res = await post({ ...base, scheduled_at: due.toISOString() });
  expect(res.status).toBe(200);
  const { id } = (await res.json()) as { id: string };
  expect(enqueued).toEqual([{ emailId: id, startAfter: due }]);
});

it("scheduled_at beyond 30 days is rejected loudly", async () => {
  const res = await post({
    ...base,
    scheduled_at: new Date(Date.now() + 31 * DAY_MS).toISOString(),
  });
  expect(res.status).toBe(422);
  const body = (await res.json()) as { name: string; message: string };
  expect(body.name).toBe("validation_error");
  expect(body.message).toContain("30 days");
  expect(enqueued).toEqual([]);
});

it("a quota-parked email is NOT enqueued — the midnight drain owns it", async () => {
  const today = utcDay();
  const limit = PLAN_DAILY_LIMIT.free;
  if (limit === null) throw new Error("free plan is expected to have a daily cap");
  await db
    .insert(schema.usageCounters)
    // The cap tolerates 50% overage before parking; burn the ceiling.
    .values({ teamId, day: today, accepted: Math.floor(limit * (1 + QUOTA_TOLERANCE)) })
    .onConflictDoUpdate({
      target: [schema.usageCounters.teamId, schema.usageCounters.day],
      set: { accepted: Math.floor(limit * (1 + QUOTA_TOLERANCE)) },
    });
  const res = await post(base);
  expect(res.status).toBe(200);
  const { id } = (await res.json()) as { id: string };
  const [row] = await db.select().from(schema.emails).where(eq(schema.emails.id, id));
  expect(row?.latestStatus).toBe("queued_quota");
  expect(enqueued).toEqual([]);
});
