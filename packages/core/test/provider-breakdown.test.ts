import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { afterAll, beforeAll, expect, it } from "vitest";
import { broadcastProviderBreakdown } from "../src/provider-breakdown.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;
let otherTeamId: string;
let broadcastId: string;

type EventType = (typeof schema.emailEventTypeEnum.enumValues)[number];
type Event = EventType | { type: EventType; bounceType?: string; data?: Record<string, unknown> };

async function newBroadcast(team: string): Promise<string> {
  const [row] = await db
    .insert(schema.broadcasts)
    .values({ teamId: team, from: "News <news@acme.example>", subject: "s" })
    .returning({ id: schema.broadcasts.id });
  if (!row) throw new Error("seed failed");
  return row.id;
}

async function send(
  to: string,
  events: Event[],
  row: Partial<typeof schema.emails.$inferInsert> = {},
): Promise<void> {
  const [email] = await db
    .insert(schema.emails)
    .values({
      teamId,
      broadcastId,
      from: "News <news@acme.example>",
      to: [to],
      subject: "s",
      latestStatus: "sent",
      sentAt: new Date("2026-09-01T12:00:00Z"),
      ...row,
    })
    .returning({ id: schema.emails.id });
  if (!email) throw new Error("seed failed");
  for (const event of events) {
    const e = typeof event === "string" ? { type: event } : event;
    await db
      .insert(schema.emailEvents)
      .values({ emailId: email.id, occurredAt: new Date("2026-09-01T12:01:00Z"), ...e });
  }
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "breakdown-team");
  otherTeamId = await createTeam(db, "breakdown-other");
  broadcastId = await newBroadcast(teamId);

  await send("Ana <ana@Gmail.com>", ["sent", "delivered", "opened", "clicked"]);
  // A machine's fetch of the tracking image is not an open.
  await send("bo@gmail.com", ["sent", "delivered", "prefetched"]);
  // Delayed, then given up on: a soft bounce is not a bounce here.
  await send("cy@googlemail.com", [
    "sent",
    "delivery_delayed",
    "delivery_delayed",
    { type: "bounced", bounceType: "Transient" },
  ]);
  await send("di@outlook.com", ["sent", "delivered", "complained"]);
  await send("ed@hotmail.com.br", ["sent", { type: "bounced", bounceType: "Permanent" }]);
  // Written before the bounce class had its own column: read from the payload.
  await send("fi@icloud.com", [
    "sent",
    { type: "bounced", data: { bounce: { bounceType: "Permanent" } } },
  ]);
  await send("gu@yahoo.com", ["sent", "delivered", "opened"]);
  // A complaint SES took for an address on its own list: the mail never went out.
  await send("ha@yahoo.com", [
    "sent",
    { type: "complained", data: { complaint: { complaintSubType: "OnAccountSuppressionList" } } },
  ]);
  await send("hu@example.com", ["sent", "delivered"]);
  // AOL reports complaints; t-online never does, so it stays out of the denominator.
  await send("lu@aol.com", ["sent", "delivered", "complained"]);
  await send("ty@t-online.de", ["sent", "delivered"]);

  // Never went out: still queued, and refused outright with its claim kept.
  await send("iv@gmail.com", [], { latestStatus: "queued", sentAt: null });
  await send("jo@gmail.com", ["failed"], { latestStatus: "failed" });
  // Another broadcast of the same team.
  const other = await newBroadcast(teamId);
  await send("ka@gmail.com", ["sent", "delivered"], { broadcastId: other });
});

afterAll(() => close());

it("counts a broadcast's emails per mailbox provider, busiest first", async () => {
  const zero = {
    delivered: 0,
    opened: 0,
    clicked: 0,
    bounced: 0,
    delayed: 0,
    complained: 0,
    complaintSent: 0,
  };
  expect(await broadcastProviderBreakdown(db, { teamId, broadcastId })).toEqual([
    { ...zero, provider: "gmail", sent: 3, delivered: 2, opened: 1, clicked: 1, delayed: 1 },
    { ...zero, provider: "other", sent: 3, delivered: 3, complained: 1, complaintSent: 2 },
    {
      ...zero,
      provider: "microsoft",
      sent: 2,
      delivered: 1,
      bounced: 1,
      complained: 1,
      complaintSent: 2,
    },
    { ...zero, provider: "yahoo", sent: 2, delivered: 1, opened: 1, complaintSent: 2 },
    { ...zero, provider: "apple", sent: 1, bounced: 1 },
  ]);
});

it("reads nothing of another team's broadcast", async () => {
  expect(await broadcastProviderBreakdown(db, { teamId: otherTeamId, broadcastId })).toEqual([]);
});
