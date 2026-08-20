import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCaller } from "@/server/routers";

vi.mock("@millionsend/db", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@millionsend/db")>();
  return { ...mod, getDb: () => db };
});

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});

afterEach(async () => {
  await close();
});

function callerFor(teamId: string) {
  return createCaller({
    db,
    session: { user: { id: "u1", email: "u1@example.com", name: "u1" } },
    teamId,
    role: "owner",
  });
}

async function activityTypes(contactIds: string[]) {
  const rows = await db
    .select({ contactId: schema.contactActivities.contactId, type: schema.contactActivities.type })
    .from(schema.contactActivities)
    .where(inArray(schema.contactActivities.contactId, contactIds));
  // contact_created rows come from contacts.add; the bulk assertions ignore them.
  return rows.filter((r) => r.type !== "contact_created");
}

async function seed() {
  const teamId = await createTeam(db, "team-a");
  const caller = callerFor(teamId);
  const { id: ada } = await caller.audience.contacts.add({ email: "ada@x.com" });
  const { id: bob } = await caller.audience.contacts.add({ email: "bob@x.com" });
  return { teamId, caller, ada, bob };
}

describe("audience.contacts.bulkAddSegments", () => {
  it("adds every contact to every segment; re-runs dedupe and record no activity", async () => {
    const { caller, ada, bob } = await seed();
    const { id: vip } = await caller.segments.create({
      name: "VIP",
      filter: { match: "all", conditions: [] },
    });
    const { id: beta } = await caller.segments.create({
      name: "Beta",
      filter: { match: "all", conditions: [] },
    });
    // ada is already in VIP: that pair must conflict away, not double-insert.
    await caller.audience.contacts.addSegment({ contactId: ada, segmentId: vip });

    const result = await caller.audience.contacts.bulkAddSegments({
      contactIds: [ada, bob],
      segmentIds: [vip, beta],
    });
    expect(result).toEqual({ added: 3 });
    expect(
      (await caller.audience.contacts.segments({ contactId: ada })).map((s) => s.name),
    ).toEqual(["Beta", "VIP"]);
    expect(
      (await caller.audience.contacts.segments({ contactId: bob })).map((s) => s.name),
    ).toEqual(["Beta", "VIP"]);

    // Timeline: one segment_added per REAL transition (1 pre-seeded + 3 bulk).
    const acts = await activityTypes([ada, bob]);
    expect(acts.filter((a) => a.type === "segment_added")).toHaveLength(4);

    // Re-run: everything conflicts away — nothing added, no new timeline rows.
    expect(
      await caller.audience.contacts.bulkAddSegments({
        contactIds: [ada, bob],
        segmentIds: [vip, beta],
      }),
    ).toEqual({ added: 0 });
    expect(await activityTypes([ada, bob])).toHaveLength(4);
  });

  it("rejects a foreign contact or segment before writing anything", async () => {
    const { caller, ada } = await seed();
    const teamB = await createTeam(db, "team-b");
    const b = callerFor(teamB);
    const { id: bContact } = await b.audience.contacts.add({ email: "eve@y.com" });
    const { id: bSegment } = await b.segments.create({
      name: "B-only",
      filter: { match: "all", conditions: [] },
    });
    const { id: aSegment } = await caller.segments.create({
      name: "A",
      filter: { match: "all", conditions: [] },
    });

    await expect(
      caller.audience.contacts.bulkAddSegments({
        contactIds: [ada, bContact],
        segmentIds: [aSegment],
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      caller.audience.contacts.bulkAddSegments({ contactIds: [ada], segmentIds: [bSegment] }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await db.select().from(schema.segmentMembers)).toEqual([]);
    expect(await activityTypes([ada, bContact])).toEqual([]);
  });

  it("caps contactIds at 100", async () => {
    const { caller } = await seed();
    const { id: segmentId } = await caller.segments.create({
      name: "S",
      filter: { match: "all", conditions: [] },
    });
    const contactIds = Array.from({ length: 101 }, () => crypto.randomUUID());
    await expect(
      caller.audience.contacts.bulkAddSegments({ contactIds, segmentIds: [segmentId] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("audience.contacts.bulkRemoveSegment", () => {
  it("removes only members and records activity only for real leaves", async () => {
    const { caller, ada, bob } = await seed();
    const { id: vip } = await caller.segments.create({
      name: "VIP",
      filter: { match: "all", conditions: [] },
    });
    await caller.audience.contacts.addSegment({ contactId: ada, segmentId: vip });

    // bob was never a member: removed counts only ada, and only ada gets a row.
    expect(
      await caller.audience.contacts.bulkRemoveSegment({ contactIds: [ada, bob], segmentId: vip }),
    ).toEqual({ removed: 1 });
    expect(await caller.audience.contacts.segments({ contactId: ada })).toEqual([]);
    const acts = await activityTypes([ada, bob]);
    expect(acts.filter((a) => a.type === "segment_removed")).toEqual([
      { contactId: ada, type: "segment_removed" },
    ]);
  });

  it("rejects a foreign segment without touching memberships", async () => {
    const { caller, ada } = await seed();
    const teamB = await createTeam(db, "team-b");
    const { id: bSegment } = await callerFor(teamB).segments.create({
      name: "B-only",
      filter: { match: "all", conditions: [] },
    });
    await expect(
      caller.audience.contacts.bulkRemoveSegment({ contactIds: [ada], segmentId: bSegment }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("audience.contacts.bulkSubscribeTopics", () => {
  it("upserts explicit opt-ins but records only real transitions", async () => {
    const { caller, ada, bob } = await seed();
    // Opt-in topic: everyone effectively subscribed already — no transitions.
    const { id: news } = await caller.topics.create({ name: "News", defaultSubscribed: true });
    // Opt-out topic: nobody subscribed; ada already explicitly opted in.
    const { id: beta } = await caller.topics.create({ name: "Beta", defaultSubscribed: false });
    await caller.audience.contacts.setTopic({ contactId: ada, topicId: beta, subscribed: true });
    // bob explicitly opted OUT of the opt-in topic: that IS a transition back.
    await caller.audience.contacts.setTopic({ contactId: bob, topicId: news, subscribed: false });

    const result = await caller.audience.contacts.bulkSubscribeTopics({
      contactIds: [ada, bob],
      topicIds: [news, beta],
    });
    // Transitions: bob→News (explicit false → true) and bob→Beta (default
    // false → true). ada was already effectively in both.
    expect(result).toEqual({ optedIn: 2 });

    // Every pair now carries an explicit subscribed=true row.
    const subs = await db
      .select({
        contactId: schema.contactTopicSubscriptions.contactId,
        subscribed: schema.contactTopicSubscriptions.subscribed,
      })
      .from(schema.contactTopicSubscriptions);
    expect(subs).toHaveLength(4);
    expect(subs.every((s) => s.subscribed)).toBe(true);

    const optIns = (await activityTypes([ada, bob])).filter((a) => a.type === "topic_opt_in");
    // ada's pre-seeded Beta opt-in plus bob's two bulk transitions.
    expect(optIns).toHaveLength(3);
    expect(optIns.filter((a) => a.contactId === bob)).toHaveLength(2);

    // Re-run: effective state is already subscribed everywhere — no new rows.
    expect(
      await caller.audience.contacts.bulkSubscribeTopics({
        contactIds: [ada, bob],
        topicIds: [news, beta],
      }),
    ).toEqual({ optedIn: 0 });
    expect((await activityTypes([ada, bob])).filter((a) => a.type === "topic_opt_in")).toHaveLength(
      3,
    );
  });

  it("rejects a foreign topic before writing anything", async () => {
    const { caller, ada } = await seed();
    const teamB = await createTeam(db, "team-b");
    const { id: bTopic } = await callerFor(teamB).topics.create({
      name: "B-only",
      defaultSubscribed: false,
    });
    await expect(
      caller.audience.contacts.bulkSubscribeTopics({ contactIds: [ada], topicIds: [bTopic] }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await db.select().from(schema.contactTopicSubscriptions)).toEqual([]);
  });
});

describe("audience.contacts.bulkDelete", () => {
  it("deletes the batch and cascades memberships, subscriptions, and activities", async () => {
    const { caller, ada, bob } = await seed();
    const { id: vip } = await caller.segments.create({
      name: "VIP",
      filter: { match: "all", conditions: [] },
    });
    const { id: beta } = await caller.topics.create({ name: "Beta", defaultSubscribed: false });
    await caller.audience.contacts.bulkAddSegments({ contactIds: [ada, bob], segmentIds: [vip] });
    await caller.audience.contacts.bulkSubscribeTopics({
      contactIds: [ada, bob],
      topicIds: [beta],
    });

    expect(await caller.audience.contacts.bulkDelete({ contactIds: [ada, bob] })).toEqual({
      deleted: 2,
    });
    expect((await caller.audience.contacts.stats()).contacts).toBe(0);
    expect(await db.select().from(schema.segmentMembers)).toEqual([]);
    expect(await db.select().from(schema.contactTopicSubscriptions)).toEqual([]);
    expect(await db.select().from(schema.contactActivities)).toEqual([]);
  });

  it("rejects the whole batch when one id is foreign, deleting nothing", async () => {
    const { caller, ada } = await seed();
    const teamB = await createTeam(db, "team-b");
    const { id: bContact } = await callerFor(teamB).audience.contacts.add({ email: "eve@y.com" });

    await expect(
      caller.audience.contacts.bulkDelete({ contactIds: [ada, bContact] }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await caller.audience.contacts.stats()).contacts).toBe(2);
    expect((await callerFor(teamB).audience.contacts.stats()).contacts).toBe(1);
  });

  it("caps contactIds at 100", async () => {
    const { caller } = await seed();
    const contactIds = Array.from({ length: 101 }, () => crypto.randomUUID());
    await expect(caller.audience.contacts.bulkDelete({ contactIds })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });
});
