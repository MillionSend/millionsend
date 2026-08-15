import { utcDay } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCaller } from "@/server/routers";

// vitest.config sets SKIP_ENV_VALIDATION, so env reads stay live process.env
// reads — send's APP_BASE_URL gate is exercised by setting/clearing it here.
process.env.APP_BASE_URL = "http://localhost:3000";

vi.mock("@millionsend/db", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@millionsend/db")>();
  return { ...mod, getDb: () => db };
});

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  process.env.APP_BASE_URL = "http://localhost:3000";
  ({ db, close } = await createTestDb());
});

afterEach(async () => {
  await close();
});

function callerFor(
  teamId: string,
  extras: {
    enqueueBroadcastSend?: (id: string, opts?: { startAfter?: Date }) => Promise<void>;
  } = {},
) {
  return createCaller({
    db,
    session: { user: { id: "u1", email: "u1@example.com", name: "u1" } },
    teamId,
    role: "owner",
    ...extras,
  });
}

const DRAFT_INPUT = {
  from: "Ada <ada@example.com>",
  subject: "Hello",
  html: "<p>Hi</p>",
};

async function seedDraft(teamId: string) {
  const caller = callerFor(teamId);
  const { id: audienceId } = await caller.audience.audiences.create({ name: "Newsletter" });
  const { id } = await caller.broadcasts.create({ audienceId, ...DRAFT_INPUT });
  return { caller, audienceId, id };
}

async function broadcastRow(id: string) {
  const [row] = await db.select().from(schema.broadcasts).where(eq(schema.broadcasts.id, id));
  return row ?? null;
}

describe("broadcasts.create / get / list", () => {
  it("creates a draft and lists it with audience name and zero recipients", async () => {
    const teamId = await createTeam(db, "team-a");
    const { caller, audienceId, id } = await seedDraft(teamId);

    const got = await caller.broadcasts.get({ id });
    expect(got).toMatchObject({
      id,
      audienceId,
      audienceName: "Newsletter",
      status: "draft",
      from: DRAFT_INPUT.from,
      subject: DRAFT_INPUT.subject,
      html: DRAFT_INPUT.html,
      stats: { total: 0, delivered: 0, bounced: 0, complained: 0 },
    });

    const { items } = await caller.broadcasts.list({});
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id,
      audienceName: "Newsletter",
      status: "draft",
      recipients: 0,
    });
  });

  it("rejects a multi-mailbox or malformed from on create and update", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const { id: audienceId } = await caller.audience.audiences.create({ name: "Newsletter" });
    const spoofed = [
      "Acme <evil@other.test> <ok@mine.test>",
      "a@mine.test, b@other.test",
      "not-an-address",
      "Ada <ada@example.com",
    ];
    for (const from of spoofed) {
      await expect(
        caller.broadcasts.create({ audienceId, ...DRAFT_INPUT, from }),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    }
    const { id } = await caller.broadcasts.create({ audienceId, ...DRAFT_INPUT });
    for (const from of spoofed) {
      await expect(caller.broadcasts.update({ id, from })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    }
    expect((await broadcastRow(id))?.from).toBe(DRAFT_INPUT.from);
  });

  it("pages by keyset cursor without duplicates", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const { id: audienceId } = await caller.audience.audiences.create({ name: "Newsletter" });
    for (let i = 0; i < 3; i++) {
      await caller.broadcasts.create({ audienceId, ...DRAFT_INPUT, subject: `s${i}` });
    }

    const page1 = await caller.broadcasts.list({ limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    if (!page1.nextCursor) throw new Error("expected a next cursor");
    const page2 = await caller.broadcasts.list({ limit: 2, cursor: page1.nextCursor });
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
    const seen = [...page1.items, ...page2.items].map((b) => b.id);
    expect(new Set(seen).size).toBe(3);
  });
});

describe("tenant isolation", () => {
  it("blocks every cross-team read and write", async () => {
    const teamA = await createTeam(db, "team-a");
    const teamB = await createTeam(db, "team-b");
    const { audienceId, id } = await seedDraft(teamA);

    const b = callerFor(teamB);
    await expect(b.broadcasts.get({ id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(b.broadcasts.update({ id, subject: "hijack" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(b.broadcasts.delete({ id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(b.broadcasts.send({ id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(b.broadcasts.cancel({ id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(b.broadcasts.recipientCount({ audienceId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(b.broadcasts.create({ audienceId, ...DRAFT_INPUT })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    // list is scoped, not errored; the broadcast survives all of it.
    expect((await b.broadcasts.list({})).items).toEqual([]);
    expect((await broadcastRow(id))?.subject).toBe(DRAFT_INPUT.subject);
  });
});

describe("draft-only editing", () => {
  it("updates a draft, clearing nullable fields with empty strings", async () => {
    const teamId = await createTeam(db, "team-a");
    const { caller, id } = await seedDraft(teamId);

    await caller.broadcasts.update({
      id,
      name: "Launch",
      replyTo: "reply@example.com",
      subject: "Updated",
    });
    // replyTo is stored as the column's JSON-array wire format…
    expect(await broadcastRow(id)).toMatchObject({
      name: "Launch",
      replyTo: JSON.stringify(["reply@example.com"]),
      subject: "Updated",
    });
    // …and surfaced to the dashboard as a single address.
    expect((await caller.broadcasts.get({ id })).replyTo).toBe("reply@example.com");

    await caller.broadcasts.update({ id, name: "", replyTo: "" });
    expect(await broadcastRow(id)).toMatchObject({ name: null, replyTo: null });
  });

  it("refuses update and delete once the broadcast left draft", async () => {
    const teamId = await createTeam(db, "team-a");
    const { caller, id } = await seedDraft(teamId);
    await caller.broadcasts.send({ id });

    await expect(caller.broadcasts.update({ id, subject: "late" })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    await expect(caller.broadcasts.delete({ id })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect((await broadcastRow(id))?.status).toBe("scheduled");
  });

  it("deletes a draft", async () => {
    const teamId = await createTeam(db, "team-a");
    const { caller, id } = await seedDraft(teamId);
    await caller.broadcasts.delete({ id });
    expect(await broadcastRow(id)).toBeNull();
  });
});

describe("broadcasts.send", () => {
  it("moves a draft to scheduled with an immediate scheduledAt", async () => {
    const teamId = await createTeam(db, "team-a");
    const { caller, id } = await seedDraft(teamId);
    const before = Date.now();
    await caller.broadcasts.send({ id });
    const row = await broadcastRow(id);
    expect(row?.status).toBe("scheduled");
    expect(row?.scheduledAt).not.toBeNull();
    expect(row?.scheduledAt?.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("stores a future scheduledAt", async () => {
    const teamId = await createTeam(db, "team-a");
    const { caller, id } = await seedDraft(teamId);
    const later = new Date(Date.now() + 3_600_000);
    await caller.broadcasts.send({ id, scheduledAt: later });
    expect((await broadcastRow(id))?.scheduledAt?.getTime()).toBe(later.getTime());
  });

  it("blocks sending when APP_BASE_URL is not configured", async () => {
    const teamId = await createTeam(db, "team-a");
    const { caller, id } = await seedDraft(teamId);
    delete process.env.APP_BASE_URL;
    await expect(caller.broadcasts.send({ id })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("APP_BASE_URL"),
    });
    expect((await broadcastRow(id))?.status).toBe("draft");
  });

  it("blocks sending after the audience was deleted (audienceId nulled)", async () => {
    const teamId = await createTeam(db, "team-a");
    const { caller, audienceId, id } = await seedDraft(teamId);
    await caller.audience.audiences.delete({ id: audienceId });
    expect((await broadcastRow(id))?.audienceId).toBeNull();
    await expect(caller.broadcasts.send({ id })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
  });

  it("hands the broadcast to the fan-out queue with scheduledAt as startAfter", async () => {
    const teamId = await createTeam(db, "team-a");
    const { id } = await seedDraft(teamId);
    const enqueued: { id: string; startAfter?: Date }[] = [];
    const caller = callerFor(teamId, {
      enqueueBroadcastSend: async (broadcastId, opts) => {
        enqueued.push({
          id: broadcastId,
          ...(opts?.startAfter ? { startAfter: opts.startAfter } : {}),
        });
      },
    });
    const later = new Date(Date.now() + 3_600_000);
    await caller.broadcasts.send({ id, scheduledAt: later });
    expect(enqueued).toEqual([{ id, startAfter: later }]);
  });

  it("keeps the scheduled commit when the enqueue fails (sweep recovers)", async () => {
    const teamId = await createTeam(db, "team-a");
    const { id } = await seedDraft(teamId);
    const caller = callerFor(teamId, {
      enqueueBroadcastSend: async () => {
        throw new Error("queue down");
      },
    });
    await caller.broadcasts.send({ id });
    expect((await broadcastRow(id))?.status).toBe("scheduled");
  });

  it("refuses to send anything but a draft", async () => {
    const teamId = await createTeam(db, "team-a");
    const { caller, id } = await seedDraft(teamId);
    await caller.broadcasts.send({ id });
    await expect(caller.broadcasts.send({ id })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
  });
});

describe("broadcasts.send deliverability guard", () => {
  async function seedWindowCounter(
    teamId: string,
    counts: { accepted: number; complained?: number; bounced?: number },
  ) {
    await db.insert(schema.usageCounters).values({ teamId, day: utcDay(Date.now()), ...counts });
  }

  it("blocks the send when the window complaint rate is over the pause line", async () => {
    const teamId = await createTeam(db, "team-a");
    const { id } = await seedDraft(teamId);
    // 3/2000 = 0.15% > 0.1% pause line, and 2000 > the 1000 volume floor.
    await seedWindowCounter(teamId, { accepted: 2000, complained: 3 });

    const enqueued: string[] = [];
    const caller = callerFor(teamId, {
      enqueueBroadcastSend: async (broadcastId) => {
        enqueued.push(broadcastId);
      },
    });
    await expect(caller.broadcasts.send({ id })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("0.1%"),
    });
    expect(enqueued).toEqual([]);
    expect((await broadcastRow(id))?.status).toBe("draft");
  });

  it("does not pause a tiny sample below the volume floor at the same rate", async () => {
    const teamId = await createTeam(db, "team-a");
    const { id } = await seedDraft(teamId);
    // 3/500 = 0.6% (well over the rate line) but 500 < the 1000 volume floor.
    await seedWindowCounter(teamId, { accepted: 500, complained: 3 });

    await callerFor(teamId).broadcasts.send({ id });
    expect((await broadcastRow(id))?.status).toBe("scheduled");
  });
});

describe("broadcasts.cancel", () => {
  it("cancels only from scheduled", async () => {
    const teamId = await createTeam(db, "team-a");
    const { caller, id } = await seedDraft(teamId);

    await expect(caller.broadcasts.cancel({ id })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });

    await caller.broadcasts.send({ id });
    await caller.broadcasts.cancel({ id });
    expect((await broadcastRow(id))?.status).toBe("canceled");

    await expect(caller.broadcasts.cancel({ id })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
  });
});

describe("broadcasts.recipientCount", () => {
  it("counts only subscribed contacts", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const { id: audienceId } = await caller.audience.audiences.create({ name: "Newsletter" });
    await caller.audience.contacts.add({ audienceId, email: "a@example.com" });
    await caller.audience.contacts.add({ audienceId, email: "b@example.com" });
    const { id: unsubbed } = await caller.audience.contacts.add({
      audienceId,
      email: "c@example.com",
    });
    await caller.audience.contacts.update({ id: unsubbed, unsubscribed: true });

    expect(await caller.broadcasts.recipientCount({ audienceId })).toEqual({ count: 2 });
  });

  it("scopes the count to a topic's subscribers per the subscription rule", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const { id: audienceId } = await caller.audience.audiences.create({ name: "Newsletter" });
    const { id: a } = await caller.audience.contacts.add({ audienceId, email: "a@example.com" });
    const { id: b } = await caller.audience.contacts.add({ audienceId, email: "b@example.com" });
    const { id: c } = await caller.audience.contacts.add({ audienceId, email: "c@example.com" });
    // Globally unsubscribed: excluded from every topic regardless of overrides.
    await caller.audience.contacts.update({ id: c, unsubscribed: true });

    // Opt-in topic: b opts out, c is global-unsub → only a remains.
    const optIn = await caller.topics.create({ name: "In", defaultSubscribed: true });
    await caller.audience.contacts.setTopic({ contactId: b, topicId: optIn.id, subscribed: false });
    expect(await caller.broadcasts.recipientCount({ audienceId, topicId: optIn.id })).toEqual({
      count: 1,
    });

    // Opt-out topic: nobody counts until they explicitly opt in (a does).
    const optOut = await caller.topics.create({ name: "Out", defaultSubscribed: false });
    expect(await caller.broadcasts.recipientCount({ audienceId, topicId: optOut.id })).toEqual({
      count: 0,
    });
    await caller.audience.contacts.setTopic({ contactId: a, topicId: optOut.id, subscribed: true });
    expect(await caller.broadcasts.recipientCount({ audienceId, topicId: optOut.id })).toEqual({
      count: 1,
    });
  });
});

describe("delivery stats", () => {
  it("aggregates fanned-out emails by latest status, opened/clicked counting as delivered", async () => {
    const teamId = await createTeam(db, "team-a");
    const { caller, id } = await seedDraft(teamId);

    const statuses = ["sent", "delivered", "opened", "clicked", "bounced", "complained"] as const;
    await db.insert(schema.emails).values(
      statuses.map((latestStatus, i) => ({
        teamId,
        broadcastId: id,
        contactId: crypto.randomUUID(),
        from: DRAFT_INPUT.from,
        to: [`r${i}@example.com`],
        subject: DRAFT_INPUT.subject,
        latestStatus,
      })),
    );

    const { stats } = await caller.broadcasts.get({ id });
    expect(stats).toEqual({ total: 6, delivered: 3, bounced: 1, complained: 1 });

    const { items } = await caller.broadcasts.list({});
    expect(items[0]?.recipients).toBe(6);
  });

  it("keeps stats scoped to the broadcast", async () => {
    const teamId = await createTeam(db, "team-a");
    const { caller, id } = await seedDraft(teamId);
    // An unrelated (API-sent) email must not leak into broadcast stats.
    await db.insert(schema.emails).values({
      teamId,
      from: "x@example.com",
      to: ["y@example.com"],
      subject: "unrelated",
      latestStatus: "delivered",
    });
    expect((await caller.broadcasts.get({ id })).stats.total).toBe(0);
  });
});

describe("fan-out idempotency spine", () => {
  it("rejects a second email row for the same (broadcast, contact)", async () => {
    const teamId = await createTeam(db, "team-a");
    const { id } = await seedDraft(teamId);
    const contactId = crypto.randomUUID();
    const emailRow = {
      teamId,
      broadcastId: id,
      contactId,
      from: DRAFT_INPUT.from,
      to: ["r@example.com"],
      subject: DRAFT_INPUT.subject,
    };
    await db.insert(schema.emails).values(emailRow);
    await expect(db.insert(schema.emails).values(emailRow)).rejects.toThrow();
    const rows = await db
      .select({ id: schema.emails.id })
      .from(schema.emails)
      .where(and(eq(schema.emails.broadcastId, id), eq(schema.emails.contactId, contactId)));
    expect(rows).toHaveLength(1);
  });
});
