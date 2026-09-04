import { randomBytes, randomUUID } from "node:crypto";
import { EnvKeyring, encryptWebhookSecret, generateWebhookSecret, utcDay } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sweepNotifications } from "../src/handlers/notify.js";
import { createSystemMailer } from "../src/system-mail.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;
let sends: { to: string; subject: string; text: string }[];
let enqueued: string[];

const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "notify-team");
  await db.insert(schema.user).values({ id: "owner", name: "Owner", email: "owner@example.com" });
  await db.insert(schema.teamMembers).values({ teamId, userId: "owner", role: "owner" });
  const id = randomUUID();
  const secret = generateWebhookSecret();
  const encrypted = await encryptWebhookSecret(secret, keyring, { teamId, rowId: id });
  await db.insert(schema.webhookEndpoints).values({
    id,
    teamId,
    url: "https://receiver.example.com/hook",
    secretCiphertext: encrypted.ciphertext,
    secretIv: encrypted.iv,
    secretWrappedDek: encrypted.wrappedDek,
    secretKeyVersion: encrypted.keyVersion,
    secretLast4: secret.slice(-4),
    events: null,
  });
  sends = [];
  enqueued = [];
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await close();
});

const deps = (isCloud = true, now?: Date) => ({
  isCloud,
  mailer: {
    send: async (to: string, m: { subject: string; text: string }) => {
      sends.push({ to, subject: m.subject, text: m.text });
    },
  },
  enqueueWebhook: async (id: string) => {
    enqueued.push(id);
  },
  appBaseUrl: "https://app.example.test",
  ...(now ? { now } : {}),
});

async function counters(
  values: Partial<typeof schema.usageCounters.$inferInsert>,
  day = utcDay(),
  team = teamId,
) {
  await db
    .insert(schema.usageCounters)
    .values({ teamId: team, day, ...values })
    .onConflictDoUpdate({
      target: [schema.usageCounters.teamId, schema.usageCounters.day],
      set: values,
    });
}

async function deliveries() {
  return db
    .select({ type: schema.webhookDeliveries.eventType, payload: schema.webhookDeliveries.payload })
    .from(schema.webhookDeliveries);
}

it("quota warning at 80% fires once per UTC day, by email and webhook", async () => {
  await counters({ accepted: 80 });
  expect(await sweepNotifications(db, deps())).toEqual({ sent: 1 });
  expect(sends).toHaveLength(1);
  expect(sends[0]).toMatchObject({ to: "owner@example.com" });
  expect(sends[0]?.subject).toContain("80%");
  const rows = await deliveries();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.type).toBe("quota.warning");
  expect(rows[0]?.payload).toMatchObject({
    type: "quota.warning",
    data: { used: 80, limit: 100, dashboard_url: "https://app.example.test/settings/billing" },
  });
  expect(enqueued).toHaveLength(1);

  expect(await sweepNotifications(db, deps())).toEqual({ sent: 0 });
  expect(sends).toHaveLength(1);
});

it("quota reached fires once, on top of the earlier warning", async () => {
  await counters({ accepted: 80 });
  await sweepNotifications(db, deps());
  await counters({ accepted: 105 });
  expect(await sweepNotifications(db, deps())).toEqual({ sent: 1 });
  expect(sends.map((s) => s.subject)).toEqual([
    expect.stringContaining("80%"),
    expect.stringContaining("quota reached"),
  ]);
  // 105 accepted against a 150 ceiling: the mail states the real headroom.
  expect(sends[1]?.text).toContain("45 more still go out today");
  expect(sends[1]?.text).toContain("50% past the quota");
  expect((await deliveries()).map((d) => d.type)).toEqual(["quota.warning", "quota.reached"]);
  expect(await sweepNotifications(db, deps())).toEqual({ sent: 0 });
});

it("quota paused fires once when the ceiling is reached, after warning and reached", async () => {
  await counters({ accepted: 80 });
  await sweepNotifications(db, deps());
  await counters({ accepted: 100 });
  await sweepNotifications(db, deps());
  await counters({ accepted: 150 });
  expect(await sweepNotifications(db, deps())).toEqual({ sent: 1 });
  expect(sends.map((s) => s.subject)).toEqual([
    expect.stringContaining("80%"),
    expect.stringContaining("quota reached"),
    expect.stringContaining("sending paused until the quota resets"),
  ]);
  expect(sends[2]?.text).toContain("50% past its 100 quota");
  expect((await deliveries()).map((d) => d.type)).toEqual([
    "quota.warning",
    "quota.reached",
    "quota.paused",
  ]);
  expect(await sweepNotifications(db, deps())).toEqual({ sent: 0 });
});

it("self-host has no quota to notify about", async () => {
  await counters({ accepted: 100 });
  expect(await sweepNotifications(db, deps(false))).toEqual({ sent: 0 });
  expect(sends).toHaveLength(0);
});

it("deliverability pause fires once per episode and again after recovery", async () => {
  await counters({ sent: 200, complained: 3 });
  expect(await sweepNotifications(db, deps())).toEqual({ sent: 1 });
  expect(sends[0]?.subject).toContain("sending paused");
  expect(sends[0]?.text).toContain("complaint rate");
  const [row] = await deliveries();
  expect(row?.type).toBe("deliverability.paused");
  expect(row?.payload).toMatchObject({
    data: { metric: "complaint", limit: 0.001, window_days: 2 },
  });
  expect(await sweepNotifications(db, deps())).toEqual({ sent: 0 });

  // Recovery clears the episode; a new one notifies again.
  await counters({ sent: 200, complained: 0 });
  expect(await sweepNotifications(db, deps())).toEqual({ sent: 0 });
  await counters({ sent: 200, complained: 3 });
  expect(await sweepNotifications(db, deps())).toEqual({ sent: 1 });
  expect(sends).toHaveLength(2);
});

it("a quiet week ends the episode even though the team is never observed healthy", async () => {
  await counters({ sent: 200, complained: 3 });
  expect(await sweepNotifications(db, deps())).toEqual({ sent: 1 });
  // Eight days later the last sending day has left the window: no health to
  // judge, so the claims go. A fresh bad episode then notifies again.
  const later = new Date(Date.now() + 8 * 24 * 3_600_000);
  expect(await sweepNotifications(db, deps(true, later))).toEqual({ sent: 0 });
  await counters({ sent: 200, complained: 3 }, utcDay(later.getTime()));
  expect(await sweepNotifications(db, deps(true, later))).toEqual({ sent: 1 });
  expect(sends).toHaveLength(2);
});

it("hovering at the warning line is one episode; it ends only well under the line", async () => {
  await counters({ sent: 1000, hardBounced: 40 }); // 4.00%: warning
  expect(await sweepNotifications(db, deps())).toEqual({ sent: 1 });
  await counters({ sent: 1010, hardBounced: 40 }); // 3.96%: ok, but not cleared
  expect(await sweepNotifications(db, deps())).toEqual({ sent: 0 });
  await counters({ sent: 1010, hardBounced: 41 }); // 4.06%: same episode
  expect(await sweepNotifications(db, deps())).toEqual({ sent: 0 });
  await counters({ sent: 1000, hardBounced: 35 }); // 3.5% < 0.9 × 4%: episode over
  expect(await sweepNotifications(db, deps())).toEqual({ sent: 0 });
  await counters({ sent: 1000, hardBounced: 40 });
  expect(await sweepNotifications(db, deps())).toEqual({ sent: 1 });
  expect(sends).toHaveLength(2);
});

it("one team's failing mail never stops the sweep for the others", async () => {
  const other = await createTeam(db, "notify-other");
  await db.insert(schema.user).values({ id: "o2", name: "O2", email: "other@example.com" });
  await db.insert(schema.teamMembers).values({ teamId: other, userId: "o2", role: "owner" });
  await counters({ accepted: 100 });
  await counters({ accepted: 100 }, utcDay(), other);
  const flaky = {
    ...deps(),
    mailer: {
      send: async (to: string, m: { subject: string; text: string }) => {
        if (to === "owner@example.com") throw new Error("SES down");
        sends.push({ to, subject: m.subject, text: m.text });
      },
    },
  };
  await expect(sweepNotifications(db, flaky)).resolves.toEqual({ sent: 2 });
  expect(sends.map((s) => s.to)).toEqual(["other@example.com"]);
  // The first team's webhook (the only endpoint seeded) still went out.
  expect(enqueued).toHaveLength(1);
});

it("a warning that escalates to a pause notifies both once", async () => {
  await counters({ sent: 1000, hardBounced: 45 });
  await sweepNotifications(db, deps());
  expect(sends[0]?.subject).toContain("at risk");
  await counters({ sent: 1000, hardBounced: 60 });
  await sweepNotifications(db, deps());
  expect(sends.map((s) => s.subject)).toEqual([
    expect.stringContaining("at risk"),
    expect.stringContaining("sending paused"),
  ]);
  await sweepNotifications(db, deps());
  expect(sends).toHaveLength(2);
});

it("without a configured sender the mailer is a no-op", async () => {
  vi.stubEnv("NOTIFICATIONS_EMAIL_FROM", "");
  vi.stubEnv("AUTH_EMAIL_FROM", "");
  await expect(
    createSystemMailer().send("x@example.com", { subject: "s", html: "<p>h</p>", text: "t" }),
  ).resolves.toBeUndefined();
});

it("owners of the team are the recipients; members are not", async () => {
  await db.insert(schema.user).values({ id: "m", name: "M", email: "member@example.com" });
  await db.insert(schema.teamMembers).values({ teamId, userId: "m", role: "member" });
  await counters({ accepted: 100 });
  await sweepNotifications(db, deps());
  expect(sends.map((s) => s.to)).toEqual(["owner@example.com"]);
  const [team] = await db
    .select()
    .from(schema.teamNotifications)
    .where(eq(schema.teamNotifications.teamId, teamId));
  expect(team).toMatchObject({ kind: "quota.reached", periodKey: utcDay() });
});
