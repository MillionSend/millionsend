import { deriveUnsubscribeKey, makeUnsubscribeToken } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCaller } from "@/server/routers";

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

async function seedContact(caller: ReturnType<typeof callerFor>, email = "ada@example.com") {
  const { id: audienceId } = await caller.audience.audiences.create({ name: "Newsletter" });
  const { id } = await caller.audience.contacts.add({ audienceId, email });
  return id;
}

async function subscriptionRow(contactId: string, topicId: string) {
  const s = schema.contactTopicSubscriptions;
  const [row] = await db
    .select()
    .from(s)
    .where(and(eq(s.contactId, contactId), eq(s.topicId, topicId)));
  return row ?? null;
}

async function post(token: string, init?: RequestInit) {
  const { POST } = await import("@/app/unsubscribe/[token]/route");
  return POST(new Request(`http://localhost/unsubscribe/${token}`, { method: "POST", ...init }), {
    params: Promise.resolve({ token }),
  });
}

describe("topics CRUD", () => {
  it("creates, lists newest-first, and deletes", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const a = await caller.topics.create({ name: "Product", defaultSubscribed: true });
    const b = await caller.topics.create({
      name: "Digest",
      description: "Weekly",
      defaultSubscribed: false,
    });

    const listed = await caller.topics.list();
    expect(listed.map((t) => t.name)).toEqual(["Digest", "Product"]);
    expect(listed.find((t) => t.id === b.id)).toMatchObject({
      description: "Weekly",
      defaultSubscribed: false,
    });

    await caller.topics.delete({ id: a.id });
    expect((await caller.topics.list()).map((t) => t.id)).toEqual([b.id]);
  });

  it("stores an empty description as null", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const { id } = await caller.topics.create({
      name: "T",
      description: "",
      defaultSubscribed: true,
    });
    expect((await caller.topics.list()).find((t) => t.id === id)?.description).toBeNull();
  });
});

describe("topics tenant isolation", () => {
  it("blocks cross-team list, delete, and contact-topic writes", async () => {
    const teamA = await createTeam(db, "team-a");
    const teamB = await createTeam(db, "team-b");
    const a = callerFor(teamA);
    const b = callerFor(teamB);
    const { id: topicId } = await a.topics.create({ name: "Product", defaultSubscribed: true });
    const contactId = await seedContact(a);

    expect(await b.topics.list()).toEqual([]);
    await expect(b.topics.delete({ id: topicId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // B cannot read A's contact topics nor write a subscription for it.
    await expect(b.audience.contacts.topics({ contactId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      b.audience.contacts.setTopic({ contactId, topicId, subscribed: false }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // A's own contact cannot be pointed at a topic outside its team.
    const { id: foreignTopic } = await b.topics.create({ name: "Other", defaultSubscribed: true });
    await expect(
      a.audience.contacts.setTopic({ contactId, topicId: foreignTopic, subscribed: false }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("contact topic effective state", () => {
  it("falls back to the topic default, and an override wins", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const optIn = await caller.topics.create({ name: "In", defaultSubscribed: true });
    const optOut = await caller.topics.create({ name: "Out", defaultSubscribed: false });
    const contactId = await seedContact(caller);

    // No rows yet: effective state is each topic's default.
    const before = await caller.audience.contacts.topics({ contactId });
    expect(before.find((t) => t.id === optIn.id)?.subscribed).toBe(true);
    expect(before.find((t) => t.id === optOut.id)?.subscribed).toBe(false);

    // Override both directions; upsert twice on the second to prove idempotency.
    await caller.audience.contacts.setTopic({ contactId, topicId: optIn.id, subscribed: false });
    await caller.audience.contacts.setTopic({ contactId, topicId: optOut.id, subscribed: true });
    await caller.audience.contacts.setTopic({ contactId, topicId: optOut.id, subscribed: true });

    const after = await caller.audience.contacts.topics({ contactId });
    expect(after.find((t) => t.id === optIn.id)?.subscribed).toBe(false);
    expect(after.find((t) => t.id === optOut.id)?.subscribed).toBe(true);
  });
});

describe("topic-scoped unsubscribe route", () => {
  const secretKey = deriveUnsubscribeKey(Buffer.from(TEST_KEK, "base64"));

  it("flips only the token's topic subscription, leaving global and siblings untouched", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const topic = await caller.topics.create({ name: "Product", defaultSubscribed: true });
    const other = await caller.topics.create({ name: "Digest", defaultSubscribed: true });
    const contactId = await seedContact(caller);
    const token = makeUnsubscribeToken({ contactId, topicId: topic.id, secretKey });

    const res = await post(token);
    expect(res.status).toBe(303);
    expect((await subscriptionRow(contactId, topic.id))?.subscribed).toBe(false);
    // Global flag and the sibling topic are untouched — no row, still default.
    const [c] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId));
    expect(c?.unsubscribed).toBe(false);
    expect(await subscriptionRow(contactId, other.id)).toBeNull();
  });

  it("keeps global unsubscribe topic-free", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const topic = await caller.topics.create({ name: "Product", defaultSubscribed: true });
    const contactId = await seedContact(caller);
    const token = makeUnsubscribeToken({ contactId, secretKey });

    await post(token);
    const [c] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId));
    expect(c?.unsubscribed).toBe(true);
    expect(await subscriptionRow(contactId, topic.id)).toBeNull();
  });

  it("accepts a topic-scoped one-click form post with a bare 200", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const topic = await caller.topics.create({ name: "Product", defaultSubscribed: true });
    const contactId = await seedContact(caller);
    const token = makeUnsubscribeToken({ contactId, topicId: topic.id, secretKey });

    const res = await post(token, {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect((await subscriptionRow(contactId, topic.id))?.subscribed).toBe(false);
  });

  it("404s a token whose topic belongs to another team, changing nothing", async () => {
    const teamA = await createTeam(db, "team-a");
    const teamB = await createTeam(db, "team-b");
    const a = callerFor(teamA);
    const b = callerFor(teamB);
    const contactId = await seedContact(a);
    const { id: foreignTopic } = await b.topics.create({ name: "Other", defaultSubscribed: true });
    const token = makeUnsubscribeToken({ contactId, topicId: foreignTopic, secretKey });

    expect((await post(token)).status).toBe(404);
    expect(await subscriptionRow(contactId, foreignTopic)).toBeNull();
  });
});
