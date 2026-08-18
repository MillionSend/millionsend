import { randomBytes } from "node:crypto";
import {
  EnvKeyring,
  encryptEmailBody,
  encryptWebhookSecret,
  generateWebhookSecret,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import type { SerializedSesEvent } from "@millionsend/queue";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { reconcileWebhookDeliveries } from "../src/handlers/cron.js";
import { processSesEvent } from "../src/handlers/process-ses-event.js";
import { sendEmail } from "../src/handlers/send-email.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;
let otherTeamId: string;
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "hooks-team");
  otherTeamId = await createTeam(db, "other-team");
});
afterAll(() => close());

async function insertEndpoint(
  ownerTeamId: string,
  events: string[] | null,
  secret = generateWebhookSecret(),
): Promise<string> {
  const encrypted = await encryptWebhookSecret(secret, keyring);
  const [row] = await db
    .insert(schema.webhookEndpoints)
    .values({
      teamId: ownerTeamId,
      url: "https://receiver.example.com/hook",
      secretCiphertext: encrypted.ciphertext,
      secretIv: encrypted.iv,
      secretWrappedDek: encrypted.wrappedDek,
      secretKeyVersion: encrypted.keyVersion,
      secretLast4: secret.slice(-4),
      events,
    })
    .returning({ id: schema.webhookEndpoints.id });
  if (!row) throw new Error("endpoint insert failed");
  return row.id;
}

async function insertSentEmail(sesMessageId: string): Promise<string> {
  const [row] = await db
    .insert(schema.emails)
    .values({
      teamId,
      from: "a@acme.dev",
      to: ["r@example.com"],
      subject: "s",
      latestStatus: "sent",
      sesMessageId,
      sentAt: new Date(),
    })
    .returning({ id: schema.emails.id });
  if (!row) throw new Error("email insert failed");
  return row.id;
}

async function deliveriesFor(endpointIds: string[]) {
  return db
    .select()
    .from(schema.webhookDeliveries)
    .where(inArray(schema.webhookDeliveries.endpointId, endpointIds));
}

it("SES event fans out only to matching endpoints of the owning team", async () => {
  const allEvents = await insertEndpoint(teamId, null);
  const bounceOnly = await insertEndpoint(teamId, ["email.bounced"]);
  const disabled = await insertEndpoint(teamId, null);
  await db
    .update(schema.webhookEndpoints)
    .set({ status: "disabled" })
    .where(eq(schema.webhookEndpoints.id, disabled));
  const foreign = await insertEndpoint(otherTeamId, null);

  const emailId = await insertSentEmail("wh-mid-1");
  const enqueued: string[] = [];
  const event: SerializedSesEvent = {
    eventType: "Delivery",
    sesMessageId: "wh-mid-1",
    occurredAt: "2026-08-14T12:00:00.000Z",
    data: { eventType: "Delivery" },
  };
  await processSesEvent(db, event, {
    snsMessageId: "sns-wh-1",
    enqueueWebhookDelivery: async (id) => {
      enqueued.push(id);
    },
  });

  const rows = await deliveriesFor([allEvents, bounceOnly, disabled, foreign]);
  expect(rows).toHaveLength(1);
  const delivery = rows[0];
  if (!delivery) throw new Error("no delivery");
  expect(delivery.endpointId).toBe(allEvents);
  expect(delivery.emailId).toBe(emailId);
  expect(delivery.eventType).toBe("email.delivered");
  expect(delivery.messageId).toMatch(/^msg_/);
  expect(delivery.payload).toMatchObject({
    type: "email.delivered",
    data: { email_id: emailId, from: "a@acme.dev", to: ["r@example.com"], subject: "s" },
  });
  expect(enqueued).toEqual([delivery.id]);

  // SNS redelivery of the same MessageId creates no second delivery.
  await processSesEvent(db, event, {
    snsMessageId: "sns-wh-1",
    enqueueWebhookDelivery: async (id) => {
      enqueued.push(id);
    },
  });
  expect(await deliveriesFor([allEvents])).toHaveLength(1);
  expect(enqueued).toHaveLength(1);
});

it("bounce events carry bounce extras and reach type-subscribed endpoints", async () => {
  const bounceOnly = await insertEndpoint(teamId, ["email.bounced"]);
  await insertSentEmail("wh-mid-2");
  await processSesEvent(
    db,
    {
      eventType: "Bounce",
      sesMessageId: "wh-mid-2",
      occurredAt: "2026-08-14T12:00:00.000Z",
      bounce: {
        bounceType: "Permanent",
        bounceSubType: "General",
        recipients: ["r@example.com"],
        diagnosticCode: "550",
      },
      data: { eventType: "Bounce" },
    },
    { snsMessageId: "sns-wh-2", enqueueWebhookDelivery: async () => {} },
  );

  const rows = await deliveriesFor([bounceOnly]);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.payload).toMatchObject({
    type: "email.bounced",
    data: { bounce: { type: "Permanent", sub_type: "General", diagnostic_code: "550" } },
  });
});

it("send path fans out email.sent after the claim", async () => {
  // Fresh team: endpoints created by other tests must not receive this event.
  const sendTeamId = await createTeam(db, "send-hooks-team");
  const endpointId = await insertEndpoint(sendTeamId, ["email.sent"]);
  const [domain] = await db
    .insert(schema.domains)
    .values({
      teamId: sendTeamId,
      name: "acme.dev",
      region: "us-east-1",
      status: "verified",
      verifiedAt: new Date(),
    })
    .returning({ id: schema.domains.id });
  if (!domain) throw new Error("domain insert failed");
  const body = await encryptEmailBody({ html: null, text: "hi" }, keyring);
  const [email] = await db
    .insert(schema.emails)
    .values({
      teamId: sendTeamId,
      domainId: domain.id,
      from: "a@acme.dev",
      to: ["r@example.com"],
      subject: "s",
      latestStatus: "queued",
      bodyCiphertext: body.ciphertext,
      bodyIv: body.iv,
      bodyWrappedDek: body.wrappedDek,
      bodyKeyVersion: body.keyVersion,
    })
    .returning({ id: schema.emails.id });
  if (!email) throw new Error("email insert failed");

  const enqueued: string[] = [];
  const outcome = await sendEmail(
    db,
    {
      keyring,
      ses: { sendRaw: async () => ({ messageId: `wh-sent-${email.id}` }) },
      enqueueWebhookDelivery: async (id) => {
        enqueued.push(id);
      },
    },
    { emailId: email.id },
  );
  expect(outcome).toBe("sent");

  const rows = await deliveriesFor([endpointId]);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.eventType).toBe("email.sent");
  expect(rows[0]?.payload).toMatchObject({ type: "email.sent", data: { email_id: email.id } });
  expect(enqueued).toEqual([rows[0]?.id]);
});

it("endpoint row stores no plaintext secret", async () => {
  const secret = generateWebhookSecret();
  const endpointId = await insertEndpoint(teamId, null, secret);
  const [row] = await db
    .select()
    .from(schema.webhookEndpoints)
    .where(eq(schema.webhookEndpoints.id, endpointId));
  if (!row) throw new Error("endpoint missing");
  const secretBytes = Buffer.from(secret, "utf8");
  expect(Buffer.from(row.secretCiphertext).includes(secretBytes)).toBe(false);
  expect(Buffer.from(row.secretWrappedDek).includes(secretBytes)).toBe(false);
  expect(row.secretLast4).toBe(secret.slice(-4));
  expect(row.secretLast4.length).toBeLessThan(8);
});

it("reconcile sweep re-enqueues only well-overdue deliveries", async () => {
  const endpointId = await insertEndpoint(teamId, null);
  const old = new Date(Date.now() - 60 * 60 * 1000);
  const values = (
    overrides: Partial<typeof schema.webhookDeliveries.$inferInsert>,
  ): typeof schema.webhookDeliveries.$inferInsert => ({
    endpointId,
    messageId: `msg_${randomBytes(8).toString("hex")}`,
    eventType: "email.delivered",
    payload: {},
    ...overrides,
  });
  const inserted = await db
    .insert(schema.webhookDeliveries)
    .values([
      values({ status: "pending", createdAt: old }),
      values({ status: "failed", nextAttemptAt: old }),
      values({ status: "pending" }), // fresh — a live job owns it
      values({ status: "failed", nextAttemptAt: new Date(Date.now() + 60_000) }), // not due
      values({ status: "exhausted", createdAt: old }),
    ])
    .returning({ id: schema.webhookDeliveries.id });

  const enqueued: string[] = [];
  const count = await reconcileWebhookDeliveries(db, {
    enqueue: async (id) => {
      enqueued.push(id);
    },
  });
  expect(count).toBe(2);
  expect(new Set(enqueued)).toEqual(new Set([inserted[0]?.id, inserted[1]?.id]));
});
