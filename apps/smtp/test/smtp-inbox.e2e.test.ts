import type { AddressInfo } from "node:net";
import { generateApiKey, utcDay } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import nodemailer, { type SendMailOptions } from "nodemailer";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  addInbox,
  addThread,
  type InboxRow,
  receive,
  seedWorld,
  type World,
} from "../../../packages/core/test/inbox-send-fixtures.js";
import { createSmtpServer, SMTP_USERNAME } from "../src/smtp.js";

// A fixed thread summary for the event snapshots keeps these tests on the relay.
vi.mock("../../../packages/core/src/inboxes/threads.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../packages/core/src/inboxes/threads.js")>()),
  getThread: vi.fn(async (_db: unknown, p: { threadId: string }) => ({
    object: "inbox_thread",
    id: p.threadId,
    subject: "Question",
    folder: "inbox",
    labels: [],
    read: true,
    quarantined: 0,
  })),
}));

let db: Db;
let closeDb: () => Promise<void>;
let w: World;
let server: ReturnType<typeof createSmtpServer>;
let port: number;
let teamKey: string;
let inbox: InboxRow;
let inboxKey: string;

async function addKey(values: Partial<typeof schema.apiKeys.$inferInsert> = {}) {
  const key = generateApiKey();
  await db.insert(schema.apiKeys).values({
    teamId: w.teamId,
    name: "smtp",
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
    ...values,
  });
  return key.token;
}

const send = (pass: string, message: SendMailOptions) =>
  nodemailer
    .createTransport({
      host: "127.0.0.1",
      port,
      secure: false,
      ignoreTLS: true,
      auth: { user: SMTP_USERNAME, pass },
    })
    .sendMail(message);

const failure = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("expected the relay to refuse");
    },
    (err: { responseCode?: number; response?: string }) => ({
      code: err.responseCode,
      response: err.response ?? "",
    }),
  );

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
  w = await seedWorld(db, "smtp");
  teamKey = await addKey();
  inbox = await addInbox(w, { local: "agent" });
  inboxKey = await addKey({ inboxId: inbox.id });
  server = createSmtpServer({ ...w.deps, allowInsecureAuth: true });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(resolve));
  await closeDb();
});

const emailOf = async (response: string | undefined) => {
  const id = /Queued as (\S+)/.exec(response ?? "")?.[1] ?? "";
  const [row] = await db.select().from(schema.emails).where(eq(schema.emails.id, id));
  if (!row) throw new Error("no email row");
  return row;
};

describe("smtp relay and inboxes", () => {
  it("holds an inbox-scoped key to its inbox's address (550 5.7.1)", async () => {
    const refused = await failure(
      send(inboxKey, {
        from: `plain@${w.domain}`,
        to: "a@example.org",
        subject: "Hi",
        text: "Hello",
      }),
    );
    expect(refused).toMatchObject({ code: 550 });
    expect(refused.response).toContain("5.7.1 This API key can only send from its inbox address");
  });

  it("runs the inbox's rules: a new conversation from an agent inbox is refused (550 5.7.1)", async () => {
    const refused = await failure(
      send(inboxKey, {
        from: inbox.emailAddress,
        to: "stranger@example.org",
        subject: "Hi",
        text: "x",
      }),
    );
    expect(refused).toMatchObject({ code: 550 });
    expect(refused.response).toContain(
      "5.7.1 The sending inbox's rules hold this email (send_policy)",
    );
  });

  it("passes In-Reply-To and References on, so a reply threads into its inbox thread", async () => {
    const threadId = await addThread(w, inbox.id);
    const received = await receive(w, { inbox, threadId });
    const info = await send(inboxKey, {
      from: inbox.emailAddress,
      to: "ada@sender.example",
      subject: "Re: Question",
      text: "Thanks",
      inReplyTo: received.messageId,
      references: ["<older@sender.example>", received.messageId],
    });
    const row = await emailOf(info.response);
    expect(row).toMatchObject({ inboxId: inbox.id, threadId });
    expect(row.headers?.["In-Reply-To"]).toBe(received.messageId);
    expect(row.headers?.References).toContain(`<older@sender.example> ${received.messageId}`);
    expect(row.headers?.["Auto-Submitted"]).toBe("auto-replied");

    const plain = await send(teamKey, {
      from: `plain@${w.domain}`,
      to: "a@example.org",
      subject: "Re: x",
      text: "x",
      inReplyTo: "<parent@example.org>",
    });
    expect((await emailOf(plain.response)).headers).toEqual({
      "In-Reply-To": "<parent@example.org>",
    });
  });

  it("refuses threading headers the shared header rules refuse (554)", async () => {
    const refused = await failure(
      send(teamKey, {
        envelope: { from: `plain@${w.domain}`, to: ["a@example.org"] },
        raw: [
          `From: plain@${w.domain}`,
          "To: a@example.org",
          "Subject: x",
          "References: <a\u0001b@example.org>",
          "",
          "body",
        ].join("\r\n"),
      }),
    );
    expect(refused).toMatchObject({ code: 554 });
    expect(refused.response).toContain("must not contain control characters");
  });

  it("answers 452 4.3.1 when the inbox's daily cap is spent", async () => {
    const capped = await addInbox(w, { local: "capped", safety: { send_cap: 1 } });
    await db
      .insert(schema.inboxUsageDaily)
      .values({ inboxId: capped.id, day: utcDay(), recipients: 1 });
    const threadId = await addThread(w, capped.id);
    const received = await receive(w, { inbox: capped, threadId });
    const refused = await failure(
      send(teamKey, {
        from: capped.emailAddress,
        to: "ada@sender.example",
        subject: "Re: Question",
        text: "x",
        inReplyTo: received.messageId,
      }),
    );
    expect(refused).toMatchObject({ code: 452 });
    expect(refused.response).toContain("4.3.1 Daily send limit for this inbox reached");
  });
});
