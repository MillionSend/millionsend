import { randomBytes } from "node:crypto";
import {
  deriveUnsubscribeKey,
  EnvKeyring,
  MONITOR_SETTING_DEFAULTS,
  type MonitorDeps,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type BroadcastDeps, sendBroadcast } from "../src/handlers/send-broadcast.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "bcast");
  await db.insert(schema.domains).values({
    teamId,
    name: "bcast.dev",
    region: "us-east-1",
    status: "verified",
    verifiedAt: new Date(),
  });
  await db.insert(schema.contacts).values([
    { teamId, email: "a@example.com" },
    { teamId, email: "b@example.com" },
    { teamId, email: "c@example.com" },
    { teamId, email: "gone@example.com", unsubscribed: true },
  ]);
});
afterAll(() => close());

// The draw alone, with the hold (and the screening it turns on for a new
// team) off; send-broadcast-screening.test.ts covers the screening.
const DRAW_ONLY = { ...MONITOR_SETTING_DEFAULTS, autoHold: false };

it("samples the skeleton once and the rendered copies by the keyed draw", async () => {
  const queued: string[] = [];
  const monitor: MonitorDeps = {
    samplingKey: Buffer.alloc(32, 7),
    settings: async () => DRAW_ONLY,
    enqueueJudge: async (id) => void queued.push(id),
  };
  const deps: BroadcastDeps = {
    keyring,
    unsubscribeSecretKey: deriveUnsubscribeKey(randomBytes(32)),
    unsubscribeBaseUrl: "https://app.example.com",
    isCloud: false,
    enqueueEmailSends: async () => {},
    batchSize: 2,
    monitor,
  };
  const [broadcast] = await db
    .insert(schema.broadcasts)
    .values({
      teamId,
      from: "B <hi@bcast.dev>",
      subject: "news",
      html: "<p>Hi</p>",
      status: "scheduled",
    })
    .returning({ id: schema.broadcasts.id });
  const broadcastId = broadcast?.id ?? "";
  expect(await sendBroadcast(db, deps, { broadcastId })).toBe("sent");
  const samples = await db
    .select()
    .from(schema.monitorSamples)
    .where(eq(schema.monitorSamples.broadcastId, broadcastId));
  const skeletons = samples.filter((s) => s.kind === "broadcast_skeleton");
  const copies = samples.filter((s) => s.kind === "broadcast_copy");
  expect(skeletons).toHaveLength(1);
  expect(skeletons[0]).toMatchObject({ teamId, emailId: null, status: "pending" });
  // A new team wants ten copies of a three-recipient audience: every rendered row is drawn.
  expect(copies).toHaveLength(3);
  expect(new Set(copies.map((c) => c.emailId)).size).toBe(3);
  expect(queued.sort()).toEqual(samples.map((s) => s.id).sort());
  // The monitor never counted these as sends: that happens when each row goes out.
  expect(await db.select().from(schema.teamMonitor)).toMatchObject([{ teamId, sentTotal: 0 }]);

  // A re-run of the fan-out (reconcile) adds no second skeleton and no copy for rows already there.
  await db
    .update(schema.broadcasts)
    .set({ status: "sending" })
    .where(eq(schema.broadcasts.id, broadcastId));
  expect(await sendBroadcast(db, deps, { broadcastId })).toBe("sent");
  expect(
    await db
      .select()
      .from(schema.monitorSamples)
      .where(eq(schema.monitorSamples.broadcastId, broadcastId)),
  ).toHaveLength(4);
});

it("fails the fan-out while the monitor fails, writing no row to go out unscreened", async () => {
  const monitor: MonitorDeps = {
    samplingKey: Buffer.alloc(32, 7),
    settings: async () => {
      throw new Error("down");
    },
    enqueueJudge: async () => {},
  };
  const enqueued: string[] = [];
  const deps: BroadcastDeps = {
    keyring,
    unsubscribeSecretKey: deriveUnsubscribeKey(randomBytes(32)),
    unsubscribeBaseUrl: "https://app.example.com",
    isCloud: false,
    enqueueEmailSends: async (batch) => void enqueued.push(...batch.map((b) => b.emailId)),
    monitor,
  };
  const [broadcast] = await db
    .insert(schema.broadcasts)
    .values({
      teamId,
      from: "B <hi@bcast.dev>",
      subject: "again",
      html: "<p>Hi</p>",
      status: "scheduled",
    })
    .returning({ id: schema.broadcasts.id });
  const broadcastId = broadcast?.id ?? "";
  await expect(sendBroadcast(db, deps, { broadcastId })).rejects.toThrow("down");
  expect(enqueued).toEqual([]);
  expect(
    await db.select().from(schema.emails).where(eq(schema.emails.broadcastId, broadcastId)),
  ).toEqual([]);
});

it("counts the audience with the topic rule so an opt-in topic still gets its copies", async () => {
  const queued: string[] = [];
  const monitor: MonitorDeps = {
    samplingKey: Buffer.alloc(32, 7),
    settings: async () => ({ ...DRAW_ONLY, broadcastCopiesNew: 1 }),
    enqueueJudge: async (id) => void queued.push(id),
  };
  const [topic] = await db
    .insert(schema.topics)
    .values({ teamId, name: "Opt-in", defaultSubscribed: false })
    .returning({ id: schema.topics.id });
  const [subscriber] = await db
    .select({ id: schema.contacts.id })
    .from(schema.contacts)
    .where(eq(schema.contacts.email, "b@example.com"));
  await db
    .insert(schema.contactTopicSubscriptions)
    .values({ contactId: subscriber?.id ?? "", topicId: topic?.id ?? "", subscribed: true });
  const deps: BroadcastDeps = {
    keyring,
    unsubscribeSecretKey: deriveUnsubscribeKey(randomBytes(32)),
    unsubscribeBaseUrl: "https://app.example.com",
    isCloud: false,
    enqueueEmailSends: async () => {},
    monitor,
  };
  const [broadcast] = await db
    .insert(schema.broadcasts)
    .values({
      teamId,
      topicId: topic?.id,
      from: "B <hi@bcast.dev>",
      subject: "opt-in",
      html: "<p>Hi</p>",
      status: "scheduled",
    })
    .returning({ id: schema.broadcasts.id });
  expect(await sendBroadcast(db, deps, { broadcastId: broadcast?.id ?? "" })).toBe("sent");
  const samples = await db
    .select()
    .from(schema.monitorSamples)
    .where(eq(schema.monitorSamples.broadcastId, broadcast?.id ?? ""));
  // One subscriber, one copy wanted: the audience is 1, so the one row is drawn.
  expect(samples.filter((s) => s.kind === "broadcast_copy")).toHaveLength(1);
  expect(samples.filter((s) => s.kind === "broadcast_skeleton")).toHaveLength(1);
});
