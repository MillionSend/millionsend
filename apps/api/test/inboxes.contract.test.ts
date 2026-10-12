import { randomBytes } from "node:crypto";
import { type ServerType, serve } from "@hono/node-server";
import { deriveInboxKeys, EnvKeyring, generateApiKey } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { Resend } from "resend-inboxes";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/app.js";

/**
 * Wire-compat gate for inboxes: Resend's preview SDK (the build that has
 * inboxes) against a live MillionSend API. The SDK parses nothing, so each
 * call is judged by the data it hands back.
 */

let db: Db;
let closeDb: () => Promise<void>;
let server: ServerType;
let resend: Resend;
let teamId: string;

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
  teamId = await createTeam(db, "inbox-contract");
  await db.update(schema.teams).set({ plan: "pro" });
  await db.insert(schema.domains).values({
    teamId,
    name: "in.acme.dev",
    region: "us-east-1",
    status: "verified",
    receivingEnabled: true,
  });
  const key = generateApiKey();
  await db.insert(schema.apiKeys).values({
    teamId,
    name: "contract",
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
  });
  const app = createApi({
    db,
    keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
    isCloud: true,
    enqueueEmailSend: async () => {},
    receiving: { mxHost: "mx.millionsend.test", ingestSecret: "c".repeat(40) },
    inboxKeys: deriveInboxKeys(randomBytes(32)),
  });
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  resend = new Resend(key.token, { baseUrl: `http://127.0.0.1:${address.port}` });
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await closeDb();
});

describe("resend preview SDK: inboxes", () => {
  it("creates, reads, lists, updates and removes inboxes", async () => {
    const created = await resend.inboxes.create({
      emailAddress: "support@in.acme.dev",
      name: "Support",
      fromName: "Acme Support",
    });
    expect(created.error).toBeNull();
    const id = created.data?.id as string;
    expect(created.data).toMatchObject({ object: "inbox", id });

    const got = await resend.inboxes.get("Support@in.acme.dev");
    expect(got.error).toBeNull();
    expect(got.data).toMatchObject({
      object: "inbox",
      id,
      name: "Support",
      email_address: "support@in.acme.dev",
      receiving_address: null,
      from_name: "Acme Support",
      unread: 0,
      drafts: 0,
      last_received: null,
    });

    const list = await resend.inboxes.list({ limit: 10 });
    expect(list.error).toBeNull();
    expect(list.data).toMatchObject({ object: "list", has_more: false });
    expect(list.data?.data.map((i) => i.id)).toContain(id);

    const updated = await resend.inboxes.update(id, { name: "Help desk", fromName: "Acme Help" });
    expect(updated.error).toBeNull();
    expect(updated.data).toMatchObject({ object: "inbox", id });
    expect((await resend.inboxes.get(id)).data).toMatchObject({
      name: "Help desk",
      from_name: "Acme Help",
    });

    const removed = await resend.inboxes.remove(id);
    expect(removed.data).toEqual({ object: "inbox", id, deleted: true });
    const missing = await resend.inboxes.get(id);
    expect(missing.error).toMatchObject({ name: "not_found", message: "Inbox not found." });
  });

  it("works labels, threads and thread emails", async () => {
    const inbox = await resend.inboxes.create({ emailAddress: "threads@in.acme.dev" });
    const inboxId = inbox.data?.id as string;
    const [thread] = await db
      .insert(schema.inboxThreads)
      .values({ teamId, inboxId, subject: "Invoice question" })
      .returning({ id: schema.inboxThreads.id });
    const threadId = thread?.id as string;
    const [received] = await db
      .insert(schema.receivedEmails)
      .values({
        teamId,
        domainIds: [],
        rawSha256: "a".repeat(64),
        messageId: "<q@sender.dev>",
        from: "ana@sender.dev",
        fromName: "Ana Souza",
        to: ["threads@in.acme.dev"],
        receivedFor: ["threads@in.acme.dev"],
        subject: "Invoice question",
        envelope: { mailFrom: "ana@sender.dev", clientIp: "192.0.2.1", helo: "h", tls: null },
        authentication: { spf: "pass", dkim: "pass", dmarc: "pass", arc: "none" },
        sizeBytes: 1,
        catchAll: false,
      })
      .returning({ id: schema.receivedEmails.id });
    const emailId = received?.id as string;
    await db.insert(schema.receivedEmailInboxes).values({
      receivedEmailId: emailId,
      inboxId,
      teamId,
      threadId,
      address: "threads@in.acme.dev",
      senderTrust: "external",
      verdict: "clean",
      deliveredAt: new Date(),
    });

    const label = await resend.inboxes.labels.create({
      inboxId,
      name: "Billing",
      color: "#e93d82",
    });
    expect(label.error).toBeNull();
    expect(label.data).toMatchObject({ object: "inbox_label", color: "#E93D82" });
    const labelId = label.data?.id as string;
    const labels = await resend.inboxes.labels.list({ inboxId });
    expect(labels.data).toEqual({
      object: "list",
      data: [{ id: labelId, name: "Billing", color: "#E93D82", created_at: expect.any(String) }],
    });
    const renamed = await resend.inboxes.labels.update({ inboxId, labelId, name: "Bills" });
    expect(renamed.data).toMatchObject({ object: "inbox_label", id: labelId });

    const threads = await resend.inboxes.threads.list({ inboxId, folders: ["inbox"], read: false });
    expect(threads.error).toBeNull();
    expect(threads.data?.data).toEqual([
      expect.objectContaining({
        id: threadId,
        subject: "Invoice question",
        from: "Ana Souza <ana@sender.dev>",
        message_count: 1,
        read: false,
        folder: "inbox",
      }),
    ]);
    const searched = await resend.inboxes.threads.search({
      inboxId,
      query: "invoice",
      from: ["ana"],
    });
    expect(searched.data?.data[0]).toMatchObject({
      id: threadId,
      matched_email_id: emailId,
      highlights: { subject: ["**Invoice** question"] },
    });
    const updated = await resend.inboxes.threads.update({
      inboxId,
      threadId,
      read: true,
      folder: "archive",
      labelId,
    });
    expect(updated.data).toEqual({
      object: "inbox_thread",
      id: threadId,
      subject: "Invoice question",
      folder: "archive",
      labels: [{ id: labelId, name: "Bills", color: "#E93D82" }],
      read: true,
      quarantined: 0,
    });
    expect((await resend.inboxes.threads.get({ inboxId, threadId })).data).toMatchObject({
      folder: "archive",
    });

    const emails = await resend.inboxes.threads.emails.list({ inboxId, threadId, limit: 5 });
    expect(emails.error).toBeNull();
    expect(emails.data).toMatchObject({ object: "list", has_more: false });
    expect(emails.data?.data[0]).toMatchObject({
      id: emailId,
      direction: "inbound",
      from: "Ana Souza <ana@sender.dev>",
      to: ["threads@in.acme.dev"],
      read: true,
    });
    const email = await resend.inboxes.threads.emails.get({ inboxId, threadId, emailId });
    expect(email.data).toMatchObject({ id: emailId, subject: "Invoice question" });

    const trashed = await resend.inboxes.threads.remove({ inboxId, threadId });
    expect(trashed.data).toEqual({ object: "inbox_thread", id: threadId, deleted: true });
    const removedLabel = await resend.inboxes.labels.remove({ inboxId, labelId });
    expect(removedLabel.data).toEqual({ object: "inbox_label", id: labelId, deleted: true });
  });

  it("creates, reads, lists, updates, sends and removes drafts", async () => {
    const inbox = await resend.inboxes.create({ emailAddress: "drafts@in.acme.dev" });
    const inboxId = inbox.data?.id as string;

    const created = await resend.inboxes.drafts.create({
      inboxId,
      to: "ana@sender.dev",
      subject: "Hello",
      html: "<p>Hi Ana</p>",
      text: "Hi Ana",
    });
    expect(created.error).toBeNull();
    const draftId = created.data?.id as string;
    expect(created.data).toMatchObject({ object: "inbox_draft", id: draftId });

    const got = await resend.inboxes.drafts.get({ inboxId, draftId });
    expect(got.data).toMatchObject({
      object: "inbox_draft",
      id: draftId,
      type: "standalone",
      to: ["ana@sender.dev"],
      subject: "Hello",
      html: "<p>Hi Ana</p>",
      text: "Hi Ana",
      thread_id: null,
      email_id: null,
    });

    const list = await resend.inboxes.drafts.list({ inboxId });
    expect(list.data).toMatchObject({ object: "list", has_more: false });
    expect(list.data?.data.map((d) => d.id)).toEqual([draftId]);

    // Setting one body part replaces both: the part left out becomes null.
    const updated = await resend.inboxes.drafts.update({ inboxId, draftId, text: "Hi again" });
    expect(updated.data).toMatchObject({ id: draftId, text: "Hi again", html: null });

    const sent = await resend.inboxes.drafts.send({ inboxId, draftId });
    expect(sent.error).toBeNull();
    expect(sent.data).toMatchObject({ object: "inbox_draft", id: draftId });
    expect(sent.data?.email_id).toEqual(expect.any(String));
    expect(sent.data?.thread_id).toEqual(expect.any(String));
    expect((await resend.inboxes.drafts.list({ inboxId })).data?.data).toEqual([]);

    const spare = await resend.inboxes.drafts.create({ inboxId, subject: "Later" });
    const spareId = spare.data?.id as string;
    const removed = await resend.inboxes.drafts.remove({ inboxId, draftId: spareId });
    expect(removed.data).toEqual({ object: "inbox_draft", id: spareId, deleted: true });
  });
});
