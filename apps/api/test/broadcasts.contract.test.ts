import { randomBytes } from "node:crypto";
import { type ServerType, serve } from "@hono/node-server";
import { EnvKeyring, generateApiKey } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { Resend } from "resend";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/app.js";

/**
 * Wire-compat gate for broadcasts: the official `resend` npm SDK against a
 * live MillionSend API — create/list/get/update/send/cancel/remove, plus the
 * draft-only rules after a send.
 */

let db: Db;
let closeDb: () => Promise<void>;
let server: ServerType;
let resend: Resend;
let audienceId: string;
const enqueued: { broadcastId: string; startAfter?: Date | undefined }[] = [];

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
  const teamId = await createTeam(db, "bc-contract");
  const key = generateApiKey("test");
  await db.insert(schema.apiKeys).values({
    teamId,
    name: "contract",
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
  });
  await db.insert(schema.domains).values({
    teamId,
    name: "acme.dev",
    region: "us-east-1",
    status: "verified",
    verifiedAt: new Date(),
  });
  const [audience] = await db
    .insert(schema.audiences)
    .values({ teamId, name: "newsletter" })
    .returning({ id: schema.audiences.id });
  if (!audience) throw new Error("audience insert failed");
  audienceId = audience.id;

  const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
  const app = createApi({
    db,
    keyring,
    isCloud: true,
    enqueueEmailSend: async () => {},
    enqueueBroadcastSend: async (broadcastId, opts) => {
      enqueued.push({ broadcastId, startAfter: opts?.startAfter });
    },
  });
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

describe("official resend SDK: broadcasts", () => {
  let broadcastId: string;

  it("creates a broadcast as a draft", async () => {
    const created = await resend.broadcasts.create({
      audienceId,
      name: "launch",
      from: "Acme <hello@acme.dev>",
      subject: "We launched",
      html: '<p>Hi!</p><a href="{{{UNSUBSCRIBE_URL}}}">Unsubscribe</a>',
      replyTo: "support@acme.dev",
    });
    expect(created.error).toBeNull();
    expect(created.data?.id).toMatch(/^[0-9a-f-]{36}$/);
    broadcastId = created.data?.id ?? "";
  });

  it("lists broadcasts", async () => {
    const listed = await resend.broadcasts.list();
    expect(listed.error).toBeNull();
    expect(listed.data?.data).toEqual([
      {
        id: broadcastId,
        name: "launch",
        audience_id: audienceId,
        segment_id: audienceId,
        status: "draft",
        created_at: expect.any(String),
        scheduled_at: null,
        sent_at: null,
      },
    ]);
  });

  it("gets a broadcast with its full content", async () => {
    const fetched = await resend.broadcasts.get(broadcastId);
    expect(fetched.error).toBeNull();
    expect(fetched.data).toMatchObject({
      object: "broadcast",
      id: broadcastId,
      name: "launch",
      audience_id: audienceId,
      from: "Acme <hello@acme.dev>",
      subject: "We launched",
      reply_to: ["support@acme.dev"],
      html: expect.stringContaining("{{{UNSUBSCRIBE_URL}}}"),
      text: null,
      status: "draft",
      scheduled_at: null,
      sent_at: null,
    });
  });

  it("updates a draft", async () => {
    const updated = await resend.broadcasts.update(broadcastId, { subject: "We really launched" });
    expect(updated.error).toBeNull();
    expect(updated.data?.id).toBe(broadcastId);
    const fetched = await resend.broadcasts.get(broadcastId);
    expect(fetched.data?.subject).toBe("We really launched");
  });

  it("rejects a natural-language scheduled_at", async () => {
    const sent = await resend.broadcasts.send(broadcastId, { scheduledAt: "in 2 days" });
    expect(sent.data).toBeNull();
    expect(sent.error?.name).toBe("validation_error");
  });

  it("sends with an ISO scheduled_at and enqueues the fan-out", async () => {
    const at = new Date(Date.now() + 60_000).toISOString();
    const sent = await resend.broadcasts.send(broadcastId, { scheduledAt: at });
    expect(sent.error).toBeNull();
    expect(sent.data?.id).toBe(broadcastId);
    expect(enqueued).toEqual([{ broadcastId, startAfter: new Date(at) }]);

    const fetched = await resend.broadcasts.get(broadcastId);
    expect(fetched.data).toMatchObject({ status: "scheduled", scheduled_at: at });
  });

  it("update after send is a 4xx, like Resend", async () => {
    const updated = await resend.broadcasts.update(broadcastId, { subject: "too late" });
    expect(updated.data).toBeNull();
    expect(updated.error?.statusCode).toBe(400);
  });

  it("remove after send is a 4xx", async () => {
    const removed = await resend.broadcasts.remove(broadcastId);
    expect(removed.data).toBeNull();
    expect(removed.error?.statusCode).toBe(400);
  });

  it("cancels a scheduled broadcast", async () => {
    const canceled = await resend.broadcasts.cancel(broadcastId);
    expect(canceled.error).toBeNull();
    expect(canceled.data).toMatchObject({ object: "broadcast", id: broadcastId });
    const fetched = await resend.broadcasts.get(broadcastId);
    expect(fetched.data?.status).toBe("canceled");
  });

  it("removes a draft, then get 404s", async () => {
    const draft = await resend.broadcasts.create({
      audienceId,
      from: "Acme <hello@acme.dev>",
      subject: "never sent",
      text: "bye",
    });
    expect(draft.error).toBeNull();
    const id = draft.data?.id ?? "";
    const removed = await resend.broadcasts.remove(id);
    expect(removed.error).toBeNull();
    expect(removed.data).toMatchObject({ id, deleted: true });

    const gone = await resend.broadcasts.get(id);
    expect(gone.data).toBeNull();
    expect(gone.error?.name).toBe("not_found");
  });
});
