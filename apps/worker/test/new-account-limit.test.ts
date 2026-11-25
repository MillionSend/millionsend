import { type QueuedWebhookDelivery, setTeamLimitBypass } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb, readable } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { drainQuotaParked } from "../src/handlers/cron.js";
import { sweepNotifications } from "../src/handlers/notify.js";

const NOW = new Date("2026-10-20T18:00:00Z");

let db: Db;
let close: () => Promise<void>;
let teamId: string;

beforeEach(async () => {
  vi.stubEnv("IS_CLOUD", "true");
  ({ db, close } = await createTestDb());
  await db
    .insert(schema.instanceSettings)
    .values({ id: 1, newAccountFirstDay: 2, newAccountDaily: 5, newAccountDays: 7 });
  await db
    .insert(schema.user)
    .values({ id: "op", name: "Operator", email: "op@example.com", createdAt: new Date(0) });
  teamId = await createTeam(db, "fresh-team");
  await db
    .update(schema.teams)
    .set({ plan: "pro", planQuota: 100_000 })
    .where(eq(schema.teams.id, teamId));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await close();
});

async function park(n: number, perRow = 1): Promise<string[]> {
  const rows = await db
    .insert(schema.emails)
    .values(
      Array.from({ length: n }, (_, i) => ({
        teamId,
        from: "a@example.com",
        to: Array.from({ length: perRow }, (_, j) => `r${i}-${j}@example.com`),
        subject: "s",
        latestStatus: "queued_quota" as const,
        parkReason: "new_account" as const,
        createdAt: new Date(NOW.getTime() - (n - i) * 60_000),
      })),
    )
    .returning({ id: schema.emails.id });
  return rows.map((r) => r.id);
}

const drain = () => drainQuotaParked(db, { isCloud: true, now: NOW, enqueueSends: async () => {} });

it("drains new-account mail only as the window allows, and all of it once bypassed", async () => {
  await park(4);
  expect(await drain()).toMatchObject({ drained: 2 });
  expect(await drain()).toMatchObject({ drained: 0 });
  await setTeamLimitBypass(db, { teamId, by: "op", reason: "known", until: null, now: NOW });
  expect(await drain()).toEqual({ drained: 2, stillParked: 0 });
});

it("gates every release, whatever parked the row", async () => {
  const [a, b, c] = await park(3);
  if (!a || !b || !c) throw new Error("seed failed");
  await db.update(schema.emails).set({ parkReason: null }).where(eq(schema.emails.teamId, teamId));
  expect(await drain()).toMatchObject({ drained: 2 });
});

it("sends an email over the whole cap alone in an untouched window, and drains smaller mail past it", async () => {
  const [big] = await park(1, 5);
  expect(await drain()).toMatchObject({ drained: 1 });
  const [big2] = await park(1, 5);
  const small = await park(1);
  await db
    .update(schema.teamNewAccountUsage)
    .set({ accepted: 1 })
    .where(eq(schema.teamNewAccountUsage.teamId, teamId));
  expect(await drain()).toEqual({ drained: 1, stillParked: 1 });
  const rows = await db
    .select({ id: schema.emails.id, status: schema.emails.latestStatus })
    .from(schema.emails)
    .where(eq(schema.emails.teamId, teamId));
  const status = new Map(rows.map((r) => [r.id, r.status]));
  expect(status.get(big ?? "")).toBe("queued");
  expect(status.get(big2 ?? "")).toBe("queued_quota");
  expect(status.get(small[0] ?? "")).toBe("queued");
});

it("tells the operator once when a team's mail first waits for the limit", async () => {
  await park(1);
  const sends: { to: string; subject: string; text: string }[] = [];
  const sweep = () =>
    sweepNotifications(db, {
      isCloud: true,
      mailer: {
        send: async (to, m) => {
          sends.push({ to, subject: m.subject, text: readable(m.text) });
        },
      },
      enqueueWebhook: async (_rows: readonly QueuedWebhookDelivery[]) => {},
      appBaseUrl: "https://app.example.test",
      now: NOW,
    });
  await sweep();
  await park(1);
  await sweep();
  const alerts = sends.filter((s) => s.subject.includes("new-account limit"));
  expect(alerts).toHaveLength(1);
  expect(alerts[0]?.to).toBe("op@example.com");
  expect(alerts[0]?.text).toContain("fresh-team");
  expect(alerts[0]?.text).toContain(`https://app.example.test/console/safety/${teamId}`);
});
