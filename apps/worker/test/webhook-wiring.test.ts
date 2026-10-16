import { randomBytes } from "node:crypto";
import {
  EnvKeyring,
  encryptEmailBody,
  encryptWebhookSecret,
  generateWebhookSecret,
  hashRecipient,
  type WebhookEnqueue,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import type { SerializedSesEvent } from "@millionsend/queue";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { reconcileWebhookDeliveries } from "../src/handlers/cron.js";
import { processSesEvent } from "../src/handlers/process-ses-event.js";
import { failQueuedEmail, type SesSender, sendEmail } from "../src/handlers/send-email.js";

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

/** A fresh team with a verified domain and one all-events endpoint: no other test's rows reach it. */
async function sendingTeam(slug: string) {
  const sendTeamId = await createTeam(db, slug);
  const endpointId = await insertEndpoint(sendTeamId, null);
  const [domain] = await db
    .insert(schema.domains)
    .values({
      teamId: sendTeamId,
      name: `${slug}.example.com`,
      region: "us-east-1",
      status: "verified",
      verifiedAt: new Date(),
    })
    .returning({ id: schema.domains.id });
  if (!domain) throw new Error("domain insert failed");
  const body = await encryptEmailBody({ html: null, text: "hi" }, keyring);
  const queued = async (overrides: Partial<typeof schema.emails.$inferInsert> = {}) => {
    const [email] = await db
      .insert(schema.emails)
      .values({
        teamId: sendTeamId,
        domainId: domain.id,
        from: `a@${slug}.example.com`,
        to: ["r@example.com"],
        subject: "s",
        latestStatus: "queued",
        bodyCiphertext: body.ciphertext,
        bodyIv: body.iv,
        bodyWrappedDek: body.wrappedDek,
        bodyKeyVersion: body.keyVersion,
        ...overrides,
      })
      .returning({ id: schema.emails.id });
    if (!email) throw new Error("email insert failed");
    return email.id;
  };
  return { teamId: sendTeamId, endpointId, domainId: domain.id, queued };
}

const refusingSes = (name: string): SesSender => ({
  async sendRaw() {
    throw Object.assign(new Error("refused"), { name });
  },
});

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

it("an SES Reject fires email.failed once, as message_rejected, even when SES repeats it", async () => {
  // Fresh team: endpoints created by other tests must not receive this event.
  const rejectTeamId = await createTeam(db, "reject-hooks-team");
  const endpointId = await insertEndpoint(rejectTeamId, null);
  const emailId = await insertSentEmail("wh-mid-reject", rejectTeamId);
  const reject = (snsMessageId: string, enqueue?: WebhookEnqueue) =>
    processSesEvent(
      db,
      {
        eventType: "Reject",
        sesMessageId: "wh-mid-reject",
        occurredAt: "2026-10-16T12:00:00.000Z",
        data: { eventType: "Reject" },
      },
      { snsMessageId, ...(enqueue ? { enqueueWebhookDelivery: enqueue } : {}) },
    );
  // No enqueue wired: the row still lands, for the reconcile sweep.
  await reject("sns-wh-reject-1");
  const enqueued: string[] = [];
  await reject("sns-wh-reject-2", async (rows) => {
    enqueued.push(...rows.map((r) => r.id));
  });

  const rows = await deliveriesFor([endpointId]);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.payload).toMatchObject({
    type: "email.failed",
    data: { email_id: emailId, failed: { reason: "message_rejected" } },
  });
  expect(enqueued).toEqual([]);
  const [email] = await db
    .select({ status: schema.emails.latestStatus })
    .from(schema.emails)
    .where(eq(schema.emails.id, emailId));
  expect(email?.status).toBe("failed");
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

it("the send path fires email.suppressed and email.failed once per row, with public reasons", async () => {
  const team = await sendingTeam("end-hooks");
  await db.insert(schema.suppressions).values({
    teamId: team.teamId,
    email: "gone@example.com",
    emailHash: hashRecipient("gone@example.com"),
    reason: "hard_bounce",
  });
  const enqueued: string[] = [];
  const enqueueWebhookDelivery: WebhookEnqueue = async (rows) => {
    enqueued.push(...rows.map((r) => r.id));
  };
  const ses: SesSender = { sendRaw: async () => ({ messageId: "unused" }) };
  const suppressed = await team.queued({ to: ["gone@example.com"] });
  const missing = await team.queued({ bodyCiphertext: null });
  const rejected = await team.queued();
  const suspended = await team.queued();

  const send = (emailId: string, sender = ses) =>
    sendEmail(db, { keyring, ses: sender, enqueueWebhookDelivery }, { emailId });
  expect(await send(suppressed)).toBe("suppressed");
  expect(await send(missing)).toBe("failed");
  expect(await send(rejected, refusingSes("MessageRejected"))).toBe("failed");
  expect(await send(suspended, refusingSes("AccountSuspendedException"))).toBe("failed");
  // A second pass over an ended row ends nothing.
  expect(await send(suppressed)).toBe("skipped");

  const rows = await deliveriesFor([team.endpointId]);
  const payloadOf = (emailId: string) => {
    const mine = rows.filter((r) => r.emailId === emailId);
    expect(mine).toHaveLength(1);
    return mine[0]?.payload;
  };
  expect(payloadOf(suppressed)).toMatchObject({
    type: "email.suppressed",
    data: {
      email_id: suppressed,
      to: ["gone@example.com"],
      suppressed: {
        type: "OnAccountSuppressionList",
        message: "The recipient is on your suppression list.",
        reason: "recipient_suppressed",
      },
    },
  });
  expect(payloadOf(missing)).toMatchObject({
    type: "email.failed",
    data: { failed: { reason: "body_missing" } },
  });
  expect(payloadOf(rejected)).toMatchObject({ data: { failed: { reason: "message_rejected" } } });
  expect(payloadOf(suspended)).toMatchObject({ data: { failed: { reason: "provider_error" } } });
  expect(enqueued.sort()).toEqual(rows.map((r) => r.id).sort());
  // The stored event keeps the internal code.
  const events = await db
    .select({ data: schema.emailEvents.data })
    .from(schema.emailEvents)
    .where(eq(schema.emailEvents.emailId, suspended));
  expect(events).toEqual([{ data: { source: "worker", reason: "ses_AccountSuspendedException" } }]);
});

it("never fails a row SES already took, however a retry or the dead-letter reaches it", async () => {
  const team = await sendingTeam("taken-hooks");
  const claimedAt = new Date();
  const taken = await team.queued({ sentAt: claimedAt, sesMessageId: "wh-mid-taken" });
  // The domain lost verification after SES took the row: the retry reaches the domain gate.
  await db
    .update(schema.domains)
    .set({ status: "failed" })
    .where(eq(schema.domains.id, team.domainId));
  const deps = { keyring, ses: refusingSes("unused"), enqueueWebhookDelivery: async () => {} };

  expect(await sendEmail(db, deps, { emailId: taken })).toBe("skipped");
  expect(await failQueuedEmail(db, taken, "retries_exhausted", async () => {})).toBe(false);

  const [row] = await db
    .select({ status: schema.emails.latestStatus, sentAt: schema.emails.sentAt })
    .from(schema.emails)
    .where(eq(schema.emails.id, taken));
  expect(row).toEqual({ status: "queued", sentAt: claimedAt });
  const events = await db
    .select()
    .from(schema.emailEvents)
    .where(eq(schema.emailEvents.emailId, taken));
  expect(events).toEqual([]);
  expect(await deliveriesFor([team.endpointId])).toEqual([]);
});

it("the dead-letter fails a row once and fires email.failed as retries_exhausted", async () => {
  const team = await sendingTeam("dead-hooks");
  const emailId = await team.queued();
  const enqueued: string[] = [];
  const enqueue: WebhookEnqueue = async (rows) => {
    enqueued.push(...rows.map((r) => r.id));
  };

  expect(await failQueuedEmail(db, emailId, "retries_exhausted", enqueue)).toBe(true);
  expect(await failQueuedEmail(db, emailId, "retries_exhausted", enqueue)).toBe(false);

  const rows = await deliveriesFor([team.endpointId]);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.payload).toMatchObject({
    type: "email.failed",
    data: { email_id: emailId, failed: { reason: "retries_exhausted" } },
  });
  expect(enqueued).toEqual([rows[0]?.id]);
});

it("a canceled broadcast's row fires nothing", async () => {
  const team = await sendingTeam("canceled-hooks");
  const [broadcast] = await db
    .insert(schema.broadcasts)
    .values({
      teamId: team.teamId,
      from: "a@canceled-hooks.example.com",
      subject: "s",
      status: "canceled",
    })
    .returning({ id: schema.broadcasts.id });
  const [contact] = await db
    .insert(schema.contacts)
    .values({ teamId: team.teamId, email: "stopped@example.com" })
    .returning({ id: schema.contacts.id });
  const emailId = await team.queued({
    broadcastId: broadcast?.id,
    contactId: contact?.id,
    to: ["stopped@example.com"],
  });

  const outcome = await sendEmail(
    db,
    {
      keyring,
      ses: refusingSes("unused"),
      enqueueWebhookDelivery: async () => {},
      unsubscribe: { secretKey: randomBytes(32), baseUrl: "https://app.example.com" },
    },
    { emailId },
  );
  expect(outcome).toBe("canceled");
  expect(await deliveriesFor([team.endpointId])).toEqual([]);
});

it("with no queue hand-off wired, the send path's rows still land for the reconcile sweep", async () => {
  const team = await sendingTeam("sweep-hooks");
  const sent = await team.queued();
  const failed = await team.queued({ bodyCiphertext: null });
  const deps = { keyring, ses: { sendRaw: async () => ({ messageId: `wh-sweep-${sent}` }) } };

  expect(await sendEmail(db, deps, { emailId: sent })).toBe("sent");
  expect(await sendEmail(db, deps, { emailId: failed })).toBe("failed");

  const rows = await deliveriesFor([team.endpointId]);
  expect(rows.map((r) => [r.emailId, r.eventType]).sort()).toEqual(
    [
      [sent, "email.sent"],
      [failed, "email.failed"],
    ].sort(),
  );
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

it("reconcile sweep flags an endpoint with a delivery due for over six hours, by age alone", async () => {
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
      nextAttemptAt: new Date(now.getTime() - 361 * 60 * 1000),
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
  // Deep but keeping up: many rows, none due long, is no alarm.
  const deep = await insertEndpoint(teamId, null);
  await db.execute(sql`
    insert into ${schema.webhookDeliveries} (endpoint_id, message_id, event_type, payload, status, next_attempt_at)
    select ${deep}::uuid, 'msg_deep_' || g, 'email.delivered', '{}'::jsonb, 'pending', ${new Date(now.getTime() - 20 * 60 * 1000)}
    from generate_series(1, 10001) g
  `);
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
  expect(warnings.filter((w) => w.includes(deep))).toHaveLength(0);
});
