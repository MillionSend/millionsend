import { deriveUnsubscribeKey, makeUnsubscribeToken } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
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

describe("audience.audiences", () => {
  it("lists audiences with contact and unsubscribed counts", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const { id } = await caller.audience.audiences.create({ name: "Newsletter" });
    const empty = await caller.audience.audiences.create({ name: "Empty" });

    await caller.audience.contacts.add({ audienceId: id, email: "a@example.com" });
    const { id: unsubbed } = await caller.audience.contacts.add({
      audienceId: id,
      email: "b@example.com",
    });
    await caller.audience.contacts.update({ id: unsubbed, unsubscribed: true });

    const listed = await caller.audience.audiences.list();
    expect(listed.find((a) => a.id === id)).toMatchObject({
      name: "Newsletter",
      contacts: 2,
      unsubscribed: 1,
    });
    expect(listed.find((a) => a.id === empty.id)).toMatchObject({ contacts: 0, unsubscribed: 0 });

    // get carries the same counts for the stat strip.
    expect(await caller.audience.audiences.get({ id })).toMatchObject({
      name: "Newsletter",
      contacts: 2,
      unsubscribed: 1,
    });
  });

  it("delete cascades the audience's contacts", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const { id } = await caller.audience.audiences.create({ name: "Newsletter" });
    const { id: contactId } = await caller.audience.contacts.add({
      audienceId: id,
      email: "a@example.com",
    });

    await caller.audience.audiences.delete({ id });
    expect(await contactRow(contactId)).toBeNull();
  });
});

describe("tenant isolation", () => {
  it("blocks every cross-team read and write", async () => {
    const teamA = await createTeam(db, "team-a");
    const teamB = await createTeam(db, "team-b");
    const a = callerFor(teamA);
    const { id: audienceId } = await a.audience.audiences.create({ name: "Newsletter" });
    const { id: contactId } = await a.audience.contacts.add({
      audienceId,
      email: "a@example.com",
    });

    const b = callerFor(teamB);
    await expect(b.audience.audiences.get({ id: audienceId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(b.audience.audiences.delete({ id: audienceId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(b.audience.contacts.list({ audienceId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      b.audience.contacts.add({ audienceId, email: "intruder@example.com" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      b.audience.contacts.addMany({ audienceId, rows: [{ email: "intruder@example.com" }] }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
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
    expect(await b.audience.audiences.list()).toEqual([]);
    expect((await contactRow(contactId))?.unsubscribed).toBe(false);
  });
});

describe("audience.contacts.add", () => {
  it("rejects a duplicate address case-insensitively", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const { id: audienceId } = await caller.audience.audiences.create({ name: "Newsletter" });
    await caller.audience.contacts.add({ audienceId, email: "Ada@example.com" });
    await expect(
      caller.audience.contacts.add({ audienceId, email: "ada@EXAMPLE.com" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("stores optional names, trimmed empty as null", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const { id: audienceId } = await caller.audience.audiences.create({ name: "Newsletter" });
    const { id } = await caller.audience.contacts.add({
      audienceId,
      email: "ada@example.com",
      firstName: "Ada",
      lastName: "",
    });
    expect(await contactRow(id)).toMatchObject({ firstName: "Ada", lastName: null });
  });

  it("persists custom properties and returns them from get", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const { id: audienceId } = await caller.audience.audiences.create({ name: "Newsletter" });
    const { id } = await caller.audience.contacts.add({
      audienceId,
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
    const { id: audienceId } = await caller.audience.audiences.create({ name: "Newsletter" });
    const { id } = await caller.audience.contacts.add({ audienceId, email: "ada@example.com" });
    expect((await contactRow(id))?.properties).toEqual({});
    expect((await caller.audience.contacts.get({ id })).properties).toEqual({});
  });
});

describe("audience.contacts.addMany", () => {
  it("dedupes against the batch and the audience, skipping invalid rows", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const { id: audienceId } = await caller.audience.audiences.create({ name: "Newsletter" });
    await caller.audience.contacts.add({ audienceId, email: "existing@example.com" });

    const result = await caller.audience.contacts.addMany({
      audienceId,
      rows: [
        { email: "new1@example.com", firstName: "One" },
        { email: "NEW1@example.com" }, // batch-internal dupe (case-insensitive)
        { email: "Existing@example.com" }, // already in the audience
        { email: "not-an-email" }, // invalid
        { email: "new2@example.com" },
      ],
    });
    expect(result).toEqual({ created: 2, skipped: 3 });

    // Re-running the same batch creates nothing.
    const rerun = await caller.audience.contacts.addMany({
      audienceId,
      rows: [{ email: "new1@example.com" }, { email: "new2@example.com" }],
    });
    expect(rerun).toEqual({ created: 0, skipped: 2 });
    expect((await caller.audience.audiences.get({ id: audienceId })).contacts).toBe(3);
  });

  it("survives a concurrent import racing the same address", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const { id: audienceId } = await caller.audience.audiences.create({ name: "Newsletter" });

    // Both imports carry the same address (plus an in-batch dupe); neither
    // may 500 on the unique index — the loser counts it as skipped.
    const [a, b] = await Promise.all([
      caller.audience.contacts.addMany({
        audienceId,
        rows: [{ email: "raced@example.com" }, { email: "RACED@example.com" }],
      }),
      caller.audience.contacts.addMany({
        audienceId,
        rows: [{ email: "Raced@example.com" }],
      }),
    ]);
    expect(a.created + b.created).toBe(1);
    expect(a.created + a.skipped).toBe(2);
    expect(b.created + b.skipped).toBe(1);
    expect((await caller.audience.audiences.get({ id: audienceId })).contacts).toBe(1);
  });

  it("caps a batch at 1000 rows", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const { id: audienceId } = await caller.audience.audiences.create({ name: "Newsletter" });
    const rows = Array.from({ length: 1001 }, (_, i) => ({ email: `u${i}@example.com` }));
    await expect(caller.audience.contacts.addMany({ audienceId, rows })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });
});

describe("audience.contacts.list", () => {
  it("searches email and names, and pages by keyset cursor", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const { id: audienceId } = await caller.audience.audiences.create({ name: "Newsletter" });
    await caller.audience.contacts.addMany({
      audienceId,
      rows: [
        { email: "ada@example.com", firstName: "Ada", lastName: "Lovelace" },
        { email: "grace@example.com", firstName: "Grace" },
        { email: "alan@example.com" },
      ],
    });

    const byName = await caller.audience.contacts.list({ audienceId, search: "lovelace" });
    expect(byName.items.map((c) => c.email)).toEqual(["ada@example.com"]);
    expect(byName.total).toBe(1);

    const page1 = await caller.audience.contacts.list({ audienceId, limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.total).toBe(3);
    expect(page1.nextCursor).not.toBeNull();
    if (!page1.nextCursor) throw new Error("expected a next cursor");
    const page2 = await caller.audience.contacts.list({
      audienceId,
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
    const { id: audienceId } = await caller.audience.audiences.create({ name: "Newsletter" });
    await caller.audience.contacts.addMany({
      audienceId,
      rows: [{ email: "ada@x.com" }, { email: "bob@x.com" }, { email: "cyd@y.com" }],
    });
    const { id: segmentId } = await caller.segments.create({
      audienceId,
      name: "X domain",
      filter: { match: "all", conditions: [{ field: "email", op: "ends_with", value: "@x.com" }] },
    });

    const scoped = await caller.audience.contacts.list({ audienceId, segmentId });
    expect(scoped.items.map((c) => c.email).sort()).toEqual(["ada@x.com", "bob@x.com"]);
    // The list scope equals the segment's live membership count.
    expect(scoped.total).toBe((await caller.segments.get({ id: segmentId })).count);

    // The segment filter survives paging by keyset cursor.
    const page1 = await caller.audience.contacts.list({ audienceId, segmentId, limit: 1 });
    expect(page1.items).toHaveLength(1);
    expect(page1.total).toBe(2);
    if (!page1.nextCursor) throw new Error("expected a next cursor");
    const page2 = await caller.audience.contacts.list({
      audienceId,
      segmentId,
      limit: 1,
      cursor: page1.nextCursor,
    });
    const emails = [...page1.items, ...page2.items].map((c) => c.email).sort();
    expect(emails).toEqual(["ada@x.com", "bob@x.com"]);
  });

  it("narrows to a topic by effective membership (default plus explicit overrides)", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const { id: audienceId } = await caller.audience.audiences.create({ name: "Newsletter" });
    const { id: ada } = await caller.audience.contacts.add({ audienceId, email: "ada@x.com" });
    const { id: bob } = await caller.audience.contacts.add({ audienceId, email: "bob@x.com" });

    // Opt-in topic: everyone subscribed by default; bob opts out.
    const { id: optIn } = await caller.topics.create({ name: "News", defaultSubscribed: true });
    await caller.audience.contacts.setTopic({ contactId: bob, topicId: optIn, subscribed: false });
    expect(
      (await caller.audience.contacts.list({ audienceId, topicId: optIn })).items.map(
        (c) => c.email,
      ),
    ).toEqual(["ada@x.com"]);

    // Opt-out topic: nobody subscribed by default; ada opts in.
    const { id: optOut } = await caller.topics.create({ name: "Beta", defaultSubscribed: false });
    await caller.audience.contacts.setTopic({ contactId: ada, topicId: optOut, subscribed: true });
    const optOutList = await caller.audience.contacts.list({ audienceId, topicId: optOut });
    expect(optOutList.items.map((c) => c.email)).toEqual(["ada@x.com"]);
    expect(optOutList.total).toBe(1);
  });

  it("rejects a foreign segment/topic and a wrong-audience segment", async () => {
    const teamA = await createTeam(db, "team-a");
    const teamB = await createTeam(db, "team-b");
    const a = callerFor(teamA);
    const b = callerFor(teamB);
    const { id: aAudience } = await a.audience.audiences.create({ name: "A's" });
    const { id: aSegment } = await a.segments.create({
      audienceId: aAudience,
      name: "seg",
      filter: { match: "all", conditions: [] },
    });
    const { id: aTopic } = await a.topics.create({ name: "T", defaultSubscribed: true });

    const { id: bAudience } = await b.audience.audiences.create({ name: "B's" });
    // B cannot borrow A's segment or topic to filter B's own audience.
    await expect(
      b.audience.contacts.list({ audienceId: bAudience, segmentId: aSegment }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      b.audience.contacts.list({ audienceId: bAudience, topicId: aTopic }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // A same-team segment aimed at the wrong audience is a BAD_REQUEST.
    const { id: aOther } = await a.audience.audiences.create({ name: "A other" });
    await expect(
      a.audience.contacts.list({ audienceId: aOther, segmentId: aSegment }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("audience.audiences.rename", () => {
  it("renames within the team and 404s across teams", async () => {
    const teamA = await createTeam(db, "team-a");
    const teamB = await createTeam(db, "team-b");
    const a = callerFor(teamA);
    const b = callerFor(teamB);
    const { id } = await a.audience.audiences.create({ name: "Old" });

    await a.audience.audiences.rename({ id, name: "New" });
    expect((await a.audience.audiences.get({ id })).name).toBe("New");

    await expect(b.audience.audiences.rename({ id, name: "Hijack" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect((await a.audience.audiences.get({ id })).name).toBe("New");
  });
});

describe("audience.contacts.update", () => {
  it("flips subscription state and clears names with empty strings", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const { id: audienceId } = await caller.audience.audiences.create({ name: "Newsletter" });
    const { id } = await caller.audience.contacts.add({
      audienceId,
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
    const { id: audienceId } = await caller.audience.audiences.create({ name: "Newsletter" });
    const { id } = await caller.audience.contacts.add({
      audienceId,
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
    const { id: audienceId } = await caller.audience.audiences.create({ name: "Newsletter" });
    await caller.audience.contacts.add({
      audienceId,
      email: "ada@example.com",
      properties: { plan: "pro", city: "London" },
    });
    await caller.audience.contacts.add({
      audienceId,
      email: "grace@example.com",
      properties: { plan: "free" },
    });
    // A contact with no properties at all: counts toward the coverage
    // denominator but contributes no key.
    await caller.audience.contacts.add({ audienceId, email: "alan@example.com" });

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
    const { id: audienceId } = await caller.audience.audiences.create({ name: "Newsletter" });
    await caller.audience.contacts.add({
      audienceId,
      email: "ada@example.com",
      properties: { plan: "pro", note: "" },
    });
    await caller.audience.contacts.add({
      audienceId,
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
    const { id: audienceId } = await caller.audience.audiences.create({ name: "Newsletter" });
    await caller.audience.contacts.add({ audienceId, email: "ada@example.com" });
    expect(await caller.audience.properties.list()).toEqual([]);
  });

  it("never surfaces another team's properties", async () => {
    const teamA = await createTeam(db, "team-a");
    const teamB = await createTeam(db, "team-b");
    const a = callerFor(teamA);
    const b = callerFor(teamB);
    const { id: aAudience } = await a.audience.audiences.create({ name: "A's" });
    await a.audience.contacts.add({
      audienceId: aAudience,
      email: "ada@example.com",
      properties: { secret: "A-only" },
    });
    const { id: bAudience } = await b.audience.audiences.create({ name: "B's" });
    await b.audience.contacts.add({
      audienceId: bAudience,
      email: "bob@example.com",
      properties: { plan: "pro" },
    });

    expect((await b.audience.properties.list()).map((p) => p.key)).toEqual(["plan"]);
    expect((await a.audience.properties.list()).map((p) => p.key)).toEqual(["secret"]);
  });

  it("returns a hostile property key as data, never executing it", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const { id: audienceId } = await caller.audience.audiences.create({ name: "Newsletter" });
    const hostile = `x")-- drop`;
    await caller.audience.contacts.add({
      audienceId,
      email: "ada@example.com",
      properties: { [hostile]: "harmless" },
    });

    const props = await caller.audience.properties.list();
    expect(props.map((p) => p.key)).toEqual([hostile]);
    expect(props[0]?.sampleValue).toBe("harmless");
    // The contact survives — nothing was dropped or truncated.
    expect((await caller.audience.audiences.get({ id: audienceId })).contacts).toBe(1);
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
    const { id: audienceId } = await caller.audience.audiences.create({ name: "Newsletter" });
    await caller.audience.properties.define({ key: "plan" });
    await caller.audience.contacts.add({
      audienceId,
      email: "ada@example.com",
      properties: { plan: "pro" },
    });
    await caller.audience.contacts.add({ audienceId, email: "alan@example.com" });

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
    const { id: audienceId } = await caller.audience.audiences.create({ name: "Newsletter" });
    const { id } = await caller.audience.contacts.add({ audienceId, email: "ada@example.com" });
    const { id: other } = await caller.audience.contacts.add({
      audienceId,
      email: "grace@example.com",
    });
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
