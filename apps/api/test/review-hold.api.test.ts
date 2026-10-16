import { randomBytes } from "node:crypto";
import {
  DAY_MS,
  EnvKeyring,
  generateApiKey,
  hashRecipient,
  teamRung,
  utcDay,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApi } from "../src/app.js";

/**
 * A team the content monitor holds for review keeps sending as far as its
 * clients can tell: the API accepts its mail and parks it, after every check
 * an ordinary send meets, and nothing goes to the send queue.
 */

let db: Db;
let close: () => Promise<void>;
let app: ReturnType<typeof createApi>;
let teamId: string;
let token: string;
let enqueued: string[];

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "held-team");
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
  await db
    .update(schema.teams)
    .set({ suspendedAt: new Date(), suspensionReason: "review" })
    .where(eq(schema.teams.id, teamId));
  app = createApi({
    db,
    keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
    isCloud: true,
    enqueueEmailSend: async (emailId) => void enqueued.push(emailId),
  });
});
beforeEach(async () => {
  enqueued = [];
  await db.delete(schema.emails).where(eq(schema.emails.teamId, teamId));
  await db.delete(schema.usageCounters).where(eq(schema.usageCounters.teamId, teamId));
});
afterAll(() => close());

const base = { from: "Acme <a@acme.dev>", to: ["r@example.com"], subject: "s", text: "t" };

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const rows = () =>
  db
    .select({
      id: schema.emails.id,
      latestStatus: schema.emails.latestStatus,
      parkReason: schema.emails.parkReason,
    })
    .from(schema.emails)
    .where(eq(schema.emails.teamId, teamId));

const acceptedToday = async () =>
  (
    await db
      .select({ accepted: schema.usageCounters.accepted })
      .from(schema.usageCounters)
      .where(and(eq(schema.usageCounters.teamId, teamId), eq(schema.usageCounters.day, utcDay())))
  )[0]?.accepted ?? 0;

it("parks single and batch sends with no job and no reservation held", async () => {
  const single = await post("/emails", base);
  expect(single.status).toBe(200);
  const batch = await post("/emails/batch", [base, { ...base, to: ["b@example.com"] }]);
  expect(batch.status).toBe(200);
  expect(enqueued).toEqual([]);
  const parked = await rows();
  expect(parked).toHaveLength(3);
  for (const row of parked) {
    expect(row).toMatchObject({ latestStatus: "queued_quota", parkReason: "review" });
  }
  // Charged to test the caps, then handed back: the drain charges it on release.
  expect(await acceptedToday()).toBe(0);
});

it("replays an idempotent request under the hold", async () => {
  const headers = { "idempotency-key": "held-once" };
  const first = (await (await post("/emails", base, headers)).json()) as { id: string };
  const again = await post("/emails", base, headers);
  expect(again.status).toBe(200);
  expect(await again.json()).toEqual({ id: first.id });
  expect(await rows()).toHaveLength(1);
});

it("refuses what an ordinary send refuses: suppressed recipients and a full backlog", async () => {
  await db.insert(schema.suppressions).values({
    teamId,
    email: "gone@example.com",
    emailHash: hashRecipient("gone@example.com"),
    reason: "hard_bounce",
  });
  const suppressed = await post("/emails", { ...base, to: ["gone@example.com"] });
  expect(suppressed.status).toBe(422);
  expect(await suppressed.json()).toMatchObject({ name: "all_recipients_suppressed" });

  // Three days of the free plan's volume already wait.
  const backlog = 3 * teamRung("free", null).included;
  await db.insert(schema.emails).values(
    Array.from({ length: backlog }, () => ({
      teamId,
      from: base.from,
      to: base.to,
      subject: "parked",
      latestStatus: "queued_quota" as const,
      parkReason: "review" as const,
    })),
  );
  const full = await post("/emails", base);
  expect(full.status).toBe(429);
  expect(await full.json()).toMatchObject({ name: "daily_quota_exceeded" });
  const fullBatch = await post("/emails/batch", [base]);
  expect(fullBatch.status).toBe(429);
  // Nothing was accepted: the parked backlog plus the one `suppressed` record
  // the refused all-suppressed send left behind.
  const all = await rows();
  expect(all).toHaveLength(backlog + 1);
  expect(all.filter((r) => r.latestStatus === "suppressed")).toHaveLength(1);
  expect(enqueued).toEqual([]);
});

describe("on a monthly plan at its cap", () => {
  beforeAll(async () => {
    const start = new Date(Date.now() - 5 * DAY_MS);
    await db
      .update(schema.teams)
      .set({
        plan: "pro",
        planQuota: 100_000,
        currentPeriodStart: start,
        currentPeriodEnd: new Date(start.getTime() + 30 * DAY_MS),
        overageEnabled: false,
      })
      .where(eq(schema.teams.id, teamId));
    await db.insert(schema.usagePeriods).values({ teamId, periodStart: start, accepted: 100_000 });
  });

  it("refuses single and batch sends as it would without the hold", async () => {
    const single = await post("/emails", base);
    expect(single.status).toBe(429);
    expect(await single.json()).toMatchObject({ name: "monthly_quota_exceeded" });
    const batch = await post("/emails/batch", [base]);
    expect(batch.status).toBe(429);
    expect(await batch.json()).toMatchObject({ name: "monthly_quota_exceeded" });
    expect(await rows()).toEqual([]);
  });
});
