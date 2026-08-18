import { randomBytes } from "node:crypto";
import { EnvKeyring, generateApiKey } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/app.js";

/**
 * teamId isolation for topics and the topic knobs on contacts/broadcasts: a
 * team must never read, delete, subscribe to, or broadcast against another
 * team's topic.
 */

let db: Db;
let close: () => Promise<void>;
let app: ReturnType<typeof createApi>;
let tokenA: string;
let tokenB: string;
let contactA: string;

async function call(token: string, method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const json = async (res: Response) =>
  (await res.json()) as { id?: string; data?: unknown[] } & Record<string, unknown>;

async function seedTeam(slug: string): Promise<{ token: string; teamId: string }> {
  const teamId = await createTeam(db, slug);
  const key = generateApiKey("live");
  await db.insert(schema.apiKeys).values({
    teamId,
    name: slug,
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
  });
  return { token: key.token, teamId };
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  const a = await seedTeam("topics-a");
  const b = await seedTeam("topics-b");
  tokenA = a.token;
  tokenB = b.token;
  await db.insert(schema.domains).values({
    teamId: a.teamId,
    name: "acme.dev",
    region: "us-east-1",
    status: "verified",
    verifiedAt: new Date(),
  });
  const [contact] = await db
    .insert(schema.contacts)
    .values({ teamId: a.teamId, email: "reader@acme.dev" })
    .returning({ id: schema.contacts.id });
  if (!contact) throw new Error("contact insert failed");
  contactA = contact.id;

  const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
  app = createApi({ db, keyring, isCloud: true, enqueueEmailSend: async () => {} });
});

afterAll(() => close());

describe("topics teamId isolation", () => {
  let topicA: string;

  it("creates a topic scoped to team A", async () => {
    const res = await call(tokenA, "POST", "/topics", {
      name: "News",
      default_subscription: "opt_out",
    });
    expect(res.status).toBe(200);
    topicA = (await json(res)).id ?? "";
    expect(topicA).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("rejects a create without default_subscription", async () => {
    expect((await call(tokenA, "POST", "/topics", { name: "x" })).status).toBe(422);
  });

  it("team B cannot see team A's topic in its list", async () => {
    const res = await call(tokenB, "GET", "/topics");
    expect((await json(res)).data).toEqual([]);
  });

  it("team B cannot GET team A's topic", async () => {
    expect((await call(tokenB, "GET", `/topics/${topicA}`)).status).toBe(404);
  });

  it("team B cannot DELETE team A's topic", async () => {
    expect((await call(tokenB, "DELETE", `/topics/${topicA}`)).status).toBe(404);
    // Still there for team A.
    expect((await call(tokenA, "GET", `/topics/${topicA}`)).status).toBe(200);
  });

  it("PATCH contact-topics rejects a topic the team does not own", async () => {
    // Team B has no such topic; even a valid uuid it does not own is a 404.
    const res = await call(tokenB, "PATCH", `/contacts/${contactA}/topics`, [
      { id: topicA, subscription: "opt_out" },
    ]);
    expect(res.status).toBe(404);
    // No row was written.
    const rows = await db
      .select()
      .from(schema.contactTopicSubscriptions)
      .where(eq(schema.contactTopicSubscriptions.topicId, topicA));
    expect(rows).toHaveLength(0);
  });

  it("PATCH contact-topics writes an override for an owned topic", async () => {
    const res = await call(tokenA, "PATCH", `/contacts/${contactA}/topics`, [
      { id: topicA, subscription: "opt_in" },
    ]);
    expect(res.status).toBe(200);
    expect((await json(res)).id).toBe(contactA);
    const [row] = await db
      .select({ subscribed: schema.contactTopicSubscriptions.subscribed })
      .from(schema.contactTopicSubscriptions)
      .where(
        and(
          eq(schema.contactTopicSubscriptions.contactId, contactA),
          eq(schema.contactTopicSubscriptions.topicId, topicA),
        ),
      );
    expect(row?.subscribed).toBe(true);
  });

  it("broadcast create rejects a topic owned by another team", async () => {
    const res = await call(tokenB, "POST", "/topics", {
      name: "B topic",
      default_subscription: "opt_in",
    });
    const topicB = (await json(res)).id ?? "";
    // Team A referencing team B's topic → 404.
    const created = await call(tokenA, "POST", "/broadcasts", {
      from: "Acme <hi@acme.dev>",
      subject: "s",
      html: "<p>hi</p>",
      topic_id: topicB,
    });
    expect(created.status).toBe(404);
  });

  it("broadcast create+get round-trips an owned topic_id", async () => {
    const created = await call(tokenA, "POST", "/broadcasts", {
      from: "Acme <hi@acme.dev>",
      subject: "s",
      html: "<p>hi</p>",
      topic_id: topicA,
    });
    expect(created.status).toBe(200);
    const id = (await json(created)).id ?? "";
    const got = await call(tokenA, "GET", `/broadcasts/${id}`);
    expect((await json(got)).topic_id).toBe(topicA);
  });

  it("broadcast create with a non-uuid topic_id is a 422", async () => {
    const res = await call(tokenA, "POST", "/broadcasts", {
      from: "Acme <hi@acme.dev>",
      subject: "s",
      html: "<p>hi</p>",
      topic_id: "not-a-uuid",
    });
    expect(res.status).toBe(422);
  });

  it("returns 409 instead of widening a broadcast when its topic is deleted", async () => {
    const res = await call(tokenA, "DELETE", `/topics/${topicA}`);
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ name: "conflict" });
    expect((await call(tokenA, "GET", `/topics/${topicA}`)).status).toBe(200);
  });
});
