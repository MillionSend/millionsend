import { DAY_MS, hashRecipient } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import type { SerializedSesEvent } from "@millionsend/queue";
import { createTeam, createTestDb, createWebhookEndpoint } from "@millionsend/test-utils";
import { and, eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { processSesEvent } from "../src/handlers/process-ses-event.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "events-team");
});
afterAll(() => close());

async function insertSentEmail(
  sesMessageId: string,
  to = ["r@example.com"],
  contactId: string | null = null,
  sentAt = new Date(),
  team = teamId,
): Promise<string> {
  const [row] = await db
    .insert(schema.emails)
    .values({
      teamId: team,
      contactId,
      from: "a@acme.dev",
      to,
      subject: "s",
      latestStatus: "sent",
      sesMessageId,
      sentAt,
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
  const [counter] = await db
    .select()
    .from(schema.usageCounters)
    .where(eq(schema.usageCounters.teamId, teamId));
  expect(counter?.bounced).toBe(1);
  expect(counter?.hardBounced).toBe(1);
});

it("Transient bounce: status moves but nothing is suppressed, a full mailbox of no contact included", async () => {
  const emailId = await insertSentEmail("mid-soft", ["soft@example.com"]);
  const [before] = await db
    .select()
    .from(schema.usageCounters)
    .where(eq(schema.usageCounters.teamId, teamId));
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
  // Transient bounces count in bounced but never in hard_bounced.
  const [counter] = await db
    .select()
    .from(schema.usageCounters)
    .where(eq(schema.usageCounters.teamId, teamId));
  expect(counter?.bounced).toBe((before?.bounced ?? 0) + 1);
  expect(counter?.hardBounced).toBe(before?.hardBounced ?? 0);
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

describe("hard bounce and complaint counters", () => {
  /** The team's daily and hourly counter rows for the day and hour `at` falls in. */
  async function countersAt(at: string) {
    const [daily] = await db
      .select()
      .from(schema.usageCounters)
      .where(
        and(eq(schema.usageCounters.teamId, teamId), eq(schema.usageCounters.day, at.slice(0, 10))),
      );
    const [hourly] = await db
      .select()
      .from(schema.usageCountersHourly)
      .where(
        and(
          eq(schema.usageCountersHourly.teamId, teamId),
          eq(schema.usageCountersHourly.hour, new Date(`${at.slice(0, 13)}:00:00.000Z`)),
        ),
      );
    return { daily, hourly };
  }

  it("leave out Permanent bounces for mail SES never attempted, which still bounce and suppress", async () => {
    const at = "2026-09-20T15:30:00.000Z";
    const subTypes = [
      "OnAccountSuppressionList",
      "OnTenantSuppressionList",
      "EmailValidationSuppressed",
      "UnsubscribedRecipient",
      "General",
    ];
    for (const subType of subTypes) {
      const to = `${subType.toLowerCase()}@example.com`;
      await insertSentEmail(`mid-unattempted-${subType}`, [to]);
      await processSesEvent(
        db,
        makeEvent({
          eventType: "Bounce",
          sesMessageId: `mid-unattempted-${subType}`,
          occurredAt: at,
          bounce: { bounceType: "Permanent", bounceSubType: subType, recipients: [to] },
        }),
      );
    }

    const { daily, hourly } = await countersAt(at);
    expect(daily).toMatchObject({ bounced: 5, hardBounced: 1 });
    expect(hourly).toMatchObject({ bounced: 5, hardBounced: 1 });
    const [supp] = await db
      .select()
      .from(schema.suppressions)
      .where(
        eq(schema.suppressions.emailHash, hashRecipient("onaccountsuppressionlist@example.com")),
      );
    expect(supp?.reason).toBe("hard_bounce");
  });

  it("count a complaint on the day its mail went out and the hour it arrives, unless SES never attempted the mail", async () => {
    const at = "2026-09-21T09:10:00.000Z";
    const sentAt = new Date(Date.parse(at) - 14 * DAY_MS).toISOString();
    await insertSentEmail("mid-late-complaint", ["late@example.com"], null, new Date(sentAt));
    await processSesEvent(
      db,
      makeEvent({
        eventType: "Complaint",
        sesMessageId: "mid-late-complaint",
        occurredAt: at,
        sentAt,
        complaint: { recipients: ["late@example.com"], complaintFeedbackType: "abuse" },
      }),
    );
    expect((await countersAt(sentAt)).daily?.complained).toBe(1);
    expect((await countersAt(at)).daily).toBeUndefined();
    expect((await countersAt(at)).hourly?.complained).toBe(1);

    // Queued before the send time was carried: the day it arrived.
    await insertSentEmail("mid-untimed-complaint", ["untimed@example.com"], null, new Date(sentAt));
    await processSesEvent(
      db,
      makeEvent({
        eventType: "Complaint",
        sesMessageId: "mid-untimed-complaint",
        occurredAt: at,
        complaint: { recipients: ["untimed@example.com"], complaintFeedbackType: "abuse" },
      }),
    );
    const listed = await insertSentEmail("mid-listed-complaint", ["listed@example.com"]);
    await processSesEvent(
      db,
      makeEvent({
        eventType: "Complaint",
        sesMessageId: "mid-listed-complaint",
        occurredAt: at,
        sentAt,
        complaint: {
          recipients: ["listed@example.com"],
          complaintSubType: "OnAccountSuppressionList",
        },
      }),
    );

    const { daily, hourly } = await countersAt(at);
    expect(daily?.complained).toBe(1);
    expect(hourly?.complained).toBe(2);
    expect((await countersAt(sentAt)).daily?.complained).toBe(1);
    expect(await statusOf(listed)).toBe("complained");
    const [supp] = await db
      .select()
      .from(schema.suppressions)
      .where(eq(schema.suppressions.emailHash, hashRecipient("listed@example.com")));
    expect(supp?.reason).toBe("complaint");
  });
});

describe("feedback from the mailbox simulator and Free pools", () => {
  const dailyOf = async (team: string, day: string) => {
    const [row] = await db
      .select({
        delivered: schema.usageCounters.delivered,
        bounced: schema.usageCounters.bounced,
        hardBounced: schema.usageCounters.hardBounced,
        complained: schema.usageCounters.complained,
      })
      .from(schema.usageCounters)
      .where(and(eq(schema.usageCounters.teamId, team), eq(schema.usageCounters.day, day)));
    return row;
  };

  it("leaves the simulator's bounces and complaints out of the rates; they still suppress and fire webhooks", async () => {
    const sim = await createTeam(db, "events-simulator");
    const endpoint = await createWebhookEndpoint(db, sim, null);
    const at = "2026-09-22T10:00:00.000Z";
    const bounce = "bounce@simulator.amazonses.com";
    const complaint = "complaint@simulator.amazonses.com";
    const bounced = await insertSentEmail("mid-sim-bounce", [bounce], null, new Date(), sim);
    await processSesEvent(
      db,
      makeEvent({
        eventType: "Bounce",
        sesMessageId: "mid-sim-bounce",
        occurredAt: at,
        bounce: { bounceType: "Permanent", bounceSubType: "General", recipients: [bounce] },
      }),
    );
    const complained = await insertSentEmail(
      "mid-sim-complaint",
      [complaint],
      null,
      new Date(),
      sim,
    );
    await processSesEvent(
      db,
      makeEvent({
        eventType: "Complaint",
        sesMessageId: "mid-sim-complaint",
        occurredAt: at,
        complaint: { recipients: [complaint], complaintFeedbackType: "abuse" },
      }),
    );
    expect(await dailyOf(sim, at.slice(0, 10))).toEqual({
      delivered: 0,
      bounced: 1,
      hardBounced: 0,
      complained: 0,
    });
    expect([await statusOf(bounced), await statusOf(complained)]).toEqual([
      "bounced",
      "complained",
    ]);
    const suppressed = await db
      .select({ email: schema.suppressions.email, reason: schema.suppressions.reason })
      .from(schema.suppressions)
      .where(eq(schema.suppressions.teamId, sim));
    expect(suppressed).toEqual(
      expect.arrayContaining([
        { email: bounce, reason: "hard_bounce" },
        { email: complaint, reason: "complaint" },
      ]),
    );
    const fired = await db
      .select({ type: schema.webhookDeliveries.eventType })
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.endpointId, endpoint));
    expect(fired.map((d) => d.type)).toEqual(
      expect.arrayContaining(["email.bounced", "email.complained"]),
    );
  });

  it("adds a Free team's hard bounces and complaints to its pool, beside its own counters", async () => {
    const owner = "u-events-pool";
    const pooled = await createTeam(db, "events-pooled", { poolOwnerId: owner });
    const paid = await createTeam(db, "events-paid", { poolOwnerId: owner });
    await db.update(schema.teams).set({ plan: "starter" }).where(eq(schema.teams.id, paid));
    const at = "2026-09-23T10:00:00.000Z";
    const day = at.slice(0, 10);
    for (const [team, mid] of [
      [pooled, "mid-pool-complaint"],
      [paid, "mid-paid-complaint"],
    ] as const) {
      await insertSentEmail(mid, ["r@example.com"], null, new Date(), team);
      await processSesEvent(
        db,
        makeEvent({
          eventType: "Complaint",
          sesMessageId: mid,
          occurredAt: at,
          complaint: { recipients: ["r@example.com"] },
        }),
      );
    }
    await insertSentEmail("mid-pool-bounce", ["gone@example.com"], null, new Date(), pooled);
    await processSesEvent(
      db,
      makeEvent({
        eventType: "Bounce",
        sesMessageId: "mid-pool-bounce",
        occurredAt: at,
        bounce: {
          bounceType: "Permanent",
          bounceSubType: "General",
          recipients: ["gone@example.com"],
        },
      }),
    );
    await insertSentEmail("mid-pool-delivery", ["r@example.com"], null, new Date(), pooled);
    await processSesEvent(
      db,
      makeEvent({ eventType: "Delivery", sesMessageId: "mid-pool-delivery", occurredAt: at }),
    );
    expect(await dailyOf(pooled, day)).toEqual({
      delivered: 1,
      bounced: 1,
      hardBounced: 1,
      complained: 1,
    });
    expect(await dailyOf(paid, day)).toMatchObject({ complained: 1 });
    expect(
      await db.select().from(schema.freePoolUsage).where(eq(schema.freePoolUsage.ownerId, owner)),
    ).toEqual([
      {
        ownerId: owner,
        day,
        accepted: 0,
        sent: 0,
        sentNoFeedback: 0,
        hardBounced: 1,
        complained: 1,
      },
    ]);
  });

  it("adds feedback on a deleted Free team's mail to the pool its send was tagged with", async () => {
    const owner = "u-events-deleted";
    const gone = await createTeam(db, "events-deleted", { poolOwnerId: owner });
    await insertSentEmail("mid-gone-complaint", ["r@outlook.com"], null, new Date(), gone);
    await insertSentEmail("mid-gone-bounce", ["gone@example.com"], null, new Date(), gone);
    await db.delete(schema.teams).where(eq(schema.teams.id, gone));
    const at = "2026-09-24T10:00:00.000Z";
    const sentAt = "2026-09-22T10:00:00.000Z";
    const tagged = { occurredAt: at, sentAt, poolOwnerId: owner };
    const events: Partial<SerializedSesEvent>[] = [
      {
        eventType: "Complaint",
        sesMessageId: "mid-gone-complaint",
        complaint: { recipients: ["r@outlook.com"] },
      },
      {
        eventType: "Bounce",
        sesMessageId: "mid-gone-bounce",
        bounce: {
          bounceType: "Permanent",
          bounceSubType: "General",
          recipients: ["gone@example.com"],
        },
      },
      // None of these would count on a row either.
      {
        eventType: "Bounce",
        sesMessageId: "mid-gone-soft",
        bounce: {
          bounceType: "Transient",
          bounceSubType: "General",
          recipients: ["x@example.com"],
        },
      },
      {
        eventType: "Complaint",
        sesMessageId: "mid-gone-unattempted",
        complaint: { recipients: ["y@outlook.com"], complaintSubType: "OnAccountSuppressionList" },
      },
      { eventType: "Delivery", sesMessageId: "mid-gone-delivery" },
    ];
    for (const event of events) {
      await processSesEvent(db, makeEvent({ ...tagged, ...event }), {
        snsMessageId: `sns-${event.sesMessageId}`,
      });
    }
    // SNS delivers at least once: a repeat counts nothing more.
    await processSesEvent(db, makeEvent({ ...tagged, ...events[0] }), {
      snsMessageId: "sns-mid-gone-complaint",
    });
    expect(
      await db
        .select({ ses: schema.sesUnmatchedEvents.sesMessageId })
        .from(schema.sesUnmatchedEvents)
        .where(eq(schema.sesUnmatchedEvents.poolOwnerId, owner)),
    ).toHaveLength(4);
    // The complaint on its mail's send day, the hard bounce on the day it arrived.
    expect(
      await db
        .select()
        .from(schema.freePoolUsage)
        .where(eq(schema.freePoolUsage.ownerId, owner))
        .orderBy(schema.freePoolUsage.day),
    ).toEqual([
      {
        ownerId: owner,
        day: sentAt.slice(0, 10),
        accepted: 0,
        sent: 0,
        sentNoFeedback: 0,
        hardBounced: 0,
        complained: 1,
      },
      {
        ownerId: owner,
        day: at.slice(0, 10),
        accepted: 0,
        sent: 0,
        sentNoFeedback: 0,
        hardBounced: 1,
        complained: 0,
      },
    ]);
  });

  it("counts a complaint in the pool its send was tagged with, even once the team left Free", async () => {
    const owner = "u-events-upgraded";
    const upgraded = await createTeam(db, "events-upgraded", { poolOwnerId: owner });
    const sentAt = "2026-09-26T10:00:00.000Z";
    await insertSentEmail(
      "mid-upgraded-complaint",
      ["r@example.com"],
      null,
      new Date(sentAt),
      upgraded,
    );
    await db.update(schema.teams).set({ plan: "starter" }).where(eq(schema.teams.id, upgraded));
    await processSesEvent(
      db,
      makeEvent({
        eventType: "Complaint",
        sesMessageId: "mid-upgraded-complaint",
        occurredAt: "2026-09-27T10:00:00.000Z",
        sentAt,
        poolOwnerId: owner,
        complaint: { recipients: ["r@example.com"] },
      }),
    );
    expect(
      await db.select().from(schema.freePoolUsage).where(eq(schema.freePoolUsage.ownerId, owner)),
    ).toEqual([
      {
        ownerId: owner,
        day: sentAt.slice(0, 10),
        accepted: 0,
        sent: 0,
        sentNoFeedback: 0,
        hardBounced: 0,
        complained: 1,
      },
    ]);
  });

  it("adds nothing for an unknown email's feedback without a pool tag, or from the simulator", async () => {
    const at = "2026-09-25T10:00:00.000Z";
    await processSesEvent(
      db,
      makeEvent({
        eventType: "Complaint",
        sesMessageId: "mid-unknown-untagged",
        occurredAt: at,
        complaint: { recipients: ["r@outlook.com"] },
      }),
    );
    const simulator = { occurredAt: at, poolOwnerId: "u-events-simulator" };
    await processSesEvent(
      db,
      makeEvent({
        ...simulator,
        eventType: "Complaint",
        sesMessageId: "mid-unknown-sim-complaint",
        complaint: { recipients: ["complaint@simulator.amazonses.com"] },
      }),
    );
    await processSesEvent(
      db,
      makeEvent({
        ...simulator,
        eventType: "Bounce",
        sesMessageId: "mid-unknown-sim-bounce",
        bounce: {
          bounceType: "Permanent",
          bounceSubType: "General",
          recipients: ["bounce@simulator.amazonses.com"],
        },
      }),
    );
    expect(
      await db
        .select()
        .from(schema.freePoolUsage)
        .where(eq(schema.freePoolUsage.day, at.slice(0, 10))),
    ).toEqual([]);
    // The simulator's feedback is a test: not even recorded as unmatched.
    expect(
      await db
        .select({ ses: schema.sesUnmatchedEvents.sesMessageId })
        .from(schema.sesUnmatchedEvents)
        .where(like(schema.sesUnmatchedEvents.sesMessageId, "mid-unknown-%")),
    ).toEqual([{ ses: "mid-unknown-untagged" }]);
  });
});

it("out-of-order events never regress the status ladder", async () => {
  const emailId = await insertSentEmail("mid-order");
  await processSesEvent(db, makeEvent({ eventType: "Delivery", sesMessageId: "mid-order" }));
  expect(await statusOf(emailId)).toBe("delivered");
  // SES Send events are ignored entirely — the worker's own "sent" event is
  // the authoritative record, so no row and no status change.
  await processSesEvent(db, makeEvent({ eventType: "Send", sesMessageId: "mid-order" }));
  expect(await statusOf(emailId)).toBe("delivered");
  const events = await db
    .select()
    .from(schema.emailEvents)
    .where(eq(schema.emailEvents.emailId, emailId));
  expect(events).toHaveLength(1);
});

it("unknown sesMessageId is ignored entirely", async () => {
  const before = await db.select().from(schema.emailEvents);
  await processSesEvent(db, makeEvent({ sesMessageId: "never-recorded" }));
  const after = await db.select().from(schema.emailEvents);
  expect(after.length).toBe(before.length);
});

it("records an unknown sesMessageId's complaint and bounce once each, for the platform's rates only", async () => {
  const complaint = makeEvent({
    eventType: "Complaint",
    sesMessageId: "gone-complaint",
    complaint: { recipients: ["unknown-id@example.com"] },
    data: { eventType: "Complaint", complaint: {} },
  });
  await processSesEvent(db, complaint, { snsMessageId: "sns-gone-complaint" });
  // SNS delivers at least once.
  await processSesEvent(db, complaint, { snsMessageId: "sns-gone-complaint" });
  await processSesEvent(
    db,
    makeEvent({
      eventType: "Bounce",
      sesMessageId: "gone-bounce",
      bounce: {
        bounceType: "Permanent",
        bounceSubType: "OnAccountSuppressionList",
        recipients: ["unknown-id@example.com"],
      },
    }),
    { snsMessageId: "sns-gone-bounce" },
  );
  // A delivery about mail we no longer know carries nothing to count.
  await processSesEvent(db, makeEvent({ sesMessageId: "gone-delivery" }), {
    snsMessageId: "sns-gone-delivery",
  });
  const rows = await db
    .select({
      sns: schema.sesUnmatchedEvents.snsMessageId,
      ses: schema.sesUnmatchedEvents.sesMessageId,
      type: schema.sesUnmatchedEvents.type,
      bounceType: schema.sesUnmatchedEvents.bounceType,
      subType: schema.sesUnmatchedEvents.subType,
      occurredAt: schema.sesUnmatchedEvents.occurredAt,
    })
    .from(schema.sesUnmatchedEvents)
    .where(like(schema.sesUnmatchedEvents.sesMessageId, "gone-%"));
  expect(rows.sort((a, b) => a.ses.localeCompare(b.ses))).toEqual([
    {
      sns: "sns-gone-bounce",
      ses: "gone-bounce",
      type: "bounced",
      bounceType: "Permanent",
      subType: "OnAccountSuppressionList",
      occurredAt: new Date("2026-08-14T12:00:00.000Z"),
    },
    {
      sns: "sns-gone-complaint",
      ses: "gone-complaint",
      type: "complained",
      bounceType: null,
      subType: null,
      occurredAt: new Date("2026-08-14T12:00:00.000Z"),
    },
  ]);
  // Nothing about any team moved.
  expect(
    await db
      .select()
      .from(schema.suppressions)
      .where(eq(schema.suppressions.email, "unknown-id@example.com")),
  ).toEqual([]);
});

it("joins an early SES event through the server-owned email tag", async () => {
  const [row] = await db
    .insert(schema.emails)
    .values({
      teamId,
      from: "a@acme.dev",
      to: ["early@example.com"],
      subject: "s",
      latestStatus: "queued",
      sentAt: new Date(),
    })
    .returning({ id: schema.emails.id });
  if (!row) throw new Error("insert failed");

  await processSesEvent(db, makeEvent({ sesMessageId: "mid-arrived-first", emailId: row.id }), {
    snsMessageId: "sns-arrived-first",
  });

  const [email] = await db.select().from(schema.emails).where(eq(schema.emails.id, row.id));
  expect(email?.sesMessageId).toBe("mid-arrived-first");
  expect(email?.latestStatus).toBe("delivered");
});

it("never trusts an invalid or unclaimed fallback email tag", async () => {
  const [row] = await db
    .insert(schema.emails)
    .values({
      teamId,
      from: "a@acme.dev",
      to: ["queued@example.com"],
      subject: "s",
      latestStatus: "queued",
    })
    .returning({ id: schema.emails.id });
  if (!row) throw new Error("insert failed");

  await processSesEvent(db, makeEvent({ sesMessageId: "mid-unclaimed", emailId: row.id }));
  await processSesEvent(db, makeEvent({ sesMessageId: "mid-invalid-tag", emailId: "not-a-uuid" }));
  expect(await statusOf(row.id)).toBe("queued");
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

it("a mid-processing failure never burns the idempotency gate: retry records the suppression", async () => {
  const emailId = await insertSentEmail("mid-retry", ["retry@example.com"]);
  type AnyFn = (...args: unknown[]) => unknown;
  let failNext = true;
  // Reject the first raw-SQL execute (the status CAS / counter path) once,
  // whether reached directly or inside a transaction — simulating a crash
  // after the event row was inserted.
  const failOnce = (target: object): object =>
    new Proxy(target, {
      get(t, prop) {
        const value = (t as Record<PropertyKey, unknown>)[prop];
        if (prop === "execute" && failNext) {
          return () => {
            failNext = false;
            return Promise.reject(new Error("injected failure"));
          };
        }
        if (prop === "transaction" && typeof value === "function") {
          return (fn: AnyFn, ...rest: unknown[]) =>
            (value as AnyFn).call(t, (tx: object) => fn(failOnce(tx)), ...rest);
        }
        return typeof value === "function" ? (value as AnyFn).bind(t) : value;
      },
    });
  const flakyDb = failOnce(db) as Db;
  const event = makeEvent({
    eventType: "Bounce",
    sesMessageId: "mid-retry",
    bounce: {
      bounceType: "Permanent",
      bounceSubType: "General",
      recipients: ["retry@example.com"],
    },
  });

  await expect(processSesEvent(flakyDb, event, { snsMessageId: "sns-retry-1" })).rejects.toThrow(
    "injected failure",
  );
  // Retry (SNS at-least-once / queue redelivery) must fully apply the event.
  await processSesEvent(flakyDb, event, { snsMessageId: "sns-retry-1" });

  expect(await statusOf(emailId)).toBe("bounced");
  const supp = await db
    .select()
    .from(schema.suppressions)
    .where(eq(schema.suppressions.emailHash, hashRecipient("retry@example.com")));
  expect(supp).toHaveLength(1);
  const events = await db
    .select()
    .from(schema.emailEvents)
    .where(eq(schema.emailEvents.emailId, emailId));
  expect(events).toHaveLength(1);
});

// Engagement (opened/clicked) is tracked app-layer now: the per-domain config
// set excludes OPEN/CLICK, so SES never sends them. A stray legacy event is
// ignored entirely — no status change, no counter, no event row — so it can
// never double-count what the app-layer redirect endpoints already recorded.
it("legacy Open/Click SES events are ignored entirely", async () => {
  const emailId = await insertSentEmail("mid-legacy-engagement");
  await processSesEvent(
    db,
    makeEvent({ eventType: "Open", sesMessageId: "mid-legacy-engagement" }),
  );
  await processSesEvent(
    db,
    makeEvent({
      eventType: "Click",
      sesMessageId: "mid-legacy-engagement",
      click: { link: "https://x.test" },
    }),
  );
  expect(await statusOf(emailId)).toBe("sent");
  const events = await db
    .select()
    .from(schema.emailEvents)
    .where(eq(schema.emailEvents.emailId, emailId));
  expect(events).toHaveLength(0);
  const [counter] = await db
    .select()
    .from(schema.usageCounters)
    .where(eq(schema.usageCounters.teamId, teamId));
  expect(counter?.opened ?? 0).toBe(0);
  expect(counter?.clicked ?? 0).toBe(0);
});

it("unknown event types are a no-op", async () => {
  const emailId = await insertSentEmail("mid-unknown");
  await processSesEvent(db, makeEvent({ eventType: "Subscription", sesMessageId: "mid-unknown" }));
  expect(await statusOf(emailId)).toBe("sent");
});

it("suppresses only addresses the email was sent to — never a payload-supplied stranger", async () => {
  const emailId = await insertSentEmail("mid-bounce-scope", ["real@example.com"]);
  await db
    .update(schema.emails)
    .set({ cc: ["Copied <copy@example.com>"] })
    .where(eq(schema.emails.id, emailId));
  await processSesEvent(
    db,
    makeEvent({
      eventType: "Bounce",
      sesMessageId: "mid-bounce-scope",
      bounce: {
        bounceType: "Permanent",
        bounceSubType: "General",
        recipients: ["Real@Example.com", "copy@example.com", "stranger@example.com"],
      },
    }),
  );

  const hashes = (
    await db
      .select({ h: schema.suppressions.emailHash })
      .from(schema.suppressions)
      .where(eq(schema.suppressions.sourceEmailId, emailId))
  ).map((r) => r.h);
  expect(hashes).toHaveLength(2);
  expect(hashes).toContain(hashRecipient("real@example.com"));
  expect(hashes).toContain(hashRecipient("copy@example.com"));
  expect(hashes).not.toContain(hashRecipient("stranger@example.com"));
});

describe("full and abandoned mailboxes", () => {
  const bouncedAt = new Date("2026-09-10T12:00:00.000Z");
  const earlier = (ms: number) => new Date(bouncedAt.getTime() - ms);

  async function addContact(email: string, mailboxFullAt: Date | null = null, team = teamId) {
    const [row] = await db
      .insert(schema.contacts)
      .values({ teamId: team, email, mailboxFullAt })
      .returning({ id: schema.contacts.id });
    if (!row) throw new Error("insert failed");
    return row.id;
  }

  /** A soft bounce of a fresh email to `to`, "mailbox full" unless told otherwise. */
  async function softBounce(
    to: string,
    opts: { contactId?: string; subType?: string; diagnosticCode?: string } = {},
  ): Promise<string> {
    const emailId = await insertSentEmail(`mid-full-${to}`, [to], opts.contactId);
    await processSesEvent(
      db,
      makeEvent({
        eventType: "Bounce",
        sesMessageId: `mid-full-${to}`,
        occurredAt: bouncedAt.toISOString(),
        bounce: {
          bounceType: "Transient",
          bounceSubType: opts.subType ?? "MailboxFull",
          recipients: [to],
          ...(opts.diagnosticCode ? { diagnosticCode: opts.diagnosticCode } : {}),
        },
      }),
    );
    return emailId;
  }

  async function suppressionOf(address: string) {
    const [row] = await db
      .select({ reason: schema.suppressions.reason, source: schema.suppressions.sourceEmailId })
      .from(schema.suppressions)
      .where(
        and(
          eq(schema.suppressions.teamId, teamId),
          eq(schema.suppressions.emailHash, hashRecipient(address)),
        ),
      );
    return row;
  }

  async function mailboxFullAtOf(contactId: string) {
    const [row] = await db
      .select({ at: schema.contacts.mailboxFullAt })
      .from(schema.contacts)
      .where(eq(schema.contacts.id, contactId));
    return row?.at;
  }

  it("an abandoned mailbox is suppressed as a hard bounce at once, contact or not", async () => {
    const emailId = await softBounce("gone@example.com", {
      subType: "General",
      diagnosticCode: "552-5.2.2 The recipient's inbox is out of storage space and inactive.",
    });
    expect(await suppressionOf("gone@example.com")).toEqual({
      reason: "hard_bounce",
      source: emailId,
    });
  });

  it("a contact's first full answer is kept, not suppressed", async () => {
    const id = await addContact("full-first@example.com");
    await softBounce("full-first@example.com", { contactId: id });
    expect(await suppressionOf("full-first@example.com")).toBeUndefined();
    expect(await mailboxFullAtOf(id)).toEqual(bouncedAt);
  });

  it("a second full answer a day to 30 days after the first suppresses the contact", async () => {
    for (const [address, ago] of [
      ["full-day@example.com", DAY_MS],
      ["full-month@example.com", 30 * DAY_MS],
    ] as const) {
      const id = await addContact(address, earlier(ago));
      const emailId = await softBounce(address, { contactId: id });
      expect(await suppressionOf(address)).toEqual({ reason: "hard_bounce", source: emailId });
    }
  });

  it("an answer within the day keeps the first; one past 30 days starts over", async () => {
    const first = earlier(DAY_MS - 1);
    const soon = await addContact("full-soon@example.com", first);
    await softBounce("full-soon@example.com", { contactId: soon });
    expect(await suppressionOf("full-soon@example.com")).toBeUndefined();
    expect(await mailboxFullAtOf(soon)).toEqual(first);

    const stale = await addContact("full-stale@example.com", earlier(30 * DAY_MS + 1));
    await softBounce("full-stale@example.com", { contactId: stale });
    expect(await suppressionOf("full-stale@example.com")).toBeUndefined();
    expect(await mailboxFullAtOf(stale)).toEqual(bouncedAt);
  });

  it("finds the contact by address when the email names none, in the sending team only", async () => {
    const mine = await addContact("Full.Case@example.com");
    const theirs = await addContact(
      "full.case@example.com",
      null,
      await createTeam(db, "events-other-team"),
    );
    await softBounce("FULL.case@example.com");
    expect(await mailboxFullAtOf(mine)).toEqual(bouncedAt);
    expect(await mailboxFullAtOf(theirs)).toBeNull();
  });

  it("other soft bounces leave the contact alone", async () => {
    const id = await addContact("busy@example.com");
    await softBounce("busy@example.com", {
      contactId: id,
      subType: "General",
      diagnosticCode: "421 4.7.0 Try again later",
    });
    expect(await mailboxFullAtOf(id)).toBeNull();
    expect(await suppressionOf("busy@example.com")).toBeUndefined();
  });
});
