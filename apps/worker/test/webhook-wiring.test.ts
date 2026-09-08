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

async function insertSentEmail(sesMessageId: string, ownerTeamId = teamId): Promise<string> {
  const [row] = await db
    .insert(schema.emails)
    .values({
      teamId: ownerTeamId,
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
    enqueueWebhookDelivery: async (rows) => {
      enqueued.push(...rows.map((r) => r.id));
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
    enqueueWebhookDelivery: async (rows) => {
      enqueued.push(...rows.map((r) => r.id));
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
      enqueueWebhookDelivery: async (rows) => {
        enqueued.push(...rows.map((r) => r.id));
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

it("fan-out hands every written row to the seam, one call per insert slice", async () => {
  const fanTeamId = await createTeam(db, "fanout-team");
  const a = await insertEndpoint(fanTeamId, null);
  const b = await insertEndpoint(fanTeamId, null);
  await insertSentEmail("wh-mid-fan", fanTeamId);
  const calls: { id: string; endpointId: string }[][] = [];
  await processSesEvent(
    db,
    {
      eventType: "Delivery",
      sesMessageId: "wh-mid-fan",
      occurredAt: "2026-08-14T12:00:00.000Z",
      data: { eventType: "Delivery" },
    },
    {
      snsMessageId: "sns-wh-fan",
      enqueueWebhookDelivery: async (rows) => {
        calls.push(rows.map((r) => ({ id: r.id, endpointId: r.endpointId })));
      },
    },
  );
  expect(calls).toHaveLength(1);
  expect(new Set(calls[0]?.map((r) => r.endpointId))).toEqual(new Set([a, b]));
  // A freshly written row is due at once: the drain's clock is set on insert.
  const rows = await deliveriesFor([a, b]);
  expect(rows).toHaveLength(2);
  for (const row of rows) expect(row.nextAttemptAt).toBeInstanceOf(Date);
});

it("reconcile sweep arms one drain per endpoint with rows nobody claimed, and expires day-old rows", async () => {
  const now = new Date();
  const stale = new Date(now.getTime() - 60 * 60 * 1000);
  const quiet = await insertEndpoint(teamId, null);
  const stuck = await insertEndpoint(teamId, null);
  const alsoStuck = await insertEndpoint(teamId, null);
  const values = (
    endpointId: string,
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
      // quiet: a live drain owns these (due just now / parked on the ladder).
      values(quiet, { status: "pending", nextAttemptAt: now }),
      values(quiet, { status: "failed", nextAttemptAt: new Date(now.getTime() + 60_000) }),
      values(quiet, { status: "exhausted", createdAt: stale }),
      // stuck: several stale rows still arm a single drain.
      values(stuck, { status: "pending", nextAttemptAt: stale }),
      values(stuck, { status: "failed", nextAttemptAt: stale }),
      values(stuck, { status: "pending", nextAttemptAt: now }),
      values(alsoStuck, { status: "failed", nextAttemptAt: stale }),
      // a day-old open row is exhausted before anything is armed.
      values(alsoStuck, {
        status: "pending",
        nextAttemptAt: stale,
        createdAt: new Date(now.getTime() - 25 * 60 * 60 * 1000),
      }),
    ])
    .returning({
      id: schema.webhookDeliveries.id,
      endpointId: schema.webhookDeliveries.endpointId,
    });

  const enqueued: { id: string; endpointId: string }[] = [];
  const count = await reconcileWebhookDeliveries(db, {
    now,
    enqueue: async (rows) => {
      enqueued.push(...rows.map((r) => ({ id: r.id, endpointId: r.endpointId })));
    },
  });
  expect(count).toBe(2);
  expect(enqueued.map((r) => r.endpointId).sort()).toEqual([stuck, alsoStuck].sort());
  // Each id is a real open row of that endpoint, so the seam derives the endpoint from it.
  for (const row of enqueued) {
    expect(inserted.find((i) => i.id === row.id)?.endpointId).toBe(row.endpointId);
  }
  const expired = inserted.at(-1);
  if (!expired) throw new Error("no rows");
  const [expiredRow] = await db
    .select({
      status: schema.webhookDeliveries.status,
      next: schema.webhookDeliveries.nextAttemptAt,
    })
    .from(schema.webhookDeliveries)
    .where(eq(schema.webhookDeliveries.id, expired.id));
  expect(expiredRow).toEqual({ status: "exhausted", next: null });
});

it("reconcile sweep flags an endpoint whose backlog is deep or has been due for over an hour", async () => {
  const now = new Date();
  const lagging = await insertEndpoint(teamId, null);
  const healthy = await insertEndpoint(teamId, null);
  await db.insert(schema.webhookDeliveries).values([
    {
      endpointId: lagging,
      messageId: "msg_lagging",
      eventType: "email.delivered",
      payload: {},
      status: "pending",
      nextAttemptAt: new Date(now.getTime() - 61 * 60 * 1000),
    },
    {
      endpointId: healthy,
      messageId: "msg_healthy",
      eventType: "email.delivered",
      payload: {},
      status: "pending",
      nextAttemptAt: new Date(now.getTime() - 20 * 60 * 1000),
    },
  ]);
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (line: string) => {
    warnings.push(line);
  };
  try {
    const armed: string[] = [];
    await reconcileWebhookDeliveries(db, {
      now,
      enqueue: async (rows) => {
        armed.push(...rows.map((r) => r.endpointId));
      },
    });
    // Both are stale (nobody claimed them for 15 min); only one is an alarm.
    expect(armed).toContain(lagging);
    expect(armed).toContain(healthy);
  } finally {
    console.warn = warn;
  }
  expect(warnings.filter((w) => w.includes(lagging))).toHaveLength(1);
  expect(warnings.filter((w) => w.includes(healthy))).toHaveLength(0);
});
