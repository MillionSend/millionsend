import { randomBytes } from "node:crypto";
import { EnvKeyring, generateApiKey } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/app.js";

let db: Db;
let close: () => Promise<void>;
let app: ReturnType<typeof createApi>;
let teamId: string;
let token: string;
/** defaultSubscribed: true — contacts and strangers get mail unless opted out. */
let optInTopicId: string;
/** defaultSubscribed: false — only explicit opt-ins get mail. */
let optOutTopicId: string;
/** Belongs to another team. */
let foreignTopicId: string;
const enqueued: string[] = [];

const OPTED_OUT = "opted-out@example.com";
const MEMBER = "member@example.com";
const OPTED_IN = "opted-in@example.com";

async function post(path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function get(path: string) {
  return app.request(path, { headers: { authorization: `Bearer ${token}` } });
}

const base = { from: "Acme <a@acme.dev>", subject: "s", text: "t" };

async function emailRow(id: string) {
  const [row] = await db.select().from(schema.emails).where(eq(schema.emails.id, id));
  return row;
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "topic-send-team");
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

  const topics = await db
    .insert(schema.topics)
    .values([
      { teamId, name: "News", defaultSubscribed: true },
      { teamId, name: "Beta", defaultSubscribed: false },
    ])
    .returning({ id: schema.topics.id });
  optInTopicId = topics[0]?.id ?? "";
  optOutTopicId = topics[1]?.id ?? "";
  const otherTeam = await createTeam(db, "other-topic-team");
  const [foreign] = await db
    .insert(schema.topics)
    .values({ teamId: otherTeam, name: "Foreign", defaultSubscribed: true })
    .returning({ id: schema.topics.id });
  foreignTopicId = foreign?.id ?? "";

  const contacts = await db
    .insert(schema.contacts)
    .values([
      { teamId, email: OPTED_OUT },
      { teamId, email: MEMBER },
      { teamId, email: OPTED_IN },
    ])
    .returning({ id: schema.contacts.id, email: schema.contacts.email });
  const idOf = (email: string) => contacts.find((c) => c.email === email)?.id ?? "";
  await db.insert(schema.contactTopicSubscriptions).values([
    { contactId: idOf(OPTED_OUT), topicId: optInTopicId, subscribed: false },
    { contactId: idOf(OPTED_IN), topicId: optOutTopicId, subscribed: true },
  ]);

  app = createApi({
    db,
    keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
    isCloud: false,
    enqueueEmailSend: async (emailId) => {
      enqueued.push(emailId);
    },
  });
});
afterAll(() => close());

describe("topic_id validation", () => {
  it("404s POST /emails with another team's topic", async () => {
    const res = await post("/emails", { ...base, to: ["x@example.com"], topic_id: foreignTopicId });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ statusCode: 404, name: "not_found" });
  });

  it("404s the whole batch when an item names a foreign topic, accepting nothing", async () => {
    const before = enqueued.length;
    const res = await post("/emails/batch", [
      { ...base, to: ["ok@example.com"] },
      { ...base, to: ["y@example.com"], topic_id: foreignTopicId },
    ]);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      name: "not_found",
      message: expect.stringMatching(/emails\.1/),
    });
    expect(enqueued.length).toBe(before);
  });

  it("422s a non-uuid topic_id at the schema boundary", async () => {
    const res = await post("/emails", { ...base, to: ["x@example.com"], topic_id: "t_1" });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ name: "validation_error" });
  });
});

describe("topic opt-out suppression at accept", () => {
  it("persists topic_id and sends to a non-contact on an opt-in-default topic", async () => {
    const res = await post("/emails", {
      ...base,
      to: ["stranger@example.com"],
      topic_id: optInTopicId,
    });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    const row = await emailRow(id);
    expect(row?.topicId).toBe(optInTopicId);
    expect(row?.to).toEqual(["stranger@example.com"]);
    expect(enqueued).toContain(id);
  });

  it("GET /contacts/{id}/topics lists every topic with the effective choice and whether it was explicit", async () => {
    const res = await get(`/contacts/${encodeURIComponent(OPTED_OUT)}/topics`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      object: string;
      has_more: boolean;
      data: Array<{ id: string; name: string; subscription: string; explicit: boolean }>;
    };
    expect(body).toMatchObject({ object: "list", has_more: false });
    const byId = new Map(body.data.map((t) => [t.id, t]));
    // Explicitly opted out of the opt-in topic; the opt-out topic falls to its default.
    expect(byId.get(optInTopicId)).toMatchObject({ subscription: "opt_out", explicit: true });
    expect(byId.get(optOutTopicId)).toMatchObject({ subscription: "opt_out", explicit: false });
    const member = (await (await get(`/contacts/${encodeURIComponent(MEMBER)}/topics`)).json()) as {
      data: Array<{ id: string; subscription: string; explicit: boolean }>;
    };
    expect(member.data.find((t) => t.id === optInTopicId)).toMatchObject({
      subscription: "opt_in",
      explicit: false,
    });
    expect((await get("/contacts/nobody@example.com/topics")).status).toBe(404);
  });

  it("422s when every `to` recipient explicitly opted out", async () => {
    const res = await post("/emails", { ...base, to: [OPTED_OUT], topic_id: optInTopicId });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      name: "all_recipients_suppressed",
      message: "All recipients are suppressed",
    });
  });

  it("partial drop keeps sending to the remaining recipients", async () => {
    const res = await post("/emails", {
      ...base,
      to: [OPTED_OUT, MEMBER],
      cc: [OPTED_OUT],
      topic_id: optInTopicId,
    });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    const row = await emailRow(id);
    expect(row?.to).toEqual([MEMBER]);
    expect(row?.cc).toBeNull();
  });

  it("non-contact recipients follow an opt-out default: nobody left is a 422", async () => {
    const res = await post("/emails", {
      ...base,
      to: ["never-opted-in@example.com"],
      topic_id: optOutTopicId,
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ message: "All recipients are suppressed" });
  });

  it("an explicit opt-in overrides an opt-out default", async () => {
    const res = await post("/emails", { ...base, to: [OPTED_IN], topic_id: optOutTopicId });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    expect((await emailRow(id))?.to).toEqual([OPTED_IN]);
  });

  it("a display-name recipient still matches its contact's opt-out", async () => {
    const res = await post("/emails", {
      ...base,
      to: [`Opty <${OPTED_OUT}>`],
      topic_id: optInTopicId,
    });
    expect(res.status).toBe(422);
  });

  it("fails the whole batch when one item is all opted-out, accepting nothing", async () => {
    const before = enqueued.length;
    const countBefore = (await db.select({ id: schema.emails.id }).from(schema.emails)).length;
    const res = await post("/emails/batch", [
      { ...base, to: ["fine@example.com"], topic_id: optInTopicId },
      { ...base, to: [OPTED_OUT], topic_id: optInTopicId },
    ]);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      name: "all_recipients_suppressed",
      message: expect.stringMatching(/emails\.1: All recipients are suppressed/),
    });
    expect(enqueued.length).toBe(before);
    const countAfter = (await db.select({ id: schema.emails.id }).from(schema.emails)).length;
    expect(countAfter).toBe(countBefore);
  });

  it("batch accepts and persists topic_id when recipients remain", async () => {
    const res = await post("/emails/batch", [
      { ...base, to: [OPTED_OUT, MEMBER], topic_id: optInTopicId },
      { ...base, to: ["plain@example.com"] },
    ]);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { id: string }[] };
    expect(data).toHaveLength(2);
    const first = await emailRow(data[0]?.id ?? "");
    expect(first?.topicId).toBe(optInTopicId);
    expect(first?.to).toEqual([MEMBER]);
    const second = await emailRow(data[1]?.id ?? "");
    expect(second?.topicId).toBeNull();
  });
});
