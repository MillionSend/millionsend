import { randomBytes } from "node:crypto";
import { type ServerType, serve } from "@hono/node-server";
import { EnvKeyring, generateApiKey } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq } from "drizzle-orm";
import { Resend } from "resend";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/app.js";

/**
 * Wire-compat gate for topics: the official `resend` npm SDK against a live
 * MillionSend API — topics create/list/get/remove and contacts.topics.update.
 */

let db: Db;
let closeDb: () => Promise<void>;
let server: ServerType;
let resend: Resend;
let teamId: string;
let contactId: string;

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
  teamId = await createTeam(db, "topics-contract");
  const key = generateApiKey("test");
  await db.insert(schema.apiKeys).values({
    teamId,
    name: "contract",
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
  });
  const [contact] = await db
    .insert(schema.contacts)
    .values({ teamId, email: "reader@acme.dev" })
    .returning({ id: schema.contacts.id });
  if (!contact) throw new Error("contact insert failed");
  contactId = contact.id;

  const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
  const app = createApi({ db, keyring, isCloud: true, enqueueEmailSend: async () => {} });
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  resend = new Resend(key.token, { baseUrl: `http://127.0.0.1:${address.port}` });
});

afterAll(async () => {
  server.close();
  await closeDb();
});

describe("official resend SDK: topics", () => {
  let topicId: string;

  it("creates a topic", async () => {
    const created = await resend.topics.create({
      name: "Product updates",
      description: "New features and changes",
      defaultSubscription: "opt_in",
    });
    expect(created.error).toBeNull();
    expect(created.data?.id).toMatch(/^[0-9a-f-]{36}$/);
    topicId = created.data?.id ?? "";
  });

  it("gets a topic with its default subscription", async () => {
    const fetched = await resend.topics.get(topicId);
    expect(fetched.error).toBeNull();
    expect(fetched.data).toMatchObject({
      id: topicId,
      name: "Product updates",
      description: "New features and changes",
      default_subscription: "opt_in",
      created_at: expect.any(String),
    });
  });

  it("lists topics", async () => {
    const listed = await resend.topics.list();
    expect(listed.error).toBeNull();
    expect(listed.data?.data).toEqual([
      expect.objectContaining({
        id: topicId,
        name: "Product updates",
        default_subscription: "opt_in",
      }),
    ]);
  });

  it("updates a contact's subscription state to opt_out", async () => {
    const updated = await resend.contacts.topics.update({
      id: contactId,
      topics: [{ id: topicId, subscription: "opt_out" }],
    });
    expect(updated.error).toBeNull();
    expect(updated.data?.id).toBe(contactId);
    const [row] = await db
      .select({ subscribed: schema.contactTopicSubscriptions.subscribed })
      .from(schema.contactTopicSubscriptions)
      .where(
        and(
          eq(schema.contactTopicSubscriptions.contactId, contactId),
          eq(schema.contactTopicSubscriptions.topicId, topicId),
        ),
      );
    expect(row?.subscribed).toBe(false);
  });

  it("flips the same subscription back to opt_in (upsert, no duplicate row)", async () => {
    const updated = await resend.contacts.topics.update({
      id: contactId,
      topics: [{ id: topicId, subscription: "opt_in" }],
    });
    expect(updated.error).toBeNull();
    const rows = await db
      .select()
      .from(schema.contactTopicSubscriptions)
      .where(
        and(
          eq(schema.contactTopicSubscriptions.contactId, contactId),
          eq(schema.contactTopicSubscriptions.topicId, topicId),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.subscribed).toBe(true);
  });

  it("removes a topic", async () => {
    const removed = await resend.topics.remove(topicId);
    expect(removed.error).toBeNull();
    expect(removed.data).toMatchObject({ id: topicId, object: "topic", deleted: true });
    const gone = await resend.topics.get(topicId);
    expect(gone.data).toBeNull();
    expect(gone.error?.name).toBe("not_found");
  });
});
