import { hashRecipient } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import type { SerializedSesEvent } from "@millionsend/queue";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { processSesEvent } from "../src/handlers/process-ses-event.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "events-team");
});
afterAll(() => close());

async function insertSentEmail(sesMessageId: string, to = ["r@example.com"]): Promise<string> {
  const [row] = await db
    .insert(schema.emails)
    .values({
      teamId,
      from: "a@acme.dev",
      to,
      subject: "s",
      latestStatus: "sent",
      sesMessageId,
      sentAt: new Date(),
    })
    .returning({ id: schema.emails.id });
  if (!row) throw new Error("insert failed");
  return row.id;
}

function makeEvent(overrides: Partial<SerializedSesEvent>): SerializedSesEvent {
  return {
    eventType: "Delivery",
    sesMessageId: "unset",
    occurredAt: "2026-08-14T12:00:00.000Z",
    data: { eventType: "Delivery" },
    ...overrides,
  };
}

async function statusOf(emailId: string): Promise<string> {
  const [row] = await db
    .select({ s: schema.emails.latestStatus })
    .from(schema.emails)
    .where(eq(schema.emails.id, emailId));
  return row?.s ?? "missing";
}

it("Delivery: status, event row, and daily delivered counter", async () => {
  const emailId = await insertSentEmail("mid-delivery");
  await processSesEvent(db, makeEvent({ sesMessageId: "mid-delivery" }));

  expect(await statusOf(emailId)).toBe("delivered");
  const events = await db
    .select()
    .from(schema.emailEvents)
    .where(eq(schema.emailEvents.emailId, emailId));
  expect(events).toHaveLength(1);
  expect(events[0]?.type).toBe("delivered");
  const [counter] = await db
    .select()
    .from(schema.usageCounters)
    .where(eq(schema.usageCounters.teamId, teamId));
  expect(counter?.delivered).toBe(1);
});

it("Permanent bounce: status + suppression scoped to the owning team", async () => {
  const emailId = await insertSentEmail("mid-bounce", ["victim@example.com"]);
  await processSesEvent(
    db,
    makeEvent({
      eventType: "Bounce",
      sesMessageId: "mid-bounce",
      bounce: {
        bounceType: "Permanent",
        bounceSubType: "General",
        recipients: ["victim@example.com"],
        diagnosticCode: "550 5.1.1 user unknown",
      },
    }),
  );

  expect(await statusOf(emailId)).toBe("bounced");
  const [supp] = await db
    .select()
    .from(schema.suppressions)
    .where(eq(schema.suppressions.emailHash, hashRecipient("victim@example.com")));
  expect(supp?.teamId).toBe(teamId);
  expect(supp?.reason).toBe("hard_bounce");
  expect(supp?.sourceEmailId).toBe(emailId);
});

it("Transient bounce: status moves but nothing is suppressed", async () => {
  const emailId = await insertSentEmail("mid-soft", ["soft@example.com"]);
  await processSesEvent(
    db,
    makeEvent({
      eventType: "Bounce",
      sesMessageId: "mid-soft",
      bounce: {
        bounceType: "Transient",
        bounceSubType: "MailboxFull",
        recipients: ["soft@example.com"],
      },
    }),
  );

  expect(await statusOf(emailId)).toBe("bounced");
  const supp = await db
    .select()
    .from(schema.suppressions)
    .where(eq(schema.suppressions.emailHash, hashRecipient("soft@example.com")));
  expect(supp).toHaveLength(0);
});

it("Complaint: suppression with reason complaint", async () => {
  await insertSentEmail("mid-complaint", ["angry@example.com"]);
  await processSesEvent(
    db,
    makeEvent({
      eventType: "Complaint",
      sesMessageId: "mid-complaint",
      complaint: { recipients: ["angry@example.com"], complaintFeedbackType: "abuse" },
    }),
  );

  const [supp] = await db
    .select()
    .from(schema.suppressions)
    .where(eq(schema.suppressions.emailHash, hashRecipient("angry@example.com")));
  expect(supp?.reason).toBe("complaint");
});

it("out-of-order events never regress the status ladder", async () => {
  const emailId = await insertSentEmail("mid-order");
  await processSesEvent(db, makeEvent({ eventType: "Open", sesMessageId: "mid-order" }));
  expect(await statusOf(emailId)).toBe("opened");
  // A late Delivery ranks below opened: event row recorded, status unchanged.
  await processSesEvent(db, makeEvent({ eventType: "Delivery", sesMessageId: "mid-order" }));
  expect(await statusOf(emailId)).toBe("opened");
  const events = await db
    .select()
    .from(schema.emailEvents)
    .where(eq(schema.emailEvents.emailId, emailId));
  expect(events).toHaveLength(2);
});

it("unknown sesMessageId is ignored entirely", async () => {
  const before = await db.select().from(schema.emailEvents);
  await processSesEvent(db, makeEvent({ sesMessageId: "never-recorded" }));
  const after = await db.select().from(schema.emailEvents);
  expect(after.length).toBe(before.length);
});

it("duplicate suppression events collapse to one row", async () => {
  await insertSentEmail("mid-dupe", ["dupe@example.com"]);
  const event = makeEvent({
    eventType: "Bounce",
    sesMessageId: "mid-dupe",
    bounce: { bounceType: "Permanent", bounceSubType: "General", recipients: ["dupe@example.com"] },
  });
  await processSesEvent(db, event);
  await processSesEvent(db, event);
  const rows = await db
    .select()
    .from(schema.suppressions)
    .where(eq(schema.suppressions.emailHash, hashRecipient("dupe@example.com")));
  expect(rows).toHaveLength(1);
});

it("a redelivered SNS MessageId is fully idempotent — counters included", async () => {
  await insertSentEmail("mid-redeliver");
  const deliveredBefore = (
    await db.select().from(schema.usageCounters).where(eq(schema.usageCounters.teamId, teamId))
  )[0]?.delivered;
  const event = makeEvent({ sesMessageId: "mid-redeliver" });
  await processSesEvent(db, event, { snsMessageId: "sns-redeliver-1" });
  await processSesEvent(db, event, { snsMessageId: "sns-redeliver-1" });

  const rows = await db
    .select()
    .from(schema.emailEvents)
    .where(eq(schema.emailEvents.snsMessageId, "sns-redeliver-1"));
  expect(rows).toHaveLength(1);
  const [counter] = await db
    .select()
    .from(schema.usageCounters)
    .where(eq(schema.usageCounters.teamId, teamId));
  expect(counter?.delivered).toBe((deliveredBefore ?? 0) + 1);
});

it("unknown event types are a no-op", async () => {
  const emailId = await insertSentEmail("mid-unknown");
  await processSesEvent(db, makeEvent({ eventType: "Subscription", sesMessageId: "mid-unknown" }));
  expect(await statusOf(emailId)).toBe("sent");
});
