import { randomBytes } from "node:crypto";
import { deriveUnsubscribeKey, EnvKeyring } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type BroadcastDeps, sendBroadcast } from "../src/handlers/send-broadcast.js";

let db: Db;
let close: () => Promise<void>;
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
const secretKey = deriveUnsubscribeKey(randomBytes(32));
const BASE_URL = "https://app.example.com";
const HOLD_MS = 15 * 60 * 1000;

async function seedTeam(label: string): Promise<string> {
  const teamId = await createTeam(db, label);
  await db.insert(schema.domains).values({
    teamId,
    name: `${label}.dev`,
    region: "us-east-1",
    status: "verified",
    verifiedAt: new Date(),
    sesConfigurationSet: "ms-set",
  });
  await db.insert(schema.contacts).values([
    { teamId, email: `a@${label}.example.com` },
    { teamId, email: `b@${label}.example.com` },
  ]);
  return teamId;
}

async function insertBroadcast(teamId: string, label: string): Promise<string> {
  const [row] = await db
    .insert(schema.broadcasts)
    .values({
      teamId,
      from: `${label} <hi@${label}.dev>`,
      subject: "launch",
      html: '<p>Hi</p><a href="{{{UNSUBSCRIBE_URL}}}">bye</a>',
      text: "Hi. Unsubscribe: {{{UNSUBSCRIBE_URL}}}",
      status: "scheduled",
      scheduledAt: new Date(Date.now() - 1000),
    })
    .returning({ id: schema.broadcasts.id });
  if (!row) throw new Error("broadcast insert failed");
  return row.id;
}

function makeDeps() {
  const enqueued: string[] = [];
  const rescheduled: { id: string; at: Date }[] = [];
  const deps: BroadcastDeps = {
    keyring,
    unsubscribeSecretKey: secretKey,
    unsubscribeBaseUrl: BASE_URL,
    isCloud: false,
    enqueueEmailSends: async (batch) => {
      for (const job of batch) enqueued.push(job.emailId);
    },
    reschedule: async (id, at) => {
      rescheduled.push({ id, at });
    },
  };
  return { deps, enqueued, rescheduled };
}

const emailsOf = (broadcastId: string) =>
  db.select().from(schema.emails).where(eq(schema.emails.broadcastId, broadcastId));

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

it.each([
  ["suspended", { suspendedAt: new Date(), suspensionReason: "manual" as const }],
  ["paused by the operator", { broadcastsPausedByOperatorAt: new Date() }],
])(
  "a team %s defers the fan-out about 15 minutes, then sends once cleared",
  async (label, hold) => {
    const slug = label.replace(/\W+/g, "-");
    const teamId = await seedTeam(slug);
    const broadcastId = await insertBroadcast(teamId, slug);
    await db.update(schema.teams).set(hold).where(eq(schema.teams.id, teamId));
    const { deps, enqueued, rescheduled } = makeDeps();

    const before = Date.now();
    expect(await sendBroadcast(db, deps, { broadcastId })).toBe("deferred");
    expect(rescheduled).toHaveLength(1);
    expect(rescheduled[0]?.id).toBe(broadcastId);
    const delay = (rescheduled[0]?.at.getTime() ?? 0) - before;
    expect(delay).toBeGreaterThanOrEqual(HOLD_MS - 5_000);
    expect(delay).toBeLessThanOrEqual(HOLD_MS + 5_000);
    expect(await emailsOf(broadcastId)).toEqual([]);
    expect(enqueued).toEqual([]);
    const [held] = await db
      .select({ status: schema.broadcasts.status })
      .from(schema.broadcasts)
      .where(eq(schema.broadcasts.id, broadcastId));
    expect(held?.status).toBe("scheduled");

    await db
      .update(schema.teams)
      .set({ suspendedAt: null, suspensionReason: null, broadcastsPausedByOperatorAt: null })
      .where(eq(schema.teams.id, teamId));
    expect(await sendBroadcast(db, deps, { broadcastId })).toBe("sent");
    expect(await emailsOf(broadcastId)).toHaveLength(2);
    expect(enqueued).toHaveLength(2);
    expect(rescheduled).toHaveLength(1);
  },
);

it("a suspension landing mid-walk stops the fan-out at the page edge; the resumed walk sends the rest once", async () => {
  const teamId = await seedTeam("mid-walk");
  const broadcastId = await insertBroadcast(teamId, "mid-walk");
  const { deps, enqueued, rescheduled } = makeDeps();
  const paged: BroadcastDeps = {
    ...deps,
    batchSize: 1,
    enqueueEmailSends: async (batch) => {
      await deps.enqueueEmailSends(batch);
      // The operator suspends the team once the first page is out.
      await db
        .update(schema.teams)
        .set({ suspendedAt: new Date(), suspensionReason: "manual" })
        .where(eq(schema.teams.id, teamId));
    },
  };
  expect(await sendBroadcast(db, paged, { broadcastId })).toBe("deferred");
  expect(enqueued).toHaveLength(1);
  expect(rescheduled).toHaveLength(1);
  const [held] = await db
    .select({ status: schema.broadcasts.status })
    .from(schema.broadcasts)
    .where(eq(schema.broadcasts.id, broadcastId));
  expect(held?.status).toBe("sending");

  await db
    .update(schema.teams)
    .set({ suspendedAt: null, suspensionReason: null })
    .where(eq(schema.teams.id, teamId));
  expect(await sendBroadcast(db, deps, { broadcastId })).toBe("sent");
  expect(await emailsOf(broadcastId)).toHaveLength(2);
  expect(enqueued).toHaveLength(2);
});
