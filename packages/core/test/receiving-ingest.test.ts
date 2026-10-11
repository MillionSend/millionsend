import { randomBytes } from "node:crypto";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb, createWebhookEndpoint } from "@millionsend/test-utils";
import { and, eq, inArray } from "drizzle-orm";
import { createTransport } from "nodemailer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EnvKeyring } from "../src/crypto/keyring.js";
import { type IngestDeps, ingestReceivedEmail } from "../src/receiving/ingest.js";
import {
  openReceivedAttachments,
  openReceivedRaw,
  RECEIVED_EMAIL_META_COLUMNS,
  receivedEmailListItem,
} from "../src/receiving/message.js";
import type { DeliverEnvelope } from "../src/receiving/protocol.js";
import { utcDay } from "../src/utc-day.js";
import type { QueuedWebhookDelivery } from "../src/webhooks.js";

let db: Db;
let close: () => Promise<void>;
let acme: string;
let beta: string;
let acmeHook: string;
let betaHook: string;
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
const NOW = new Date("2026-10-11T15:00:00Z");
const transport = createTransport({ streamTransport: true, buffer: true });
const enqueued: QueuedWebhookDelivery[] = [];

const deps = (overrides: Partial<IngestDeps> = {}): IngestDeps => ({
  db,
  keyring,
  isCloud: false,
  now: () => NOW,
  enqueueWebhookDeliveries: async (rows) => {
    enqueued.push(...rows);
  },
  ...overrides,
});

const envelope = (recipients: string[], overrides: Partial<DeliverEnvelope> = {}) =>
  ({
    mailFrom: "bounces@sender.example",
    recipients,
    clientIp: "192.0.2.10",
    helo: "mail.sender.example",
    tls: { protocol: "TLSv1.3", cipher: "TLS_AES_256_GCM_SHA384" },
    auth: { spf: "pass", dkim: "pass", dmarc: "pass", arc: "none" },
    receivedAt: NOW.toISOString(),
    ...overrides,
  }) satisfies DeliverEnvelope;

async function message(subject: string): Promise<Buffer> {
  const info = await transport.sendMail({
    from: "Sender <sender@sender.example>",
    to: "agent@inbound.acme.test",
    subject,
    text: `Body of ${subject}`,
    attachments: [{ filename: "a.txt", content: "attached" }],
  });
  return info.message as Buffer;
}

async function addDomain(teamId: string, name: string, receiving = true): Promise<string> {
  const [row] = await db
    .insert(schema.domains)
    .values({ teamId, name, region: "us-east-1", status: "verified", receivingEnabled: receiving })
    .returning({ id: schema.domains.id });
  if (!row) throw new Error("domain insert failed");
  return row.id;
}

const rowsOf = (teamId: string) =>
  db.select().from(schema.receivedEmails).where(eq(schema.receivedEmails.teamId, teamId));

const deliveriesFor = (endpointId: string) =>
  db
    .select()
    .from(schema.webhookDeliveries)
    .where(eq(schema.webhookDeliveries.endpointId, endpointId));

const receivedToday = async (teamId: string) => {
  const [row] = await db
    .select({ received: schema.usageCounters.received, accepted: schema.usageCounters.accepted })
    .from(schema.usageCounters)
    .where(and(eq(schema.usageCounters.teamId, teamId), eq(schema.usageCounters.day, utcDay(NOW))));
  return row ?? { received: 0, accepted: 0 };
};

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  acme = await createTeam(db, "ingest-acme");
  beta = await createTeam(db, "ingest-beta");
  await addDomain(acme, "inbound.acme.test");
  await addDomain(acme, "second.acme.test");
  await addDomain(beta, "mail.beta.test");
  await addDomain(beta, "off.beta.test", false);
  acmeHook = await createWebhookEndpoint(db, acme, null);
  betaHook = await createWebhookEndpoint(db, beta, ["email.received"]);
});
afterAll(() => close());

describe("ingestReceivedEmail", () => {
  let raw: Buffer;

  it("stores one row per team, each holding only that team's envelope recipients", async () => {
    raw = await message("Split");
    const result = await ingestReceivedEmail(deps(), {
      raw,
      envelope: envelope([
        "agent@INBOUND.acme.test",
        "secret-bcc@mail.beta.test",
        "x@off.beta.test",
        "y@unknown.test",
      ]),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stored.map((s) => s.duplicate)).toEqual([false, false]);

    const [acmeRow] = await rowsOf(acme);
    const [betaRow] = await rowsOf(beta);
    if (!acmeRow || !betaRow) throw new Error("rows missing");
    expect(acmeRow.receivedFor).toEqual(["agent@inbound.acme.test"]);
    expect(betaRow.receivedFor).toEqual(["secret-bcc@mail.beta.test"]);
    // SECURITY: nothing in Acme's row names Beta's BCC recipient. Acme's
    // address may show in Beta's row only through the public To header.
    expect(JSON.stringify(acmeRow)).not.toContain("secret-bcc");
    expect(JSON.stringify({ ...betaRow, to: [] })).not.toContain("agent@inbound");
    expect(acmeRow).toMatchObject({
      from: "sender@sender.example",
      to: ["agent@inbound.acme.test"],
      subject: "Split",
      sizeBytes: raw.length,
      attachmentCount: 1,
      contentPurgedAt: null,
      envelope: {
        mailFrom: "bounces@sender.example",
        clientIp: "192.0.2.10",
        helo: "mail.sender.example",
        tls: { protocol: "TLSv1.3", cipher: "TLS_AES_256_GCM_SHA384" },
      },
      authentication: { spf: "pass", dkim: "pass", dmarc: "pass", arc: "none" },
    });
    expect(acmeRow.messageId).toMatch(/^<.+>$/);
    expect((await openReceivedRaw(acmeRow, keyring))?.equals(raw)).toBe(true);
    expect((await openReceivedAttachments(betaRow, keyring)).map((a) => a.filename)).toEqual([
      "a.txt",
    ]);
    // Each team's copy is sealed under its own binding.
    await expect(openReceivedRaw({ ...acmeRow, id: betaRow.id }, keyring)).rejects.toThrow();

    expect(await receivedToday(acme)).toEqual({ received: 1, accepted: 0 });
    expect(await receivedToday(beta)).toEqual({ received: 1, accepted: 0 });

    const [acmeDelivery] = await deliveriesFor(acmeHook);
    const [betaDelivery] = await deliveriesFor(betaHook);
    expect(acmeDelivery?.eventType).toBe("email.received");
    expect(acmeDelivery?.payload).toEqual({
      type: "email.received",
      created_at: acmeRow.createdAt.toISOString(),
      data: {
        email_id: acmeRow.id,
        created_at: acmeRow.createdAt.toISOString(),
        from: "sender@sender.example",
        to: ["agent@inbound.acme.test"],
        bcc: [],
        cc: [],
        received_for: ["agent@inbound.acme.test"],
        message_id: acmeRow.messageId,
        subject: "Split",
        attachments: [
          {
            id: expect.any(String),
            filename: "a.txt",
            content_type: "text/plain",
            content_disposition: "attachment",
            content_id: null,
          },
        ],
      },
    });
    expect(betaDelivery?.payload).toMatchObject({
      data: { received_for: ["secret-bcc@mail.beta.test"] },
    });
    // Handed to the queue only after the rows committed.
    expect(enqueued.map((d) => d.endpointId).sort()).toEqual([acmeHook, betaHook].sort());
  });

  it("lists from the metadata columns alone, never loading the sealed raw message", async () => {
    const [meta] = await db
      .select(RECEIVED_EMAIL_META_COLUMNS)
      .from(schema.receivedEmails)
      .where(eq(schema.receivedEmails.teamId, acme));
    if (!meta) throw new Error("row missing");
    expect(meta).not.toHaveProperty("rawCiphertext");
    const item = await receivedEmailListItem(meta, keyring);
    expect(item.received_for).toEqual(["agent@inbound.acme.test"]);
    expect(item.attachments.map((a) => a.filename)).toEqual(["a.txt"]);
  });

  it("is idempotent on (team, raw sha256): a retry stores, counts and emits nothing new", async () => {
    const before = enqueued.length;
    const result = await ingestReceivedEmail(deps(), {
      raw,
      envelope: envelope(["agent@inbound.acme.test", "secret-bcc@mail.beta.test"]),
    });
    expect(result.ok && result.stored.map((s) => s.duplicate)).toEqual([true, true]);
    expect(await rowsOf(acme)).toHaveLength(1);
    expect(await receivedToday(acme)).toEqual({ received: 1, accepted: 0 });
    expect(await deliveriesFor(acmeHook)).toHaveLength(1);
    expect(enqueued.length).toBe(before);
  });

  it("merges recipients the same message reaches in another transaction and announces only them", async () => {
    const before = enqueued.length;
    const result = await ingestReceivedEmail(deps(), {
      raw,
      envelope: envelope(["agent@inbound.acme.test", "other@second.acme.test"]),
    });
    expect(result.ok && result.stored[0]?.duplicate).toBe(true);
    const [row] = await rowsOf(acme);
    expect(row?.receivedFor).toEqual(["agent@inbound.acme.test", "other@second.acme.test"]);
    expect(row?.domainIds).toHaveLength(2);
    expect(await receivedToday(acme)).toEqual({ received: 1, accepted: 0 });
    // Webhook consumers hear of the new address once, under the same email id.
    const hooks = await deliveriesFor(acmeHook);
    expect(hooks).toHaveLength(2);
    const second = hooks.find((h) => JSON.stringify(h.payload).includes("other@second"));
    expect(second?.payload).toMatchObject({
      type: "email.received",
      data: {
        email_id: row?.id,
        received_for: ["other@second.acme.test"],
        attachments: [{ filename: "a.txt" }],
      },
    });
    expect(enqueued.length).toBe(before + 1);
    // Retrying that delivery announces nothing more.
    await ingestReceivedEmail(deps(), { raw, envelope: envelope(["other@second.acme.test"]) });
    expect(await deliveriesFor(acmeHook)).toHaveLength(2);
  });

  it("stores malformed MIME with minimal metadata", async () => {
    const garbage = Buffer.from([0, 1, 2, 3, 255, 13, 10, 13, 10, 7, 7]);
    const result = await ingestReceivedEmail(deps(), {
      raw: garbage,
      envelope: envelope(["agent@inbound.acme.test"], { mailFrom: "" }),
    });
    expect(result.ok).toBe(true);
    const id = result.ok ? result.stored[0]?.id : undefined;
    const [row] = await db
      .select()
      .from(schema.receivedEmails)
      .where(eq(schema.receivedEmails.id, id ?? ""));
    expect(row).toMatchObject({ from: "", subject: "", to: [], attachmentCount: 0 });
    expect(row?.messageId).toBe(`<${id}@received.invalid>`);
    expect(row && (await openReceivedRaw(row, keyring))?.equals(garbage)).toBe(true);
  });

  it("refuses permanently when no recipient receives here, storing nothing", async () => {
    const suspendedTeam = await createTeam(db, "ingest-suspended");
    await db
      .update(schema.teams)
      .set({ suspendedAt: NOW, suspensionReason: "manual" })
      .where(eq(schema.teams.id, suspendedTeam));
    await addDomain(suspendedTeam, "in.suspended.test");
    const raw2 = await message("Nobody");
    expect(
      await ingestReceivedEmail(deps(), {
        raw: raw2,
        envelope: envelope(["a@unknown.test", "b@off.beta.test"]),
      }),
    ).toEqual({
      ok: false,
      code: 554,
      enhanced: "5.1.1",
      message: expect.any(String),
    });
    expect(
      await ingestReceivedEmail(deps(), { raw: raw2, envelope: envelope(["a@in.suspended.test"]) }),
    ).toMatchObject({ ok: false, code: 554, enhanced: "5.7.1" });
    expect(await rowsOf(suspendedTeam)).toHaveLength(0);
  });

  it("refuses a message over 40 MiB", async () => {
    const result = await ingestReceivedEmail(deps(), {
      raw: Buffer.alloc(40 * 1024 * 1024 + 1),
      envelope: envelope(["agent@inbound.acme.test"]),
    });
    expect(result).toMatchObject({ ok: false, code: 552, enhanced: "5.3.4" });
  });

  it("answers 452 when a team's allowance is spent, and the retry stores it once there is room", async () => {
    const free = await createTeam(db, "ingest-free");
    await addDomain(free, "in.free.test");
    await db.insert(schema.usageCounters).values({ teamId: free, day: utcDay(NOW), accepted: 150 });
    const raw3 = await message("Quota");
    const both = envelope(["a@in.free.test", "b@mail.beta.test"]);
    const refused = await ingestReceivedEmail(deps({ isCloud: true }), {
      raw: raw3,
      envelope: both,
    });
    expect(refused).toMatchObject({ ok: false, code: 452, enhanced: "4.2.2" });
    // The team with room was stored; the refused team got nothing at all.
    expect(await rowsOf(free)).toHaveLength(0);
    expect(await receivedToday(free)).toEqual({ received: 0, accepted: 150 });
    const betaRows = (await rowsOf(beta)).filter((r) => r.subject === "Quota");
    expect(betaRows).toHaveLength(1);

    await db
      .update(schema.usageCounters)
      .set({ accepted: 10 })
      .where(eq(schema.usageCounters.teamId, free));
    const retried = await ingestReceivedEmail(deps({ isCloud: true }), {
      raw: raw3,
      envelope: both,
    });
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    const byTeam = Object.fromEntries(retried.stored.map((s) => [s.teamId, s.duplicate]));
    expect(byTeam).toEqual({ [free]: false, [beta]: true });
    // Free shares the day's cap with sending: the message spent `accepted` too.
    expect(await receivedToday(free)).toEqual({ received: 1, accepted: 11 });
  });

  it("keeps the stored rows when the queue hand-off fails after commit", async () => {
    const raw4 = await message("Queue down");
    const result = await ingestReceivedEmail(
      deps({
        enqueueWebhookDeliveries: async () => {
          throw new Error("queue down");
        },
      }),
      { raw: raw4, envelope: envelope(["agent@inbound.acme.test"]) },
    );
    expect(result.ok).toBe(true);
    const ids = result.ok ? result.stored.map((s) => s.id) : [];
    const rows = await db
      .select({ id: schema.receivedEmails.id })
      .from(schema.receivedEmails)
      .where(inArray(schema.receivedEmails.id, ids));
    expect(rows).toHaveLength(1);
  });
});
