import { deriveUnsubscribeKey, hashRecipient, makeUnsubscribeToken } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseCsvContacts } from "@/lib/csv";
import { createCaller } from "@/server/routers";

// vitest.config sets SKIP_ENV_VALIDATION (env reads stay live), so setting
// the KEK here is enough for the unsubscribe route's key derivation.
const TEST_KEK = Buffer.alloc(32, 7).toString("base64");
process.env.MASTER_ENCRYPTION_KEY = TEST_KEK;

// The route handler resolves its connection through getDb(); point it at the
// per-test PGlite while keeping schema and types real.
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

async function contactRow(id: string) {
  const [row] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, id));
  return row ?? null;
}

describe("audience.contacts.stats", () => {
  it("counts the team's contacts and unsubscribed for the stat strip", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);

    await caller.audience.contacts.add({ email: "a@example.com" });
    const { id: unsubbed } = await caller.audience.contacts.add({ email: "b@example.com" });
    await caller.audience.contacts.update({ id: unsubbed, unsubscribed: true });

    expect(await caller.audience.contacts.stats()).toEqual({ contacts: 2, unsubscribed: 1 });

    // A team with no contacts reports zeros, never another team's counts.
    const emptyTeam = await createTeam(db, "team-b");
    expect(await callerFor(emptyTeam).audience.contacts.stats()).toEqual({
      contacts: 0,
      unsubscribed: 0,
    });
  });
});

describe("tenant isolation", () => {
  it("blocks every cross-team read and write", async () => {
    const teamA = await createTeam(db, "team-a");
    const teamB = await createTeam(db, "team-b");
    const a = callerFor(teamA);
    const { id: contactId } = await a.audience.contacts.add({ email: "a@example.com" });

    const b = callerFor(teamB);
    await expect(b.audience.contacts.get({ id: contactId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      b.audience.contacts.update({ id: contactId, unsubscribed: true }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(b.audience.contacts.delete({ id: contactId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    // list is scoped, not errored; the contact survives all of it.
    expect((await b.audience.contacts.list({})).items).toEqual([]);
    expect((await contactRow(contactId))?.unsubscribed).toBe(false);
  });
});

describe("audience.contacts.add", () => {
  it("rejects a duplicate address case-insensitively within the team", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    await caller.audience.contacts.add({ email: "Ada@example.com" });
    await expect(caller.audience.contacts.add({ email: "ada@EXAMPLE.com" })).rejects.toMatchObject({
      code: "CONFLICT",
    });

    // Uniqueness is per team: another team can hold the same address.
    const teamB = await createTeam(db, "team-b");
    await expect(
      callerFor(teamB).audience.contacts.add({ email: "ada@example.com" }),
    ).resolves.toMatchObject({ id: expect.any(String) });
  });

  it("stores optional names, trimmed empty as null", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const { id } = await caller.audience.contacts.add({
      email: "ada@example.com",
      firstName: "Ada",
      lastName: "",
    });
    expect(await contactRow(id)).toMatchObject({ firstName: "Ada", lastName: null });
  });

  it("persists custom properties and returns them from get", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const { id } = await caller.audience.contacts.add({
      email: "ada@example.com",
      properties: { plan: "pro", city: "London" },
    });
    expect((await contactRow(id))?.properties).toEqual({ plan: "pro", city: "London" });
    expect((await caller.audience.contacts.get({ id })).properties).toEqual({
      plan: "pro",
      city: "London",
    });
  });

  it("defaults properties to an empty map when none are given", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const { id } = await caller.audience.contacts.add({ email: "ada@example.com" });
    expect((await contactRow(id))?.properties).toEqual({});
    expect((await caller.audience.contacts.get({ id })).properties).toEqual({});
  });
});

describe("audience.contacts.addMany", () => {
  it("dedupes against the batch and the team, skipping invalid rows", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    await caller.audience.contacts.add({ email: "existing@example.com" });

    const result = await caller.audience.contacts.addMany({
      rows: [
        { email: "new1@example.com", firstName: "One" },
        { email: "NEW1@example.com" }, // batch-internal dupe (case-insensitive)
        { email: "Existing@example.com" }, // the team already has it
        { email: "not-an-email" }, // invalid
        { email: "new2@example.com" },
      ],
    });
    expect(result).toEqual({ created: 2, skipped: 3 });

    // Re-running the same batch creates nothing.
    const rerun = await caller.audience.contacts.addMany({
      rows: [{ email: "new1@example.com" }, { email: "new2@example.com" }],
    });
    expect(rerun).toEqual({ created: 0, skipped: 2 });
    expect((await caller.audience.contacts.stats()).contacts).toBe(3);
  });

  it("survives a concurrent import racing the same address", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);

    // Both imports carry the same address (plus an in-batch dupe); neither
    // may 500 on the unique index — the loser counts it as skipped.
    const [a, b] = await Promise.all([
      caller.audience.contacts.addMany({
        rows: [{ email: "raced@example.com" }, { email: "RACED@example.com" }],
      }),
      caller.audience.contacts.addMany({
        rows: [{ email: "Raced@example.com" }],
      }),
    ]);
    expect(a.created + b.created).toBe(1);
    expect(a.created + a.skipped).toBe(2);
    expect(b.created + b.skipped).toBe(1);
    expect((await caller.audience.contacts.stats()).contacts).toBe(1);
  });

  it("caps properties at 100 keys, 200-char keys, and 1000-char values", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const tooMany = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`k${i}`, "v"]));
    for (const properties of [tooMany, { ["k".repeat(201)]: "v" }, { k: "v".repeat(1001) }]) {
      await expect(
        caller.audience.contacts.add({ email: "cap@example.com", properties }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect((await caller.audience.contacts.stats()).contacts).toBe(0);
  });

  it("caps a batch at 1000 rows", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const rows = Array.from({ length: 1001 }, (_, i) => ({ email: `u${i}@example.com` }));
    await expect(caller.audience.contacts.addMany({ rows })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });
});

describe("audience.contacts.list", () => {
  it("searches email and names, and pages by keyset cursor", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    await caller.audience.contacts.addMany({
      rows: [
        { email: "ada@example.com", firstName: "Ada", lastName: "Lovelace" },
        { email: "grace@example.com", firstName: "Grace" },
        { email: "alan@example.com" },
      ],
    });

    const byName = await caller.audience.contacts.list({ search: "lovelace" });
    expect(byName.items.map((c) => c.email)).toEqual(["ada@example.com"]);
    expect(byName.total).toBe(1);

    const page1 = await caller.audience.contacts.list({ limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.total).toBe(3);
    expect(page1.nextCursor).not.toBeNull();
    if (!page1.nextCursor) throw new Error("expected a next cursor");
    const page2 = await caller.audience.contacts.list({
      limit: 2,
      cursor: page1.nextCursor,
    });
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
    const seen = [...page1.items, ...page2.items].map((c) => c.id);
    expect(new Set(seen).size).toBe(3);
  });
});

describe("audience.contacts.list filters", () => {
  it("narrows to a segment, matching the segment's own count", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    await caller.audience.contacts.addMany({
      rows: [{ email: "ada@x.com" }, { email: "bob@x.com" }, { email: "cyd@y.com" }],
    });
    const { id: segmentId } = await caller.segments.create({
      name: "X domain",
      filter: { match: "all", conditions: [{ field: "email", op: "ends_with", value: "@x.com" }] },
    });

    const scoped = await caller.audience.contacts.list({ segmentId });
    expect(scoped.items.map((c) => c.email).sort()).toEqual(["ada@x.com", "bob@x.com"]);
    // The list scope equals the segment's live membership count.
    expect(scoped.total).toBe((await caller.segments.get({ id: segmentId })).count);

    // The segment filter survives paging by keyset cursor.
    const page1 = await caller.audience.contacts.list({ segmentId, limit: 1 });
    expect(page1.items).toHaveLength(1);
    expect(page1.total).toBe(2);
    if (!page1.nextCursor) throw new Error("expected a next cursor");
    const page2 = await caller.audience.contacts.list({
      segmentId,
      limit: 1,
      cursor: page1.nextCursor,
    });
    const emails = [...page1.items, ...page2.items].map((c) => c.email).sort();
    expect(emails).toEqual(["ada@x.com", "bob@x.com"]);
  });

  it("narrows to subscribed or unsubscribed contacts, counting the scope", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    await caller.audience.contacts.add({ email: "ada@x.com" });
    const { id: bob } = await caller.audience.contacts.add({ email: "bob@x.com" });
    await caller.audience.contacts.update({ id: bob, unsubscribed: true });

    const unsubscribed = await caller.audience.contacts.list({ status: "unsubscribed" });
    expect(unsubscribed.items.map((c) => c.email)).toEqual(["bob@x.com"]);
    expect(unsubscribed.total).toBe(1);
    const subscribed = await caller.audience.contacts.list({ status: "subscribed" });
    expect(subscribed.items.map((c) => c.email)).toEqual(["ada@x.com"]);
    expect(subscribed.total).toBe(1);
  });

  it("narrows to a topic by effective membership (default plus explicit overrides)", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const { id: ada } = await caller.audience.contacts.add({ email: "ada@x.com" });
    const { id: bob } = await caller.audience.contacts.add({ email: "bob@x.com" });

    // Opt-in topic: everyone subscribed by default; bob opts out.
    const { id: optIn } = await caller.topics.create({ name: "News", defaultSubscribed: true });
    await caller.audience.contacts.setTopic({ contactId: bob, topicId: optIn, subscribed: false });
    expect(
      (await caller.audience.contacts.list({ topicId: optIn })).items.map((c) => c.email),
    ).toEqual(["ada@x.com"]);

    // Opt-out topic: nobody subscribed by default; ada opts in.
    const { id: optOut } = await caller.topics.create({ name: "Beta", defaultSubscribed: false });
    await caller.audience.contacts.setTopic({ contactId: ada, topicId: optOut, subscribed: true });
    const optOutList = await caller.audience.contacts.list({ topicId: optOut });
    expect(optOutList.items.map((c) => c.email)).toEqual(["ada@x.com"]);
    expect(optOutList.total).toBe(1);
  });

  it("rejects another team's segment and topic", async () => {
    const teamA = await createTeam(db, "team-a");
    const teamB = await createTeam(db, "team-b");
    const a = callerFor(teamA);
    const b = callerFor(teamB);
    const { id: aSegment } = await a.segments.create({
      name: "seg",
      filter: { match: "all", conditions: [] },
    });
    const { id: aTopic } = await a.topics.create({ name: "T", defaultSubscribed: true });

    // B cannot borrow A's segment or topic to filter B's own contacts.
    await expect(b.audience.contacts.list({ segmentId: aSegment })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(b.audience.contacts.list({ topicId: aTopic })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("audience.contacts.list topic names", () => {
  it("carries each row's opted-in topic names, name-sorted, from effective membership", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const { id: ada } = await caller.audience.contacts.add({ email: "ada@x.com" });
    const { id: bob } = await caller.audience.contacts.add({ email: "bob@x.com" });

    // Opt-in "News": everyone by default; bob opts out.
    const { id: news } = await caller.topics.create({ name: "News", defaultSubscribed: true });
    await caller.audience.contacts.setTopic({ contactId: bob, topicId: news, subscribed: false });
    // Opt-out "Beta": nobody by default; ada opts in.
    const { id: beta } = await caller.topics.create({ name: "Beta", defaultSubscribed: false });
    await caller.audience.contacts.setTopic({ contactId: ada, topicId: beta, subscribed: true });

    const { items } = await caller.audience.contacts.list({});
    const byEmail = new Map(items.map((c) => [c.email, c.topics]));
    expect(byEmail.get("ada@x.com")).toEqual(["Beta", "News"]);
    expect(byEmail.get("bob@x.com")).toEqual([]);
  });

  it("never borrows another team's topics", async () => {
    const teamA = await createTeam(db, "team-a");
    const teamB = await createTeam(db, "team-b");
    await callerFor(teamB).topics.create({ name: "B-only", defaultSubscribed: true });
    const a = callerFor(teamA);
    await a.audience.contacts.add({ email: "ada@x.com" });

    const { items } = await a.audience.contacts.list({});
    expect(items[0]?.topics).toEqual([]);
  });
});

describe("audience.contacts.segments", () => {
  it("lists only manual memberships, name-sorted and team-scoped", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const { id: contactId } = await caller.audience.contacts.add({ email: "ada@x.com" });

    const [zeta, alpha, unjoined] = await db
      .insert(schema.segments)
      .values([
        { teamId, name: "Zeta" },
        { teamId, name: "Alpha" },
        // A filter segment the contact matches but was never manually added to.
        {
          teamId,
          name: "Filtered",
          filter: {
            match: "all" as const,
            conditions: [{ field: "email", op: "ends_with", value: "@x.com" }],
          },
        },
      ])
      .returning({ id: schema.segments.id });
    if (!zeta || !alpha || !unjoined) throw new Error("seed failed");
    await db.insert(schema.segmentMembers).values([
      { segmentId: zeta.id, contactId },
      { segmentId: alpha.id, contactId },
    ]);

    const rows = await caller.audience.contacts.segments({ contactId });
    expect(rows.map((s) => s.name)).toEqual(["Alpha", "Zeta"]);

    // Another team cannot read this contact's memberships.
    const teamB = await createTeam(db, "team-b");
    await expect(callerFor(teamB).audience.contacts.segments({ contactId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("audience.contacts.addSegment / removeSegment", () => {
  async function activityRows(contactId: string) {
    return db
      .select()
      .from(schema.contactActivities)
      .where(eq(schema.contactActivities.contactId, contactId));
  }

  it("joins and leaves idempotently, recording only real transitions", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const { id: contactId } = await caller.audience.contacts.add({ email: "ada@x.com" });
    const { id: segmentId } = await caller.segments.create({
      name: "VIP",
      filter: { match: "all", conditions: [] },
    });

    expect(await caller.audience.contacts.addSegment({ contactId, segmentId })).toEqual({
      added: true,
    });
    expect((await caller.audience.contacts.segments({ contactId })).map((s) => s.name)).toEqual([
      "VIP",
    ]);
    // Re-add: no-op, no duplicate timeline row.
    expect(await caller.audience.contacts.addSegment({ contactId, segmentId })).toEqual({
      added: false,
    });

    expect(await caller.audience.contacts.removeSegment({ contactId, segmentId })).toEqual({
      removed: true,
    });
    expect(await caller.audience.contacts.segments({ contactId })).toEqual([]);
    // Re-remove: no-op, no phantom timeline row.
    expect(await caller.audience.contacts.removeSegment({ contactId, segmentId })).toEqual({
      removed: false,
    });

    const rows = await activityRows(contactId);
    const segmentRows = rows.filter((r) => r.type.startsWith("segment_"));
    expect(segmentRows.map((r) => r.type).sort()).toEqual(["segment_added", "segment_removed"]);
    // Both rows carry the name snapshot for the timeline.
    expect(segmentRows.every((r) => r.data && (r.data as { name: string }).name === "VIP")).toBe(
      true,
    );
  });

  it("rejects a foreign contact and a foreign segment", async () => {
    const teamA = await createTeam(db, "team-a");
    const teamB = await createTeam(db, "team-b");
    const a = callerFor(teamA);
    const b = callerFor(teamB);
    const { id: contactId } = await a.audience.contacts.add({ email: "ada@x.com" });
    const { id: bSegment } = await b.segments.create({
      name: "B-only",
      filter: { match: "all", conditions: [] },
    });

    // B cannot touch A's contact at all.
    await expect(
      b.audience.contacts.addSegment({ contactId, segmentId: bSegment }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // A cannot write a membership into B's segment.
    await expect(
      a.audience.contacts.addSegment({ contactId, segmentId: bSegment }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      a.audience.contacts.removeSegment({ contactId, segmentId: bSegment }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await a.audience.contacts.segments({ contactId })).toEqual([]);
  });
});

describe("audience.contacts.list segment names", () => {
  it("carries each row's manual memberships, name-sorted; filter matches don't count", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const { id: ada } = await caller.audience.contacts.add({ email: "ada@x.com" });
    await caller.audience.contacts.add({ email: "bob@x.com" });

    const { id: zeta } = await caller.segments.create({
      name: "Zeta",
      filter: { match: "all", conditions: [] },
    });
    const { id: alpha } = await caller.segments.create({
      name: "Alpha",
      filter: { match: "all", conditions: [] },
    });
    // A filter segment everyone matches — never a manual membership.
    await caller.segments.create({
      name: "Everyone",
      filter: { match: "all", conditions: [{ field: "email", op: "ends_with", value: "@x.com" }] },
    });
    await caller.audience.contacts.addSegment({ contactId: ada, segmentId: zeta });
    await caller.audience.contacts.addSegment({ contactId: ada, segmentId: alpha });

    const { items } = await caller.audience.contacts.list({});
    const byEmail = new Map(items.map((c) => [c.email, c.segments]));
    expect(byEmail.get("ada@x.com")).toEqual(["Alpha", "Zeta"]);
    expect(byEmail.get("bob@x.com")).toEqual([]);
  });
});

describe("audience.contacts.activities", () => {
  it("returns the timeline newest first with the snapshot payload", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    // Direct insert: contacts.add would write its own contact_created row and
    // muddy the hand-seeded timeline below.
    const [contact] = await db
      .insert(schema.contacts)
      .values({ teamId, email: "ada@x.com" })
      .returning({ id: schema.contacts.id });
    const contactId = contact?.id ?? "";

    await db.insert(schema.contactActivities).values([
      { teamId, contactId, type: "contact_created", createdAt: new Date("2026-01-01T00:00:00Z") },
      {
        teamId,
        contactId,
        type: "topic_opt_in",
        data: { topicId: "t1", name: "News" },
        createdAt: new Date("2026-01-02T00:00:00Z"),
      },
    ]);

    const rows = await caller.audience.contacts.activities({ contactId });
    expect(rows.map((a) => a.type)).toEqual(["topic_opt_in", "contact_created"]);
    expect(rows[0]?.data).toEqual({ topicId: "t1", name: "News" });

    // Another team cannot read this contact's timeline.
    const teamB = await createTeam(db, "team-b");
    await expect(
      callerFor(teamB).audience.contacts.activities({ contactId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("audience.contacts.update", () => {
  it("flips subscription state and clears names with empty strings", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const { id } = await caller.audience.contacts.add({
      email: "ada@example.com",
      firstName: "Ada",
    });

    expect(await caller.audience.contacts.update({ id, unsubscribed: true })).toMatchObject({
      unsubscribed: true,
    });
    await caller.audience.contacts.update({ id, firstName: "", lastName: "Lovelace" });
    expect(await contactRow(id)).toMatchObject({
      firstName: null,
      lastName: "Lovelace",
      unsubscribed: true,
    });
  });

  it("replaces the whole properties map, leaving it untouched when omitted", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const { id } = await caller.audience.contacts.add({
      email: "ada@example.com",
      properties: { plan: "pro", city: "London" },
    });

    // Provided map replaces wholesale — the dropped key does not survive.
    await caller.audience.contacts.update({ id, properties: { plan: "free" } });
    expect((await contactRow(id))?.properties).toEqual({ plan: "free" });

    // Omitting properties leaves the stored map unchanged.
    await caller.audience.contacts.update({ id, firstName: "Ada" });
    expect((await contactRow(id))?.properties).toEqual({ plan: "free" });

    // An explicit empty map clears it.
    await caller.audience.contacts.update({ id, properties: {} });
    expect((await contactRow(id))?.properties).toEqual({});
  });
});

describe("audience.properties.list", () => {
  it("derives distinct keys with coverage counts and a sample value", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    await caller.audience.contacts.add({
      email: "ada@example.com",
      properties: { plan: "pro", city: "London" },
    });
    await caller.audience.contacts.add({
      email: "grace@example.com",
      properties: { plan: "free" },
    });
    // A contact with no properties at all: counts toward the coverage
    // denominator but contributes no key.
    await caller.audience.contacts.add({ email: "alan@example.com" });

    const props = await caller.audience.properties.list();
    // Sorted by coverage desc: plan (2) before city (1).
    expect(props.map((p) => p.key)).toEqual(["plan", "city"]);
    expect(props.every((p) => p.totalContacts === 3)).toBe(true);
    const plan = props.find((p) => p.key === "plan");
    const city = props.find((p) => p.key === "city");
    expect(plan?.contactCount).toBe(2);
    expect(city?.contactCount).toBe(1);
    expect(["pro", "free"]).toContain(plan?.sampleValue);
    expect(city?.sampleValue).toBe("London");
  });

  it("ignores empty-string values and counts only non-empty coverage", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    await caller.audience.contacts.add({
      email: "ada@example.com",
      properties: { plan: "pro", note: "" },
    });
    await caller.audience.contacts.add({
      email: "grace@example.com",
      properties: { plan: "" },
    });

    const props = await caller.audience.properties.list();
    // `note` (only ever "") and the empty `plan` value never count.
    expect(props.map((p) => p.key)).toEqual(["plan"]);
    expect(props[0]?.contactCount).toBe(1);
    expect(props[0]?.totalContacts).toBe(2);
    expect(props[0]?.sampleValue).toBe("pro");
  });

  it("returns no rows when every contact's map is empty", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    await caller.audience.contacts.add({ email: "ada@example.com" });
    expect(await caller.audience.properties.list()).toEqual([]);
  });

  it("never surfaces another team's properties", async () => {
    const teamA = await createTeam(db, "team-a");
    const teamB = await createTeam(db, "team-b");
    const a = callerFor(teamA);
    const b = callerFor(teamB);
    await a.audience.contacts.add({
      email: "ada@example.com",
      properties: { secret: "A-only" },
    });
    await b.audience.contacts.add({
      email: "bob@example.com",
      properties: { plan: "pro" },
    });

    expect((await b.audience.properties.list()).map((p) => p.key)).toEqual(["plan"]);
    expect((await a.audience.properties.list()).map((p) => p.key)).toEqual(["secret"]);
  });

  it("returns a hostile property key as data, never executing it", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const hostile = `x")-- drop`;
    await caller.audience.contacts.add({
      email: "ada@example.com",
      properties: { [hostile]: "harmless" },
    });

    const props = await caller.audience.properties.list();
    expect(props.map((p) => p.key)).toEqual([hostile]);
    expect(props[0]?.sampleValue).toBe("harmless");
    // The contact survives — nothing was dropped or truncated.
    expect((await caller.audience.contacts.stats()).contacts).toBe(1);
  });
});

describe("audience.properties definitions", () => {
  it("defines, lists, and removes typed properties, scoped to the team", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);

    const { id } = await caller.audience.properties.define({
      key: "plan",
      fallbackValue: "free",
    });
    // type defaults to 'string'; the fallback round-trips.
    expect(await caller.audience.properties.defineList()).toMatchObject([
      { id, key: "plan", type: "string", fallbackValue: "free" },
    ]);

    await caller.audience.properties.remove({ id });
    expect(await caller.audience.properties.defineList()).toEqual([]);
  });

  it("rejects a case-insensitive duplicate key", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    await caller.audience.properties.define({ key: "Plan" });
    await expect(caller.audience.properties.define({ key: "plan" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("defines a number property, requiring a numeric fallback", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);

    await expect(
      caller.audience.properties.define({ key: "seats", type: "number", fallbackValue: "many" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const { id } = await caller.audience.properties.define({
      key: "seats",
      type: "number",
      fallbackValue: "2",
    });
    expect(await caller.audience.properties.defineList()).toMatchObject([
      { id, key: "seats", type: "number", fallbackValue: "2" },
    ]);
  });

  it("stores a hostile key as data, never executing it", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const hostile = `x")-- drop`;
    await caller.audience.properties.define({ key: hostile });
    expect((await caller.audience.properties.defineList()).map((p) => p.key)).toEqual([hostile]);
    // The table survives — nothing dropped.
    await expect(caller.audience.properties.define({ key: "plan" })).resolves.toMatchObject({
      id: expect.any(String),
    });
  });

  it("never leaks or removes another team's definitions", async () => {
    const teamA = await createTeam(db, "team-a");
    const teamB = await createTeam(db, "team-b");
    const a = callerFor(teamA);
    const b = callerFor(teamB);
    const { id: aProp } = await a.audience.properties.define({ key: "secret" });
    await b.audience.properties.define({ key: "plan" });

    expect((await b.audience.properties.defineList()).map((p) => p.key)).toEqual(["plan"]);
    await expect(b.audience.properties.remove({ id: aProp })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect((await a.audience.properties.defineList()).map((p) => p.key)).toEqual(["secret"]);
  });

  it("carries coverage alongside a definition once contacts have the value", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    await caller.audience.properties.define({ key: "plan" });
    await caller.audience.contacts.add({
      email: "ada@example.com",
      properties: { plan: "pro" },
    });
    await caller.audience.contacts.add({ email: "alan@example.com" });

    // The tab merges the two sources: the definition exists, and the derived
    // list supplies its coverage (1 of 2 contacts).
    expect((await caller.audience.properties.defineList()).map((p) => p.key)).toEqual(["plan"]);
    const plan = (await caller.audience.properties.list()).find((p) => p.key === "plan");
    expect(plan).toMatchObject({ contactCount: 1, totalContacts: 2 });
  });
});

describe("unsubscribe route", () => {
  const secretKey = deriveUnsubscribeKey(Buffer.from(TEST_KEK, "base64"));

  async function seedContact() {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const { id } = await caller.audience.contacts.add({ email: "ada@example.com" });
    const { id: other } = await caller.audience.contacts.add({ email: "grace@example.com" });
    return { id, other };
  }

  async function post(token: string, init?: RequestInit) {
    const { POST } = await import("@/app/unsubscribe/[token]/route");
    return POST(new Request(`http://localhost/unsubscribe/${token}`, { method: "POST", ...init }), {
      params: Promise.resolve({ token }),
    });
  }

  it("flips only the token's contact and redirects the form post to the done page", async () => {
    const { id, other } = await seedContact();
    const token = makeUnsubscribeToken({ contactId: id, secretKey });

    const res = await post(token);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain(`/unsubscribe/confirm/${token}?done=1`);
    expect((await contactRow(id))?.unsubscribed).toBe(true);
    expect((await contactRow(other))?.unsubscribed).toBe(false);
  });

  it("accepts an RFC 8058 one-click form post with a bare 200", async () => {
    const { id } = await seedContact();
    const token = makeUnsubscribeToken({ contactId: id, secretKey });

    const res = await post(token, {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect((await contactRow(id))?.unsubscribed).toBe(true);
  });

  it("records the unsubscribe on the timeline once, one-click re-hits included", async () => {
    const { id } = await seedContact();
    const token = makeUnsubscribeToken({ contactId: id, secretKey });

    await post(token);
    // Scanner re-hit: state unchanged, so no duplicate timeline row.
    await post(token);

    const rows = await db
      .select()
      .from(schema.contactActivities)
      .where(eq(schema.contactActivities.contactId, id));
    // contact_created comes from contacts.add in seedContact.
    expect(rows.map((r) => r.type).sort()).toEqual(["contact_created", "unsubscribed"]);
  });

  it("404s tampered, malformed, and unknown-contact tokens without flipping anything", async () => {
    const { id } = await seedContact();
    const token = makeUnsubscribeToken({ contactId: id, secretKey });
    const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");

    expect((await post(tampered)).status).toBe(404);
    expect((await post("garbage")).status).toBe(404);
    // Validly signed token for a contact that no longer exists — same 404.
    const caller = callerFor((await db.select().from(schema.teams))[0]?.id ?? "");
    await caller.audience.contacts.delete({ id });
    expect((await post(token)).status).toBe(404);
    expect((await contactRow(id))?.unsubscribed).toBeUndefined();
  });

  it("redirects a browser GET to the hosted confirm page", async () => {
    const { GET } = await import("@/app/unsubscribe/[token]/route");
    const res = await GET(new Request("http://localhost/unsubscribe/tok"), {
      params: Promise.resolve({ token: "tok" }),
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/unsubscribe/confirm/tok");
  });
});

describe("recipient erasure", () => {
  const seedTrail = async (teamId: string, email: string) => {
    const [row] = await db
      .insert(schema.emails)
      .values({ teamId, from: "a@acme.dev", to: [email, "keep@example.com"], subject: "s" })
      .returning({ id: schema.emails.id });
    await db.insert(schema.suppressions).values({
      teamId,
      email,
      emailHash: hashRecipient(email),
      reason: "hard_bounce",
    });
    await db
      .insert(schema.apiRequests)
      .values({ teamId, method: "DELETE", path: `/contacts/${email}`, statusCode: 200 });
    return row?.id ?? "";
  };
  const trailOf = async (emailId: string, teamId: string, email: string) => {
    const [row] = await db
      .select({ to: schema.emails.to })
      .from(schema.emails)
      .where(eq(schema.emails.id, emailId));
    const [suppression] = await db
      .select({ email: schema.suppressions.email })
      .from(schema.suppressions)
      .where(
        and(
          eq(schema.suppressions.teamId, teamId),
          eq(schema.suppressions.emailHash, hashRecipient(email)),
        ),
      );
    const requests = await db.select({ id: schema.apiRequests.id }).from(schema.apiRequests);
    return { to: row?.to, suppressionEmail: suppression?.email, requests: requests.length };
  };

  it("contact delete scrubs the address everywhere but keeps the suppression hash", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const email = "gone@example.com";
    const { id } = await caller.audience.contacts.add({ email });
    const emailId = await seedTrail(teamId, email);

    await caller.audience.contacts.delete({ id });

    expect(await contactRow(id)).toBeNull();
    expect(await trailOf(emailId, teamId, email)).toEqual({
      to: ["[erased]", "keep@example.com"],
      suppressionEmail: null,
      requests: 0,
    });
  });

  it("eraseRecipient is admin-only and works for addresses that were never contacts", async () => {
    const teamId = await createTeam(db, "team-a");
    const email = "never@example.com";
    const emailId = await seedTrail(teamId, email);

    const member = createCaller({
      db,
      session: { user: { id: "u2", email: "u2@example.com", name: "u2" } },
      teamId,
      role: "member",
    });
    await expect(member.audience.eraseRecipient({ email })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    const result = await callerFor(teamId).audience.eraseRecipient({ email: email.toUpperCase() });
    expect(result).toMatchObject({ contact: false, emails: 1, suppressions: 1, apiRequests: 1 });
    expect((await trailOf(emailId, teamId, email)).to).toEqual(["[erased]", "keep@example.com"]);
  });
});

describe("parseCsvContacts", () => {
  it("maps headered files, quoted fields included, and falls back to first-column emails", async () => {
    expect(
      parseCsvContacts(
        "\uFEFF" +
          'email,first_name,last_name\nada@example.com,Ada,"Lovelace, Countess"\nskip-me\n',
      ),
    ).toEqual([{ email: "ada@example.com", firstName: "Ada", lastName: "Lovelace, Countess" }]);
    expect(parseCsvContacts("grace@example.com,ignored\nalan@example.com")).toEqual([
      { email: "grace@example.com" },
      { email: "alan@example.com" },
    ]);
    expect(parseCsvContacts("")).toEqual([]);
  });
});

describe("retained one-click opt-out", () => {
  const suppressionsFor = (teamId: string, email: string) =>
    db
      .select({ reason: schema.suppressions.reason })
      .from(schema.suppressions)
      .where(
        and(
          eq(schema.suppressions.teamId, teamId),
          eq(schema.suppressions.emailHash, hashRecipient(email)),
        ),
      );

  it("survives delete + re-import and clears only on an explicit re-subscribe", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const email = "opted@example.com";
    await db.insert(schema.suppressions).values({
      teamId,
      email,
      emailHash: hashRecipient(email),
      reason: "one_click_unsubscribe",
    });

    await caller.audience.contacts.addMany({ rows: [{ email }] });
    expect(await suppressionsFor(teamId, email)).toHaveLength(1);
    const { id } = await caller.audience.contacts.add({ email: "other@example.com" });
    await caller.audience.contacts.update({ id, unsubscribed: false });
    expect(await suppressionsFor(teamId, email)).toHaveLength(1);

    const [contact] = await db
      .select({ id: schema.contacts.id })
      .from(schema.contacts)
      .where(and(eq(schema.contacts.teamId, teamId), eq(schema.contacts.email, email)));
    if (!contact) throw new Error("imported contact missing");
    await caller.audience.contacts.update({ id: contact.id, unsubscribed: false });
    expect(await suppressionsFor(teamId, email)).toHaveLength(0);
  });

  it("never clears a bounce or complaint suppression", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const email = "bounced@example.com";
    await db.insert(schema.suppressions).values({
      teamId,
      email,
      emailHash: hashRecipient(email),
      reason: "hard_bounce",
    });
    const { id } = await caller.audience.contacts.add({ email });
    await caller.audience.contacts.update({ id, unsubscribed: false });
    expect(await suppressionsFor(teamId, email)).toEqual([{ reason: "hard_bounce" }]);
  });
});
