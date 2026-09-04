import { DAY_MS, PLAN_DAILY_LIMIT, QUOTA_TOLERANCE, utcDay } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  drainQuotaParked,
  purgeExpiredApiRequests,
  purgeExpiredEmailBodies,
  purgeExpiredEmailMetadata,
  purgeExpiredSessions,
  reconcileBillingPlans,
  reconcileStalledSends,
  stripExpiredEventPayloads,
} from "../src/handlers/cron.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;

beforeEach(async () => {
  // Fresh database per test: drain math depends on exact counter state.
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "cron-team");
});
afterEach(() => close());

const today = () => utcDay();

const FREE_LIMIT = PLAN_DAILY_LIMIT.free;
if (FREE_LIMIT === null) throw new Error("free plan is expected to have a daily cap");
// Sends pass this far over the nominal cap before parking.
const FREE_CEILING = Math.floor(FREE_LIMIT * (1 + QUOTA_TOLERANCE));

async function insertParked(createdAt: Date, subject = "parked"): Promise<string> {
  const [row] = await db
    .insert(schema.emails)
    .values({
      teamId,
      from: "a@acme.dev",
      to: ["r@example.com"],
      subject,
      latestStatus: "queued_quota",
      createdAt,
    })
    .returning({ id: schema.emails.id });
  if (!row) throw new Error("insert failed");
  return row.id;
}

async function statusOf(emailId: string): Promise<string> {
  const [row] = await db
    .select({ s: schema.emails.latestStatus })
    .from(schema.emails)
    .where(eq(schema.emails.id, emailId));
  return row?.s ?? "missing";
}

it("drain reserves against the NEW day's cap — parking is not a quota bypass", async () => {
  // Free ceiling is 110 (100 + tolerance); today's counter already holds 109
  // → only ONE parked email may drain, oldest first.
  await db
    .insert(schema.usageCounters)
    .values({ teamId, day: today(), accepted: FREE_CEILING - 1 });
  const oldest = await insertParked(new Date("2026-08-13T01:00:00Z"));
  const middle = await insertParked(new Date("2026-08-13T02:00:00Z"));
  const newest = await insertParked(new Date("2026-08-13T03:00:00Z"));

  const enqueued: string[] = [];
  const result = await drainQuotaParked(db, {
    isCloud: true,
    enqueueSend: async (id) => {
      enqueued.push(id);
    },
  });

  expect(result).toEqual({ drained: 1, stillParked: 2 });
  expect(enqueued).toEqual([oldest]);
  expect(await statusOf(oldest)).toBe("queued");
  expect(await statusOf(middle)).toBe("queued_quota");
  expect(await statusOf(newest)).toBe("queued_quota");
  const [counter] = await db
    .select()
    .from(schema.usageCounters)
    .where(eq(schema.usageCounters.teamId, teamId));
  expect(counter?.accepted).toBe(FREE_CEILING);
});

it("self-host drain (no caps) releases everything", async () => {
  const a = await insertParked(new Date("2026-08-13T01:00:00Z"));
  const b = await insertParked(new Date("2026-08-13T02:00:00Z"));

  const enqueued: string[] = [];
  const result = await drainQuotaParked(db, {
    isCloud: false,
    enqueueSend: async (id) => {
      enqueued.push(id);
    },
  });

  expect(result).toEqual({ drained: 2, stillParked: 0 });
  expect(enqueued).toEqual([a, b]);
});

it("one enqueue failure re-parks that email, releases its reservation, and does NOT block the rest", async () => {
  const failing = await insertParked(new Date("2026-08-13T01:00:00Z"));
  const healthy = await insertParked(new Date("2026-08-13T02:00:00Z"));

  const enqueued: string[] = [];
  await expect(
    drainQuotaParked(db, {
      isCloud: true,
      enqueueSend: async (id) => {
        if (id === failing) throw new Error("queue down");
        enqueued.push(id);
      },
    }),
  ).rejects.toThrow("1 email(s) failed");

  expect(await statusOf(failing)).toBe("queued_quota");
  expect(await statusOf(healthy)).toBe("queued");
  expect(enqueued).toEqual([healthy]);
  const [counter] = await db
    .select()
    .from(schema.usageCounters)
    .where(eq(schema.usageCounters.teamId, teamId));
  expect(counter?.accepted).toBe(1);
});

it("drain passes a scheduled email's due time through to the queue", async () => {
  const due = new Date(Date.now() + DAY_MS);
  const [row] = await db
    .insert(schema.emails)
    .values({
      teamId,
      from: "a@acme.dev",
      to: ["r@example.com"],
      subject: "scheduled",
      latestStatus: "queued_quota",
      scheduledAt: due,
    })
    .returning({ id: schema.emails.id });
  if (!row) throw new Error("insert failed");

  const enqueued: { id: string; startAfter?: Date }[] = [];
  await drainQuotaParked(db, {
    isCloud: false,
    enqueueSend: async (id, startAfter) => {
      enqueued.push({ id, ...(startAfter ? { startAfter } : {}) });
    },
  });
  expect(enqueued).toEqual([{ id: row.id, startAfter: due }]);
});

it("reconcile re-enqueues stale queued emails but never claimed or fresh ones", async () => {
  const now = new Date();
  const old = (mins: number) => new Date(now.getTime() - mins * 60 * 1000);
  const base = {
    teamId,
    from: "a@acme.dev",
    to: ["r@example.com"] as string[],
    subject: "s",
  };
  const [stale] = await db
    .insert(schema.emails)
    .values({ ...base, latestStatus: "queued" as const, createdAt: old(30) })
    .returning({ id: schema.emails.id });
  // Claimed: a previous attempt may already be at SES — must NOT resend.
  await db
    .insert(schema.emails)
    .values({ ...base, latestStatus: "queued" as const, createdAt: old(30), sentAt: now });
  // Fresh: its original job is presumably still queued.
  await db
    .insert(schema.emails)
    .values({ ...base, latestStatus: "queued" as const, createdAt: now });
  // Parked: quota drain's business, not reconcile's.
  await db
    .insert(schema.emails)
    .values({ ...base, latestStatus: "queued_quota" as const, createdAt: old(30) });

  const enqueued: string[] = [];
  const count = await reconcileStalledSends(db, {
    enqueueSend: async (id) => {
      enqueued.push(id);
    },
    now,
  });
  expect(count).toBe(1);
  expect(enqueued).toEqual([stale?.id]);
});

it("retention purge nulls only expired bodies and stamps bodyPurgedAt", async () => {
  const now = new Date("2026-08-14T00:00:00Z");
  const body = {
    bodyCiphertext: Buffer.from("ct"),
    bodyIv: Buffer.from("iv"),
    bodyWrappedDek: Buffer.from("dek"),
    bodyKeyVersion: 1,
    attachments: "sealed-attachments-blob",
  };
  const [old] = await db
    .insert(schema.emails)
    .values({
      teamId,
      from: "a@acme.dev",
      to: ["r@example.com"],
      subject: "old",
      latestStatus: "delivered",
      createdAt: new Date("2026-07-01T00:00:00Z"),
      ...body,
    })
    .returning({ id: schema.emails.id });
  const [fresh] = await db
    .insert(schema.emails)
    .values({
      teamId,
      from: "a@acme.dev",
      to: ["r@example.com"],
      subject: "fresh",
      latestStatus: "delivered",
      createdAt: new Date("2026-08-01T00:00:00Z"),
      ...body,
    })
    .returning({ id: schema.emails.id });
  if (!old || !fresh) throw new Error("insert failed");

  expect(await purgeExpiredEmailBodies(db, { defaultRetentionDays: 30, now })).toBe(1);

  const [oldRow] = await db.select().from(schema.emails).where(eq(schema.emails.id, old.id));
  expect(oldRow?.bodyCiphertext).toBeNull();
  expect(oldRow?.bodyIv).toBeNull();
  expect(oldRow?.bodyWrappedDek).toBeNull();
  expect(oldRow?.bodyKeyVersion).toBeNull();
  // Attachments are content: purged with the body.
  expect(oldRow?.attachments).toBeNull();
  expect(oldRow?.bodyPurgedAt).toEqual(now);
  // Metadata survives the content purge (separate lifecycles).
  expect(oldRow?.subject).toBe("old");
  expect(oldRow?.to).toEqual(["r@example.com"]);

  const [freshRow] = await db.select().from(schema.emails).where(eq(schema.emails.id, fresh.id));
  expect(freshRow?.bodyCiphertext).not.toBeNull();
  expect(freshRow?.attachments).toBe("sealed-attachments-blob");

  // An old-but-still-future-scheduled email keeps its body — the send needs it.
  const [scheduled] = await db
    .insert(schema.emails)
    .values({
      teamId,
      from: "a@acme.dev",
      to: ["r@example.com"],
      subject: "future",
      latestStatus: "queued",
      createdAt: new Date("2026-07-01T00:00:00Z"),
      scheduledAt: new Date("2026-08-15T00:00:00Z"),
      ...body,
    })
    .returning({ id: schema.emails.id });
  if (!scheduled) throw new Error("insert failed");
  expect(await purgeExpiredEmailBodies(db, { defaultRetentionDays: 30, now })).toBe(0);
  const [scheduledRow] = await db
    .select()
    .from(schema.emails)
    .where(eq(schema.emails.id, scheduled.id));
  expect(scheduledRow?.bodyCiphertext).not.toBeNull();

  // Second run: already-purged rows are not re-stamped. Same fixed clock —
  // the wall clock must never enter this test or the absolute fixture dates
  // silently expire.
  expect(await purgeExpiredEmailBodies(db, { defaultRetentionDays: 30, now })).toBe(0);
});

it("api-request purge deletes old rows but not fresh ones, honoring the instance override", async () => {
  const now = new Date("2026-08-14T00:00:00Z");
  const insertRequest = async (createdAt: Date) => {
    const [row] = await db
      .insert(schema.apiRequests)
      .values({ teamId, method: "POST", path: "/emails", statusCode: 200, createdAt })
      .returning({ id: schema.apiRequests.id });
    if (!row) throw new Error("insert failed");
    return row.id;
  };
  const old = await insertRequest(new Date("2026-07-01T00:00:00Z"));
  const fresh = await insertRequest(new Date("2026-08-01T00:00:00Z"));

  expect(await purgeExpiredApiRequests(db, { defaultRetentionDays: 30, now })).toBe(1);
  const remaining = await db.select({ id: schema.apiRequests.id }).from(schema.apiRequests);
  expect(remaining.map((r) => r.id)).toEqual([fresh]);
  expect(remaining.map((r) => r.id)).not.toContain(old);

  // Second run with the same fixed clock: nothing left to purge.
  expect(await purgeExpiredApiRequests(db, { defaultRetentionDays: 30, now })).toBe(0);

  // Same effective window as email bodies: the instance setting wins.
  await db.insert(schema.instanceSettings).values({ emailRetentionDays: 10 });
  expect(await purgeExpiredApiRequests(db, { defaultRetentionDays: 30, now })).toBe(1);
  expect(await db.select().from(schema.apiRequests)).toHaveLength(0);
});

it("retention purge prefers the instance setting over the env-derived default", async () => {
  const now = new Date("2026-08-14T00:00:00Z");
  // 20 days old: kept under the 30-day default, expired under a 10-day override.
  await db.insert(schema.emails).values({
    teamId,
    from: "a@acme.dev",
    to: ["r@example.com"],
    subject: "override",
    latestStatus: "delivered",
    createdAt: new Date("2026-07-25T00:00:00Z"),
    bodyCiphertext: Buffer.from("ct"),
    bodyIv: Buffer.from("iv"),
    bodyWrappedDek: Buffer.from("dek"),
    bodyKeyVersion: 1,
  });

  expect(await purgeExpiredEmailBodies(db, { defaultRetentionDays: 30, now })).toBe(0);
  await db.insert(schema.instanceSettings).values({ emailRetentionDays: 10 });
  expect(await purgeExpiredEmailBodies(db, { defaultRetentionDays: 30, now })).toBe(1);
});

it("reconcile fails a claim that never reached SES (worker killed mid-send) with an event", async () => {
  const now = new Date();
  const old = (mins: number) => new Date(now.getTime() - mins * 60 * 1000);
  const base = { teamId, from: "a@acme.dev", to: ["r@example.com"], subject: "s" };
  const [interrupted] = await db
    .insert(schema.emails)
    .values({ ...base, latestStatus: "queued", createdAt: old(60), sentAt: old(30) })
    .returning({ id: schema.emails.id });
  // A fresh claim is a send in progress; hands off.
  const [inFlight] = await db
    .insert(schema.emails)
    .values({ ...base, latestStatus: "queued", createdAt: old(60), sentAt: old(1) })
    .returning({ id: schema.emails.id });
  if (!interrupted || !inFlight) throw new Error("insert failed");

  await reconcileStalledSends(db, { enqueueSend: async () => {}, now });

  expect(await statusOf(interrupted.id)).toBe("failed");
  expect(await statusOf(inFlight.id)).toBe("queued");
  const events = await db
    .select()
    .from(schema.emailEvents)
    .where(eq(schema.emailEvents.emailId, interrupted.id));
  expect(events.map((e) => [e.type, e.data?.reason])).toEqual([["failed", "send_interrupted"]]);
});

it("metadata purge deletes whole expired rows (events cascade) and old deliveries, keeping fresh and future-scheduled ones", async () => {
  const now = new Date("2026-08-14T00:00:00Z");
  const base = { teamId, from: "a@acme.dev", to: ["r@example.com"], subject: "s" };
  const insert = async (createdAt: Date, scheduledAt?: Date) => {
    const [row] = await db
      .insert(schema.emails)
      .values({ ...base, latestStatus: "delivered", createdAt, scheduledAt: scheduledAt ?? null })
      .returning({ id: schema.emails.id });
    if (!row) throw new Error("insert failed");
    return row.id;
  };
  const old = await insert(new Date("2025-01-01T00:00:00Z"));
  const fresh = await insert(new Date("2026-08-01T00:00:00Z"));
  const future = await insert(new Date("2025-01-01T00:00:00Z"), new Date("2026-09-01T00:00:00Z"));
  await db
    .insert(schema.emailEvents)
    .values({ emailId: old, type: "delivered", occurredAt: now, data: { eventType: "Delivery" } });
  const [endpoint] = await db
    .insert(schema.webhookEndpoints)
    .values({
      teamId,
      url: "https://hooks.example.com",
      secretCiphertext: Buffer.from("c"),
      secretIv: Buffer.from("i"),
      secretWrappedDek: Buffer.from("d"),
      secretKeyVersion: 1,
      secretLast4: "abcd",
    })
    .returning({ id: schema.webhookEndpoints.id });
  if (!endpoint) throw new Error("insert failed");
  const delivery = (createdAt: Date, emailId: string | null) => ({
    endpointId: endpoint.id,
    emailId,
    messageId: `msg_${createdAt.getTime()}`,
    eventType: "email.delivered",
    payload: { type: "email.delivered" },
    createdAt,
  });
  await db
    .insert(schema.webhookDeliveries)
    .values([delivery(new Date("2025-01-01T00:00:00Z"), old), delivery(now, fresh)]);

  expect(await purgeExpiredEmailMetadata(db, { retentionDays: 365, now })).toEqual({
    emails: 1,
    deliveries: 1,
  });
  const remaining = await db.select({ id: schema.emails.id }).from(schema.emails);
  expect(remaining.map((r) => r.id).sort()).toEqual([fresh, future].sort());
  expect(await db.select().from(schema.emailEvents)).toHaveLength(0);
  expect(await db.select().from(schema.webhookDeliveries)).toHaveLength(1);
  expect(await purgeExpiredEmailMetadata(db, { retentionDays: 365, now })).toEqual({
    emails: 0,
    deliveries: 0,
  });
});

it("payload strip nulls expired event data and drops delivery data/response on the body window", async () => {
  const now = new Date("2026-08-14T00:00:00Z");
  const [email] = await db
    .insert(schema.emails)
    .values({ teamId, from: "a@acme.dev", to: ["r@example.com"], subject: "s" })
    .returning({ id: schema.emails.id });
  if (!email) throw new Error("insert failed");
  await db.insert(schema.emailEvents).values([
    {
      emailId: email.id,
      type: "bounced",
      occurredAt: new Date("2026-07-01T00:00:00Z"),
      data: {
        eventType: "Bounce",
        bounce: { bouncedRecipients: [{ emailAddress: "r@example.com" }] },
      },
    },
    {
      emailId: email.id,
      type: "delivered",
      occurredAt: new Date("2026-08-10T00:00:00Z"),
      data: { eventType: "Delivery" },
    },
  ]);
  const [endpoint] = await db
    .insert(schema.webhookEndpoints)
    .values({
      teamId,
      url: "https://hooks.example.com",
      secretCiphertext: Buffer.from("c"),
      secretIv: Buffer.from("i"),
      secretWrappedDek: Buffer.from("d"),
      secretKeyVersion: 1,
      secretLast4: "abcd",
    })
    .returning({ id: schema.webhookEndpoints.id });
  if (!endpoint) throw new Error("insert failed");
  const [oldDelivery] = await db
    .insert(schema.webhookDeliveries)
    .values({
      endpointId: endpoint.id,
      emailId: email.id,
      messageId: "msg_old",
      eventType: "email.bounced",
      payload: { type: "email.bounced", test: "true", data: { to: ["r@example.com"] } },
      lastResponseBody: "r@example.com",
      createdAt: new Date("2026-07-01T00:00:00Z"),
    })
    .returning({ id: schema.webhookDeliveries.id });
  if (!oldDelivery) throw new Error("insert failed");

  expect(await stripExpiredEventPayloads(db, { defaultRetentionDays: 30, now })).toEqual({
    events: 1,
    deliveries: 1,
  });
  const events = await db
    .select({ type: schema.emailEvents.type, data: schema.emailEvents.data })
    .from(schema.emailEvents)
    .orderBy(schema.emailEvents.occurredAt);
  expect(events).toEqual([
    { type: "bounced", data: null },
    { type: "delivered", data: { eventType: "Delivery" } },
  ]);
  const [row] = await db
    .select()
    .from(schema.webhookDeliveries)
    .where(eq(schema.webhookDeliveries.id, oldDelivery.id));
  expect(row?.payload).toEqual({ type: "email.bounced", test: "true" });
  expect(row?.lastResponseBody).toBeNull();
  // Already-stripped rows are not rewritten on the next run.
  expect(await stripExpiredEventPayloads(db, { defaultRetentionDays: 30, now })).toEqual({
    events: 0,
    deliveries: 0,
  });
});

it("session purge drops only expired sessions", async () => {
  const now = new Date("2026-08-14T00:00:00Z");
  await db.insert(schema.user).values({ id: "u1", name: "u1", email: "u1@example.com" });
  await db.insert(schema.session).values([
    { id: "s-old", token: "t-old", userId: "u1", expiresAt: new Date("2026-08-01T00:00:00Z") },
    { id: "s-live", token: "t-live", userId: "u1", expiresAt: new Date("2026-09-01T00:00:00Z") },
  ]);
  expect(await purgeExpiredSessions(db, now)).toBe(1);
  expect(
    (await db.select({ id: schema.session.id }).from(schema.session)).map((r) => r.id),
  ).toEqual(["s-live"]);
});

it("billing reconcile visits only teams with a Stripe customer and isolates failures", async () => {
  const withStripe = await createTeam(db, "stripe-team");
  await db
    .update(schema.teams)
    .set({ stripeCustomerId: "cus_1" })
    .where(eq(schema.teams.id, withStripe));
  const failing = await createTeam(db, "failing-team");
  await db
    .update(schema.teams)
    .set({ stripeCustomerId: "cus_2" })
    .where(eq(schema.teams.id, failing));
  const visited: string[] = [];
  const result = await reconcileBillingPlans(db, {
    reconcileTeam: async (id) => {
      visited.push(id);
      if (id === failing) throw new Error("stripe down");
    },
  });
  expect(result).toEqual({ reconciled: 1, failed: 1 });
  expect(visited.sort()).toEqual([withStripe, failing].sort());
});

it("holds every parked email while SES's own 24-hour quota is full", async () => {
  await insertParked(new Date("2026-08-13T01:00:00Z"));
  const enqueued: string[] = [];
  const result = await drainQuotaParked(db, {
    isCloud: true,
    enqueueSend: async (id) => {
      enqueued.push(id);
    },
    sesQuotaExhausted: () => true,
  });
  expect(result).toEqual({ drained: 0, stillParked: 1 });
  expect(enqueued).toEqual([]);
});
