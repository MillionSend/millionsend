import { utcDay } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRegionAccountDeps } from "@/server/console/ses-regions";
import { createCaller } from "@/server/routers";

// vitest.config sets SKIP_ENV_VALIDATION (env reads stay live), so setting
// the KEK here is enough for the router's lazily built keyring.
process.env.MASTER_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

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
  vi.unstubAllEnvs();
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

// A Maily/Tiptap doc: a paragraph carrying a variable node. The variable
// serializes to the worker's {{{FIRST_NAME|there}}} token when rendered.
const SAMPLE_DOC = {
  type: "doc" as const,
  content: [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Hi " },
        { type: "variable", attrs: { id: "FIRST_NAME", fallback: "there" } },
      ],
    },
  ],
};

// send verifies the From domain like the API does, so every draft's sender
// domain is a verified team domain.
async function seedVerifiedDomain(teamId: string, name = "example.com") {
  await db.insert(schema.domains).values({ teamId, name, region: "us-east-1", status: "verified" });
}

async function seedDraft(teamId: string) {
  await seedVerifiedDomain(teamId);
  const caller = callerFor(teamId);
  const { id } = await caller.broadcasts.create(DRAFT_INPUT);
  return { caller, id };
}

async function broadcastRow(id: string) {
  const [row] = await db.select().from(schema.broadcasts).where(eq(schema.broadcasts.id, id));
  return row ?? null;
}

describe("broadcasts.create / get / list", () => {
  it("creates a draft and lists it with zero recipients and no segment", async () => {
    const teamId = await createTeam(db, "team-a");
    const { caller, id } = await seedDraft(teamId);

    const got = await caller.broadcasts.get({ id });
    expect(got).toMatchObject({
      id,
      status: "draft",
      from: DRAFT_INPUT.from,
      subject: DRAFT_INPUT.subject,
      html: DRAFT_INPUT.html,
      segmentId: null,
      segmentName: null,
      topicName: null,
      stats: {
        total: 0,
        delivered: 0,
        opened: 0,
        clicked: 0,
        prefetched: 0,
        bounced: 0,
        complained: 0,
        unsubscribed: 0,
      },
    });

    const { items } = await caller.broadcasts.list({});
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id,
      segmentName: null,
      status: "draft",
      recipients: 0,
    });
  });

  it("rejects a multi-mailbox or malformed from on create and update", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const spoofed = [
      "Acme <evil@other.test> <ok@mine.test>",
      "a@mine.test, b@other.test",
      "not-an-address",
      "Ada <ada@example.com",
    ];
    for (const from of spoofed) {
      await expect(caller.broadcasts.create({ ...DRAFT_INPUT, from })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    }
    const { id } = await caller.broadcasts.create(DRAFT_INPUT);
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
    for (let i = 0; i < 3; i++) {
      await caller.broadcasts.create({ ...DRAFT_INPUT, subject: `s${i}` });
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

describe("broadcasts.document", () => {
  it("round-trips a Maily document, rendering send html from it, then clears it", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const { id } = await caller.broadcasts.create({
      ...DRAFT_INPUT,
      document: SAMPLE_DOC,
    });
    const got = await caller.broadcasts.get({ id });
    expect(got.document).toEqual(SAMPLE_DOC);
    // Send html is re-rendered from the document, not the client-sent DRAFT html.
    expect(got.html).toContain("{{{FIRST_NAME|there}}}");
    // Clearing back to a legacy raw-HTML draft.
    await caller.broadcasts.update({ id, document: null, html: "<p>raw</p>" });
    const row = await broadcastRow(id);
    expect(row?.document).toBeNull();
    expect(row?.html).toBe("<p>raw</p>");
  });

  it("leaves the document null on a legacy raw-HTML draft", async () => {
    const teamId = await createTeam(db, "team-a");
    const { id } = await seedDraft(teamId);
    expect((await broadcastRow(id))?.document).toBeNull();
  });

  it("rejects a malformed document via the zod guard", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    await expect(
      caller.broadcasts.create({
        ...DRAFT_INPUT,
        // biome-ignore lint/suspicious/noExplicitAny: deliberately wrong shape
        document: { version: 1, blocks: [{ type: "nope" }] } as any,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("tenant isolation", () => {
  it("blocks every cross-team read and write", async () => {
    const teamA = await createTeam(db, "team-a");
    const teamB = await createTeam(db, "team-b");
    const { caller: a, id } = await seedDraft(teamA);
    await a.audience.contacts.add({ email: "a@example.com" });

    const b = callerFor(teamB);
    await expect(b.broadcasts.get({ id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(b.broadcasts.update({ id, subject: "hijack" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(b.broadcasts.delete({ id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(b.broadcasts.send({ id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(b.broadcasts.cancel({ id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // recipientCount is team-scoped: A's contact never counts for B.
    expect(await b.broadcasts.recipientCount({})).toEqual({ count: 0 });
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
  it.each([
    ["suspended", { suspendedAt: new Date(), suspensionReason: "manual" as const }],
    ["paused by the operator", { broadcastsPausedByOperatorAt: new Date() }],
  ])("refuses to schedule while the team is %s", async (_label, hold) => {
    const teamId = await createTeam(db, "team-a");
    const { caller, id } = await seedDraft(teamId);
    await db.update(schema.teams).set(hold).where(eq(schema.teams.id, teamId));
    await expect(caller.broadcasts.send({ id })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect((await broadcastRow(id))?.status).toBe("draft");
  });

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

  it("refuses a scheduledAt more than 30 days ahead", async () => {
    const teamId = await createTeam(db, "team-a");
    const { caller, id } = await seedDraft(teamId);
    const tooLate = new Date(Date.now() + 31 * 86_400_000);
    await expect(caller.broadcasts.send({ id, scheduledAt: tooLate })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect((await broadcastRow(id))?.status).toBe("draft");
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

  it("refuses to send from a domain the team has not verified", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    await seedVerifiedDomain(teamId, "verified.example.com");
    await db
      .insert(schema.domains)
      .values({ teamId, name: "pending.example.com", region: "us-east-1", status: "pending" });
    const foreignTeam = await createTeam(db, "team-b");
    await seedVerifiedDomain(foreignTeam, "foreign.example.com");

    for (const from of [
      "a@pending.example.com",
      "a@foreign.example.com",
      "a@nowhere.example.com",
    ]) {
      const { id } = await caller.broadcasts.create({ ...DRAFT_INPUT, from });
      await expect(caller.broadcasts.send({ id })).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        message: expect.stringContaining("not verified"),
      });
      expect((await broadcastRow(id))?.status).toBe("draft");
    }
    const { id } = await caller.broadcasts.create({
      ...DRAFT_INPUT,
      from: "a@verified.example.com",
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
    counts: { sent: number; complained?: number; bounced?: number },
  ) {
    await db.insert(schema.usageCounters).values({ teamId, day: utcDay(Date.now()), ...counts });
  }

  it("blocks the send when the window complaint rate is over the pause line", async () => {
    const teamId = await createTeam(db, "team-a");
    const { id } = await seedDraft(teamId);
    // 3/2000 = 0.15% > 0.1% pause line, 3 complaints = the minimum count.
    await seedWindowCounter(teamId, { sent: 2000, complained: 3 });

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

  it("does not pause on a pause-line rate without the minimum complaint count", async () => {
    const teamId = await createTeam(db, "team-a");
    const { id } = await seedDraft(teamId);
    // 2/2000 = exactly 0.1%, but 2 < 3 complaints.
    await seedWindowCounter(teamId, { sent: 2000, complained: 2 });

    await callerFor(teamId).broadcasts.send({ id });
    expect((await broadcastRow(id))?.status).toBe("scheduled");
  });

  it("does not pause a tiny sample below the volume floor", async () => {
    const teamId = await createTeam(db, "team-a");
    const { id } = await seedDraft(teamId);
    // 3/50 = 6% with enough complaints, but 50 < the 100-send floor.
    await seedWindowCounter(teamId, { sent: 50, complained: 3 });

    await callerFor(teamId).broadcasts.send({ id });
    expect((await broadcastRow(id))?.status).toBe("scheduled");
  });
});

describe("broadcasts.send platform breaker", () => {
  it("refuses a send while the sender domain's region is held, naming the region", async () => {
    const teamId = await createTeam(db, "team-a");
    const { id } = await seedDraft(teamId);
    await db.insert(schema.regionBreakers).values({
      region: "us-east-1",
      paused: true,
      reason: {
        metric: "bounce",
        rate: 0.041,
        limit: 0.05,
        windowHours: 24,
        sent: 2000,
        events: 82,
      },
      pausedAt: new Date(),
    });
    const enqueued: string[] = [];
    const caller = callerFor(teamId, {
      enqueueBroadcastSend: async (broadcastId) => {
        enqueued.push(broadcastId);
      },
    });
    await expect(caller.broadcasts.send({ id })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("us-east-1"),
    });
    expect(enqueued).toEqual([]);
    expect((await broadcastRow(id))?.status).toBe("draft");

    await db.delete(schema.regionBreakers);
    await caller.broadcasts.send({ id });
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
    await caller.audience.contacts.add({ email: "a@example.com" });
    await caller.audience.contacts.add({ email: "b@example.com" });
    const { id: unsubbed } = await caller.audience.contacts.add({ email: "c@example.com" });
    await caller.audience.contacts.update({ id: unsubbed, unsubscribed: true });

    expect(await caller.broadcasts.recipientCount({})).toEqual({ count: 2 });
  });

  it("scopes the count to a topic's subscribers per the subscription rule", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const { id: a } = await caller.audience.contacts.add({ email: "a@example.com" });
    const { id: b } = await caller.audience.contacts.add({ email: "b@example.com" });
    const { id: c } = await caller.audience.contacts.add({ email: "c@example.com" });
    // Globally unsubscribed: excluded from every topic regardless of overrides.
    await caller.audience.contacts.update({ id: c, unsubscribed: true });

    // Opt-in topic: b opts out, c is global-unsub → only a remains.
    const optIn = await caller.topics.create({ name: "In", defaultSubscribed: true });
    await caller.audience.contacts.setTopic({ contactId: b, topicId: optIn.id, subscribed: false });
    expect(await caller.broadcasts.recipientCount({ topicId: optIn.id })).toEqual({
      count: 1,
    });

    // Opt-out topic: nobody counts until they explicitly opt in (a does).
    const optOut = await caller.topics.create({ name: "Out", defaultSubscribed: false });
    expect(await caller.broadcasts.recipientCount({ topicId: optOut.id })).toEqual({
      count: 0,
    });
    await caller.audience.contacts.setTopic({ contactId: a, topicId: optOut.id, subscribed: true });
    expect(await caller.broadcasts.recipientCount({ topicId: optOut.id })).toEqual({
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
    // Opened counts the opened rung and clicked above it; a prefetch would
    // never lift a row here, so none is expected.
    expect(stats).toEqual({
      total: 6,
      delivered: 3,
      opened: 2,
      clicked: 1,
      prefetched: 0,
      bounced: 1,
      complained: 1,
      unsubscribed: 0,
    });

    const { items } = await caller.broadcasts.list({});
    expect(items[0]?.recipients).toBe(6);

    // Once the fan-out has stored recipient_count it is the size of record
    // (email rows are purged by retention; the stored count is not).
    await db
      .update(schema.broadcasts)
      .set({ recipientCount: 9 })
      .where(eq(schema.broadcasts.id, id));
    expect((await caller.broadcasts.get({ id })).stats.total).toBe(9);
    expect((await caller.broadcasts.list({})).items[0]?.recipients).toBe(9);
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

describe("broadcasts.sendTest", () => {
  it("sends the composer's content to the signed-in user, rendered and marked, under an hourly cap", async () => {
    const teamId = await createTeam(db, "team-test-send");
    await db
      .insert(schema.domains)
      .values({ teamId, name: "acme.dev", region: "us-east-1", status: "verified" });
    const caller = callerFor(teamId);
    const result = await caller.broadcasts.sendTest({
      from: "Acme <news@acme.dev>",
      subject: "Hello {{{FIRST_NAME|there}}}",
      html: '<p>Hi {{{FIRST_NAME}}}</p><a href="{{{UNSUBSCRIBE_URL}}}">out</a>',
      text: null,
      previewText: "Preview",
    });
    expect(result).toEqual({ to: "u1@example.com" });
    const [row] = await db
      .select({ to: schema.emails.to, subject: schema.emails.subject, tags: schema.emails.tags })
      .from(schema.emails)
      .where(eq(schema.emails.teamId, teamId));
    expect(row).toMatchObject({
      to: ["u1@example.com"],
      subject: "[Test] Hello u1",
      tags: { millionsend_test: "1" },
    });

    // Ten in the last hour is the cap; the eleventh is refused.
    await db.insert(schema.emails).values(
      Array.from({ length: 9 }, (_, i) => ({
        teamId,
        from: "news@acme.dev",
        to: ["u1@example.com"],
        subject: `t${i}`,
        tags: { millionsend_test: "1" },
      })),
    );
    await expect(
      caller.broadcasts.sendTest({
        from: "news@acme.dev",
        subject: "s",
        html: "<p>x</p>",
        text: null,
      }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });
});

describe("the instance's onboarding sender", () => {
  it("is refused by send and sendTest, even for a team holding its domain", async () => {
    vi.stubEnv("ONBOARDING_EMAIL_FROM", "MillionSend <hello@ms.example>");
    const teamId = await createTeam(db, "team-a");
    await seedVerifiedDomain(teamId, "ms.example");
    const caller = callerFor(teamId);
    const reserved = {
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("hello@ms.example is reserved for MillionSend's own"),
    };
    const { id } = await caller.broadcasts.create({ ...DRAFT_INPUT, from: "Hello@MS.example" });
    await expect(caller.broadcasts.send({ id })).rejects.toMatchObject(reserved);
    expect((await broadcastRow(id))?.status).toBe("draft");
    await expect(
      caller.broadcasts.sendTest({
        from: "MillionSend <hello@ms.example>",
        subject: "s",
        html: "<p>x</p>",
        text: null,
      }),
    ).rejects.toMatchObject(reserved);
    expect(await db.select().from(schema.emails).where(eq(schema.emails.teamId, teamId))).toEqual(
      [],
    );
  });
});

describe("paced sends", () => {
  type Quota = { max24h: number; sentLast24h: number; maxSendRate: number };
  function stubAccount(quota: Quota | Error) {
    setRegionAccountDeps({
      accountClient: () => ({
        async send() {
          if (quota instanceof Error) throw quota;
          return {
            SendingEnabled: true,
            ProductionAccessEnabled: true,
            EnforcementStatus: "HEALTHY",
            SendQuota: {
              Max24HourSend: quota.max24h,
              SentLast24Hours: quota.sentLast24h,
              MaxSendRate: quota.maxSendRate,
            },
          };
        },
      }),
    });
  }
  afterEach(() => setRegionAccountDeps(null));

  async function seedContacts(teamId: string, n: number) {
    await db
      .insert(schema.contacts)
      .values(Array.from({ length: n }, (_, i) => ({ teamId, email: `c${i}@example.com` })));
  }

  async function seedSendingBroadcast(teamId: string) {
    const { caller, id } = await seedDraft(teamId);
    const scheduledAt = new Date(Date.now() - 60_000);
    await db
      .update(schema.broadcasts)
      .set({ status: "sending", scheduledAt })
      .where(eq(schema.broadcasts.id, id));
    const [domain] = await db
      .select({ id: schema.domains.id })
      .from(schema.domains)
      .where(eq(schema.domains.teamId, teamId));
    const row = (latestStatus: "sent" | "queued" | "queued_quota", i: number) => ({
      teamId,
      broadcastId: id,
      domainId: domain?.id ?? null,
      contactId: crypto.randomUUID(),
      from: DRAFT_INPUT.from,
      to: [`r${i}@example.com`],
      subject: DRAFT_INPUT.subject,
      latestStatus,
      sentAt: latestStatus === "sent" ? new Date() : null,
    });
    await db
      .insert(schema.emails)
      .values([
        row("sent", 0),
        row("sent", 1),
        row("queued", 2),
        row("queued", 3),
        row("queued", 4),
        row("queued_quota", 5),
        row("queued_quota", 6),
        row("queued_quota", 7),
        row("queued_quota", 8),
      ]);
    return { caller, id, scheduledAt };
  }

  it("sendPlan answers the count alone while SES has not answered", async () => {
    stubAccount(new Error("ses down"));
    const teamId = await createTeam(db, "team-a");
    await seedVerifiedDomain(teamId);
    await seedContacts(teamId, 2);
    const plan = await callerFor(teamId).broadcasts.sendPlan({ from: DRAFT_INPUT.from });
    expect(plan).toEqual({ count: 2, cloud: false, estimate: null });
  });

  it("sendPlan estimates a paced send from the region's quota", async () => {
    // Share 7 of a 10-a-day quota: 20 contacts go out over three days.
    stubAccount({ max24h: 10, sentLast24h: 0, maxSendRate: 14 });
    const teamId = await createTeam(db, "team-a");
    await seedVerifiedDomain(teamId);
    await seedContacts(teamId, 20);
    const caller = callerFor(teamId);
    const { count, estimate } = await caller.broadcasts.sendPlan({ from: DRAFT_INPUT.from });
    expect(count).toBe(20);
    expect(estimate).toMatchObject({ first: 7, blocked: false, days: 3, planHold: null });
    expect(estimate?.releases.reduce((n, r) => n + r.count, 0)).toBe(20);
    expect(estimate?.finishesAt?.getTime()).toBeGreaterThan(Date.now() + 40 * 3_600_000);
    // An unverified sender gets the count only.
    expect(
      (await caller.broadcasts.sendPlan({ from: "a@nowhere.example.com" })).estimate,
    ).toBeNull();
  });

  it("send refuses an audience that needs more days than the horizon", async () => {
    stubAccount({ max24h: 10, sentLast24h: 0, maxSendRate: 14 });
    const teamId = await createTeam(db, "team-a");
    const { caller, id } = await seedDraft(teamId);
    await seedContacts(teamId, 200);
    expect((await caller.broadcasts.sendPlan({ from: DRAFT_INPUT.from })).estimate).toMatchObject({
      blocked: true,
      horizonDays: 24,
    });
    await expect(caller.broadcasts.send({ id })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("24 days"),
    });
    expect((await broadcastRow(id))?.status).toBe("draft");
    // The same audience under a real quota is fine.
    stubAccount({ max24h: 100_000, sentLast24h: 0, maxSendRate: 14 });
    await caller.broadcasts.send({ id });
    expect((await broadcastRow(id))?.status).toBe("scheduled");
  });

  it("cancel stops the rest of a send in progress and says how many", async () => {
    const teamId = await createTeam(db, "team-a");
    const { caller, id } = await seedSendingBroadcast(teamId);
    expect(await caller.broadcasts.cancel({ id })).toEqual({ id, canceledRemaining: 7 });
    expect((await broadcastRow(id))?.status).toBe("canceled");
    const rows = await db
      .select({ status: schema.emails.latestStatus })
      .from(schema.emails)
      .where(eq(schema.emails.broadcastId, id));
    expect(rows.filter((r) => r.status === "canceled")).toHaveLength(7);
    expect(rows.filter((r) => r.status === "sent")).toHaveLength(2);
  });

  it("list and get carry the progress and the forecast of a send in progress", async () => {
    stubAccount({ max24h: 100_000, sentLast24h: 0, maxSendRate: 14 });
    const teamId = await createTeam(db, "team-a");
    const { caller, id, scheduledAt } = await seedSendingBroadcast(teamId);
    const { items } = await caller.broadcasts.list({});
    expect(items[0]).toMatchObject({
      id,
      status: "sending",
      recipients: 9,
      sentCount: 2,
      parkedCount: 4,
    });
    expect(items[0]?.finishesAt).toBeInstanceOf(Date);
    const got = await caller.broadcasts.get({ id });
    expect(got).toMatchObject({
      sentCount: 2,
      parkedCount: 4,
      startedAt: scheduledAt,
      planHold: null,
    });
    expect(got.finishesAt).toBeInstanceOf(Date);
    // Draft rows carry none of it.
    const { id: draft } = await caller.broadcasts.create(DRAFT_INPUT);
    expect(await caller.broadcasts.get({ id: draft })).toMatchObject({
      sentCount: null,
      finishesAt: null,
      startedAt: null,
    });
  });
});
