import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { afterAll, beforeAll, expect, it } from "vitest";
import { sesEventsHealth } from "../src/events-health.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;
let judgedEmailId: string;

const NOW = new Date("2026-09-03T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "events-health-team");
});
afterAll(() => close());

async function insertSent(sentAt: Date): Promise<string> {
  const [row] = await db
    .insert(schema.emails)
    .values({ teamId, from: "f@a.com", to: ["t@b.com"], subject: "s", sentAt })
    .returning({ id: schema.emails.id });
  if (!row) throw new Error("seed failed");
  return row.id;
}

it("is idle with nothing sent, and a send too fresh to judge stays idle", async () => {
  expect(await sesEventsHealth(db, NOW)).toEqual({
    status: "idle",
    sentInWindow: 0,
    lastSesEventAt: null,
  });
  await insertSent(minutesAgo(2));
  expect((await sesEventsHealth(db, NOW)).status).toBe("idle");
});

it("is unhealthy once a send is old enough and SES reported nothing back", async () => {
  const emailId = await insertSent(minutesAgo(30));
  judgedEmailId = emailId;
  // A worker-originated event (no SNS id) does not count as SES answering.
  await db
    .insert(schema.emailEvents)
    .values({ emailId, type: "sent", occurredAt: minutesAgo(30), createdAt: minutesAgo(30) });
  const health = await sesEventsHealth(db, NOW);
  expect(health.status).toBe("unhealthy");
  expect(health.sentInWindow).toBe(1);
  expect(health.lastSesEventAt).toBeNull();
});

it("is healthy once an SES-originated event lands in the window", async () => {
  await db.insert(schema.emailEvents).values({
    emailId: judgedEmailId,
    type: "delivered",
    occurredAt: minutesAgo(20),
    createdAt: minutesAgo(20),
    snsMessageId: "sns-1",
  });
  const health = await sesEventsHealth(db, NOW);
  expect(health.status).toBe("healthy");
  expect(health.lastSesEventAt?.toISOString()).toBe(minutesAgo(20).toISOString());
});
