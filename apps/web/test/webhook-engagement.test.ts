import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordEngagement } from "@/app/t/record";

// recordEngagement only reads endpoint id/events/teamId/status — the encrypted
// secret is never touched here, so dummy bytea fills the not-null columns.
const DUMMY = Buffer.alloc(1);

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});

afterEach(async () => {
  await close();
});

async function seedEmail(teamId: string): Promise<string> {
  const [email] = await db
    .insert(schema.emails)
    .values({ teamId, from: "s@example.com", to: ["r@example.com"], subject: "Hi" })
    .returning({ id: schema.emails.id });
  return email?.id ?? "";
}

async function seedEndpoint(teamId: string, events: string[] | null): Promise<string> {
  const [row] = await db
    .insert(schema.webhookEndpoints)
    .values({
      teamId,
      url: "https://hook.example.com/in",
      secretCiphertext: DUMMY,
      secretIv: DUMMY,
      secretWrappedDek: DUMMY,
      secretKeyVersion: 1,
      secretLast4: "abcd",
      events,
    })
    .returning({ id: schema.webhookEndpoints.id });
  return row?.id ?? "";
}

async function deliveries(endpointId: string) {
  return db
    .select({ id: schema.webhookDeliveries.id, eventType: schema.webhookDeliveries.eventType })
    .from(schema.webhookDeliveries)
    .where(eq(schema.webhookDeliveries.endpointId, endpointId));
}

describe("recordEngagement webhook fan-out", () => {
  it("fans an open out to a subscribed endpoint and enqueues the delivery", async () => {
    const teamId = await createTeam(db);
    const emailId = await seedEmail(teamId);
    const endpointId = await seedEndpoint(teamId, ["email.opened"]);
    const enqueued: string[] = [];

    await recordEngagement(db, emailId, "opened", async (id) => {
      enqueued.push(id);
    });

    const rows = await deliveries(endpointId);
    expect(rows.map((r) => r.eventType)).toEqual(["email.opened"]);
    expect(enqueued).toEqual([rows[0]?.id]);
  });

  it("fans a click out as email.clicked", async () => {
    const teamId = await createTeam(db);
    const emailId = await seedEmail(teamId);
    const endpointId = await seedEndpoint(teamId, ["email.clicked"]);

    await recordEngagement(db, emailId, "clicked");

    const rows = await deliveries(endpointId);
    expect(rows.map((r) => r.eventType)).toEqual(["email.clicked"]);
  });

  it("does not re-deliver on a second open inside the damping window", async () => {
    const teamId = await createTeam(db);
    const emailId = await seedEmail(teamId);
    const endpointId = await seedEndpoint(teamId, null); // null = all events

    await recordEngagement(db, emailId, "opened");
    await recordEngagement(db, emailId, "opened");

    expect(await deliveries(endpointId)).toHaveLength(1);
  });

  it("delivers once per recorded event — a repeat open past the damping window fans out again", async () => {
    const teamId = await createTeam(db);
    const emailId = await seedEmail(teamId);
    const endpointId = await seedEndpoint(teamId, ["email.opened"]);

    await recordEngagement(db, emailId, "opened");
    await db
      .update(schema.emailEvents)
      .set({ occurredAt: new Date(Date.now() - 120_000) })
      .where(and(eq(schema.emailEvents.emailId, emailId), eq(schema.emailEvents.type, "opened")));
    await recordEngagement(db, emailId, "opened");

    expect(await deliveries(endpointId)).toHaveLength(2);
  });

  it("does not deliver an unsubscribed event type", async () => {
    const teamId = await createTeam(db);
    const emailId = await seedEmail(teamId);
    const endpointId = await seedEndpoint(teamId, ["email.clicked"]);

    await recordEngagement(db, emailId, "opened");

    expect(await deliveries(endpointId)).toHaveLength(0);
  });

  it("isolates teams — team B's endpoint never sees team A's open", async () => {
    const teamA = await createTeam(db, "team-a");
    const teamB = await createTeam(db, "team-b");
    const emailA = await seedEmail(teamA);
    const endpointB = await seedEndpoint(teamB, ["email.opened"]);

    await recordEngagement(db, emailA, "opened");

    expect(await deliveries(endpointB)).toHaveLength(0);
    // The event still recorded for team A's email.
    const [ev] = await db
      .select({ id: schema.emailEvents.id })
      .from(schema.emailEvents)
      .where(and(eq(schema.emailEvents.emailId, emailA), eq(schema.emailEvents.type, "opened")));
    expect(ev).toBeTruthy();
  });
});
