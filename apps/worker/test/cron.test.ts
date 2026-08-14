import { PLAN_DAILY_LIMIT } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { drainQuotaParked, purgeExpiredEmailBodies } from "../src/handlers/cron.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;

beforeEach(async () => {
  // Fresh database per test: drain math depends on exact counter state.
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "cron-team");
});
afterEach(() => close());

const today = () => new Date().toISOString().slice(0, 10);

const FREE_LIMIT = PLAN_DAILY_LIMIT.free;
if (FREE_LIMIT === null) throw new Error("free plan is expected to have a daily cap");

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
  // Free cap is 100; today's counter already holds 99 → only ONE parked
  // email may drain, oldest first.
  await db.insert(schema.usageCounters).values({ teamId, day: today(), accepted: FREE_LIMIT - 1 });
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
  expect(counter?.accepted).toBe(FREE_LIMIT);
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

it("enqueue failure re-parks the email and returns the reservation", async () => {
  const emailId = await insertParked(new Date("2026-08-13T01:00:00Z"));

  await expect(
    drainQuotaParked(db, {
      isCloud: true,
      enqueueSend: async () => {
        throw new Error("queue down");
      },
    }),
  ).rejects.toThrow("queue down");

  expect(await statusOf(emailId)).toBe("queued_quota");
  const [counter] = await db
    .select()
    .from(schema.usageCounters)
    .where(eq(schema.usageCounters.teamId, teamId));
  expect(counter?.accepted ?? 0).toBe(0);
});

it("retention purge nulls only expired bodies and stamps bodyPurgedAt", async () => {
  const now = new Date("2026-08-14T00:00:00Z");
  const body = {
    bodyCiphertext: Buffer.from("ct"),
    bodyIv: Buffer.from("iv"),
    bodyWrappedDek: Buffer.from("dek"),
    bodyKeyVersion: 1,
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

  expect(await purgeExpiredEmailBodies(db, { retentionDays: 30, now })).toBe(1);

  const [oldRow] = await db.select().from(schema.emails).where(eq(schema.emails.id, old.id));
  expect(oldRow?.bodyCiphertext).toBeNull();
  expect(oldRow?.bodyIv).toBeNull();
  expect(oldRow?.bodyWrappedDek).toBeNull();
  expect(oldRow?.bodyKeyVersion).toBeNull();
  expect(oldRow?.bodyPurgedAt).toEqual(now);
  // Metadata survives the content purge (separate lifecycles).
  expect(oldRow?.subject).toBe("old");
  expect(oldRow?.to).toEqual(["r@example.com"]);

  const [freshRow] = await db.select().from(schema.emails).where(eq(schema.emails.id, fresh.id));
  expect(freshRow?.bodyCiphertext).not.toBeNull();

  // Second run: already-purged rows are not re-stamped.
  expect(await purgeExpiredEmailBodies(db, { retentionDays: 30, now: new Date() })).toBe(0);
});
