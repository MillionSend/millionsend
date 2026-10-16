import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb, createWebhookEndpoint } from "@millionsend/test-utils";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyStatusCas, endQueuedEmails } from "../src/status.js";
import type { QueuedWebhookDelivery } from "../src/webhooks.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db);
});
afterAll(() => close());

async function createEmail(): Promise<string> {
  const [row] = await db
    .insert(schema.emails)
    .values({ teamId, from: "a@b.c", to: ["x@y.z"], subject: "s" })
    .returning({ id: schema.emails.id });
  if (!row) throw new Error("email insert failed");
  return row.id;
}

async function statusOf(id: string): Promise<string> {
  const [row] = await db
    .select({ s: schema.emails.latestStatus })
    .from(schema.emails)
    .where(eq(schema.emails.id, id));
  return row?.s ?? "missing";
}

describe("status compare-and-set", () => {
  it("advances forward and records the highest status", async () => {
    const id = await createEmail();
    expect(await applyStatusCas(db, id, "sent")).toBe(true);
    expect(await applyStatusCas(db, id, "delivered")).toBe(true);
    expect(await statusOf(id)).toBe("delivered");
  });

  it("ignores out-of-order lower-ranked events", async () => {
    const id = await createEmail();
    await applyStatusCas(db, id, "delivered");
    expect(await applyStatusCas(db, id, "sent")).toBe(false);
    expect(await statusOf(id)).toBe("delivered");
  });

  it("keeps failed terminal: nothing outranks it", async () => {
    const id = await createEmail();
    await applyStatusCas(db, id, "failed");
    expect(await applyStatusCas(db, id, "delivered")).toBe(false);
    expect(await statusOf(id)).toBe("failed");
  });

  it("lets bounce outrank delivered (post-delivery bounce reports)", async () => {
    const id = await createEmail();
    await applyStatusCas(db, id, "delivered");
    expect(await applyStatusCas(db, id, "bounced")).toBe(true);
    expect(await statusOf(id)).toBe("bounced");
  });
});

describe("endQueuedEmails", () => {
  const e = schema.emails;
  const now = new Date("2026-10-16T12:00:00.000Z");

  async function insertEmails(
    rows: Partial<typeof schema.emails.$inferInsert>[],
  ): Promise<string[]> {
    const inserted = await db
      .insert(e)
      .values(rows.map((row) => ({ teamId, from: "a@b.c", to: ["x@y.z"], subject: "s", ...row })))
      .returning({ id: e.id });
    return inserted.map((row) => row.id);
  }

  const rowsOf = (ids: string[]) =>
    db
      .select({ id: e.id, status: e.latestStatus, sentAt: e.sentAt })
      .from(e)
      .where(inArray(e.id, ids));
  const eventsOf = (ids: string[]) =>
    db
      .select({
        emailId: schema.emailEvents.emailId,
        type: schema.emailEvents.type,
        data: schema.emailEvents.data,
      })
      .from(schema.emailEvents)
      .where(inArray(schema.emailEvents.emailId, ids));
  const deliveriesOf = (ids: string[]) =>
    db
      .select()
      .from(schema.webhookDeliveries)
      .where(inArray(schema.webhookDeliveries.emailId, ids));

  it("ends queued rows with their events and one email.failed each, per team, never a row SES took", async () => {
    const teamA = await createTeam(db, "end-a");
    const teamB = await createTeam(db, "end-b");
    const endpointA = await createWebhookEndpoint(db, teamA, null);
    const endpointB = await createWebhookEndpoint(db, teamB, ["email.failed"]);
    const claimed = new Date("2026-10-16T11:00:00.000Z");
    const [queued, parked, other, accepted, delivered] = await insertEmails([
      { teamId: teamA, latestStatus: "queued", sentAt: claimed, subject: "one" },
      { teamId: teamA, latestStatus: "queued_quota" },
      { teamId: teamB, latestStatus: "queued", to: ["b@y.z"] },
      // SES took it, then the bookkeeping after the send failed: not ours to end.
      { teamId: teamA, latestStatus: "queued", sentAt: claimed, sesMessageId: "end-mid-1" },
      { teamId: teamA, latestStatus: "delivered", sentAt: claimed, sesMessageId: "end-mid-2" },
    ]);
    const ids = [queued, parked, other, accepted, delivered].map((id) => id ?? "");
    const collected: QueuedWebhookDelivery[] = [];

    const ended = await endQueuedEmails(db, {
      status: "failed",
      where: inArray(e.id, ids),
      data: { source: "worker", reason: "send_interrupted" },
      now,
      enqueue: async (rows) => {
        collected.push(...rows);
      },
    });

    expect(ended).toBe(3);
    const rows = new Map((await rowsOf(ids)).map((row) => [row.id, row]));
    for (const id of [queued, parked, other]) {
      expect(rows.get(id ?? "")).toMatchObject({ status: "failed", sentAt: null });
    }
    expect(rows.get(accepted ?? "")).toMatchObject({ status: "queued", sentAt: claimed });
    expect(rows.get(delivered ?? "")?.status).toBe("delivered");
    const events = await eventsOf(ids);
    expect(events.map((ev) => ev.emailId).sort()).toEqual([queued, parked, other].sort());
    for (const ev of events) {
      expect(ev).toMatchObject({
        type: "failed",
        data: { source: "worker", reason: "send_interrupted" },
      });
      expect(Object.keys(ev.data ?? {}).sort()).toEqual(["reason", "source"]);
    }
    const deliveries = await deliveriesOf(ids);
    expect(deliveries.map((d) => [d.endpointId, d.emailId]).sort()).toEqual(
      [
        [endpointA, queued],
        [endpointA, parked],
        [endpointB, other],
      ].sort(),
    );
    expect(deliveries.find((d) => d.emailId === queued)?.payload).toEqual({
      type: "email.failed",
      created_at: now.toISOString(),
      data: {
        email_id: queued,
        from: "a@b.c",
        to: ["x@y.z"],
        subject: "one",
        created_at: now.toISOString(),
        failed: { reason: "send_interrupted" },
      },
    });
    expect(collected.map((r) => r.id).sort()).toEqual(deliveries.map((d) => d.id).sort());
  });

  it("ends a row once: a second call loses the compare-and-set and writes nothing", async () => {
    const team = await createTeam(db, "end-once");
    await createWebhookEndpoint(db, team, null);
    const ids = await insertEmails([{ teamId: team, latestStatus: "queued" }]);
    const suppress = () =>
      endQueuedEmails(db, {
        status: "suppressed",
        where: inArray(e.id, ids),
        data: { source: "worker", reason: "topic_unsubscribed" },
        now,
        enqueue: async () => {},
      });

    expect(await suppress()).toBe(1);
    expect(await suppress()).toBe(0);

    expect((await rowsOf(ids))[0]?.status).toBe("suppressed");
    expect(await eventsOf(ids)).toHaveLength(1);
    const deliveries = await deliveriesOf(ids);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.payload).toMatchObject({
      type: "email.suppressed",
      data: {
        suppressed: {
          type: "Unsubscribed",
          message: "The recipient opted out of this email's topic.",
          reason: "topic_unsubscribed",
        },
      },
    });
  });

  it("writes nothing that outlives the caller's transaction", async () => {
    const team = await createTeam(db, "end-rollback");
    await createWebhookEndpoint(db, team, null);
    const ids = await insertEmails([{ teamId: team, latestStatus: "queued" }]);

    await expect(
      db.transaction(async (tx) => {
        await endQueuedEmails(tx as unknown as Db, {
          status: "failed",
          where: inArray(e.id, ids),
          data: { reason: "domain_deleted" },
          now,
          enqueue: async () => {},
        });
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");

    expect((await rowsOf(ids))[0]?.status).toBe("queued");
    expect(await eventsOf(ids)).toEqual([]);
    expect(await deliveriesOf(ids)).toEqual([]);
  });
});
