import { randomUUID } from "node:crypto";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb, createWebhookEndpoint } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordInboxActivity } from "../src/inboxes/activity.js";
import { inboxDeletedEvent, inboxEvent } from "../src/inboxes/events.js";
import { expiresInMs, inboxCreatesLeft, inboxRoom } from "../src/inboxes/limits.js";
import { defaultSafety } from "../src/inboxes/safety.js";
import { inboxWire } from "../src/inboxes/wire.js";
import { enqueueTeamWebhookEvents } from "../src/webhooks.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;
let domainId: string;

const NOW = new Date("2026-10-12T12:00:00Z");
const HOUR = 3_600_000;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "inboxes-db");
  const [domain] = await db
    .insert(schema.domains)
    .values({ teamId, name: "inbound.acme.test", region: "us-east-1", status: "verified" })
    .returning({ id: schema.domains.id });
  if (!domain) throw new Error("no domain");
  domainId = domain.id;
});
afterAll(() => close());

async function addInbox(local: string, expiresAt: Date | null = null): Promise<string> {
  const [row] = await db
    .insert(schema.inboxes)
    .values({
      teamId,
      kind: "agent",
      emailAddress: `${local}@inbound.acme.test`,
      localPart: local,
      domainId,
      name: local,
      safety: defaultSafety("agent", false),
      expiresAt,
    })
    .returning({ id: schema.inboxes.id });
  if (!row) throw new Error("no inbox");
  return row.id;
}

describe("inboxRoom", () => {
  it("counts live inboxes against the plan cap; expired ones free their seat", async () => {
    expect(await inboxRoom(db, teamId, "free", true, NOW)).toBe(3);
    await addInbox("a");
    await addInbox("b");
    await addInbox("gone", new Date(NOW.getTime() - HOUR));
    expect(await inboxRoom(db, teamId, "free", true, NOW)).toBe(1);
    expect(await inboxRoom(db, teamId, "starter", true, NOW)).toBe(23);
    await addInbox("c");
    await addInbox("d");
    expect(await inboxRoom(db, teamId, "free", true, NOW)).toBe(0);
  });

  it("caps nothing on unlimited plans or off Cloud", async () => {
    expect(await inboxRoom(db, teamId, "pro", true, NOW)).toBeNull();
    expect(await inboxRoom(db, teamId, "scale", true, NOW)).toBeNull();
    expect(await inboxRoom(db, teamId, "system", true, NOW)).toBeNull();
    expect(await inboxRoom(db, teamId, "free", false, NOW)).toBeNull();
  });
});

describe("inboxCreatesLeft", () => {
  it("counts the last hour's inbox.created rows, deleted inboxes included", async () => {
    const team = await createTeam(db, "creates");
    const actor = { kind: "system" as const };
    const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000);
    for (const minutesAgo of [50, 20, 5, 90]) {
      await db.insert(schema.inboxActivity).values({
        teamId: team,
        inboxId: randomUUID(),
        actor: "system",
        action: "inbox.created",
        createdAt: at(minutesAgo),
      });
    }
    await recordInboxActivity(db, {
      teamId: team,
      inboxId: randomUUID(),
      actor,
      action: "inbox.deleted",
    });
    // 3 inside the hour; the oldest of them (50 min ago) frees a slot in 10 minutes.
    expect(await inboxCreatesLeft(db, team, "free", true, NOW)).toEqual({
      left: 7,
      retryAfterSec: 600,
    });
    expect(await inboxCreatesLeft(db, team, "pro", true, NOW)).toMatchObject({ left: 597 });
    expect(await inboxCreatesLeft(db, team, "system", true, NOW)).toBeNull();
    expect(await inboxCreatesLeft(db, team, "free", false, NOW)).toBeNull();
  });
});

describe("expiresInMs", () => {
  it("reads hours and days, 1 to 9999 of them", () => {
    expect(expiresInMs("1h")).toBe(HOUR);
    expect(expiresInMs("24h")).toBe(24 * HOUR);
    expect(expiresInMs("30d")).toBe(30 * 24 * HOUR);
    expect(expiresInMs("9999d")).toBe(9999 * 24 * HOUR);
    for (const bad of ["0h", "01h", "10000h", "1w", "h", "1.5h", " 1h", "1H"]) {
      expect(expiresInMs(bad), bad).toBeNull();
    }
  });
});

describe("recordInboxActivity", () => {
  it("commits with the caller's transaction and rolls back with it", async () => {
    const inboxId = await addInbox("activity");
    const actor = { kind: "oauth" as const, userId: "u1", clientId: "client-1" };
    await db.transaction(async (tx) => {
      await recordInboxActivity(tx as unknown as Db, {
        teamId,
        inboxId,
        actor,
        action: "code.read",
        emailId: randomUUID(),
        decision: { result: "send", reasons: [] },
      });
    });
    await expect(
      db.transaction(async (tx) => {
        await recordInboxActivity(tx as unknown as Db, {
          teamId,
          inboxId,
          actor,
          action: "email.sent",
        });
        throw new Error("the send failed");
      }),
    ).rejects.toThrow("the send failed");
    const rows = await db
      .select()
      .from(schema.inboxActivity)
      .where(eq(schema.inboxActivity.inboxId, inboxId));
    expect(rows).toEqual([
      expect.objectContaining({
        actor: "oauth:client-1:u1",
        action: "code.read",
        decision: { result: "send", reasons: [] },
        threadId: null,
        draftId: null,
      }),
    ]);
  });
});

describe("inbox events and endpoint inbox filters", () => {
  it("reach unfiltered endpoints and those naming the inbox; never all-events endpoints", async () => {
    const team = await createTeam(db, "hooks");
    const allEvents = await createWebhookEndpoint(db, team, null);
    const optedIn = await createWebhookEndpoint(db, team, ["inbox.created", "inbox.deleted"]);
    const filtered = await createWebhookEndpoint(db, team, ["inbox.created", "inbox.deleted"]);
    const inboxId = randomUUID();
    await db
      .update(schema.webhookEndpoints)
      .set({ inboxIds: [randomUUID()] })
      .where(eq(schema.webhookEndpoints.id, filtered));
    const inbox = inboxWire(
      {
        id: inboxId,
        kind: "agent",
        name: "Signup bot",
        emailAddress: "bot@inbound.acme.test",
        domainId,
        sharedDomainId: null,
        receivingAddress: null,
        fromName: null,
        expiresAt: null,
        createdAt: NOW,
      },
      { unread: 0, drafts: 0, quarantined: 0, pendingApproval: 0, lastReceived: null },
    );
    await enqueueTeamWebhookEvents(db, {
      teamId: team,
      events: [
        inboxEvent("inbox.created", { source: "api", inbox, occurredAt: NOW }),
        inboxDeletedEvent({ source: "dashboard", inboxId, occurredAt: NOW }),
      ],
      enqueue: async () => {},
    });
    const rows = await db.select().from(schema.webhookDeliveries);
    expect(rows.map((r) => [r.endpointId, r.eventType]).sort()).toEqual(
      [
        [optedIn, "inbox.created"],
        [optedIn, "inbox.deleted"],
      ].sort(),
    );
    expect(rows.map((r) => r.endpointId)).not.toContain(allEvents);
    for (const row of rows) {
      expect(Object.keys(row.payload).sort()).toEqual(["created_at", "data", "type"]);
      expect(JSON.stringify(row.payload)).not.toContain("inboxIds");
    }
    const created = rows.find((r) => r.eventType === "inbox.created");
    expect(created?.payload.data).toEqual({ source: "api", inbox_id: inboxId, inbox });

    await db
      .update(schema.webhookEndpoints)
      .set({ inboxIds: [inboxId] })
      .where(eq(schema.webhookEndpoints.id, filtered));
    await enqueueTeamWebhookEvents(db, {
      teamId: team,
      events: [inboxDeletedEvent({ source: "api", inboxId, occurredAt: NOW })],
      enqueue: async () => {},
    });
    const toFiltered = await db
      .select()
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.endpointId, filtered));
    expect(toFiltered.map((r) => r.eventType)).toEqual(["inbox.deleted"]);
  });

  it("ignore the inbox filter for events about no inbox", async () => {
    const team = await createTeam(db, "hooks-2");
    const filtered = await createWebhookEndpoint(db, team, ["quota.warning"]);
    await db
      .update(schema.webhookEndpoints)
      .set({ inboxIds: [randomUUID()] })
      .where(eq(schema.webhookEndpoints.id, filtered));
    await enqueueTeamWebhookEvents(db, {
      teamId: team,
      events: [{ type: "quota.warning", occurredAt: NOW, data: {} }],
      enqueue: async () => {},
    });
    const rows = await db
      .select()
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.endpointId, filtered));
    expect(rows).toHaveLength(1);
  });
});
