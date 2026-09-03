import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { runPlatformBreaker } from "../src/handlers/platform-breaker.js";

let db: Db;
let close: () => Promise<void>;
let sends: { to: string; subject: string; text: string }[];

const NOW = new Date("2026-09-03T12:00:00Z");
const mailer = {
  send: async (to: string, m: { subject: string; text: string }) => {
    sends.push({ to, subject: m.subject, text: m.text });
  },
};

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  sends = [];
  await db.insert(schema.user).values([
    { id: "op", name: "Operator", email: "op@example.com", createdAt: new Date(0) },
    { id: "later", name: "Later", email: "later@example.com", createdAt: new Date(1) },
  ]);
  const teamId = await createTeam(db, "Noisy Sender");
  const [domain] = await db
    .insert(schema.domains)
    .values({ teamId, name: "noisy.dev", region: "sa-east-1", status: "verified" })
    .returning({ id: schema.domains.id });
  if (!domain) throw new Error("seed failed");
  const sentAt = new Date(NOW.getTime() - 3_600_000);
  const rows = await db
    .insert(schema.emails)
    .values(
      Array.from({ length: 1000 }, (_, i) => ({
        teamId,
        domainId: domain.id,
        from: "f@noisy.dev",
        to: [`r${i}@b.com`],
        subject: "s",
        sentAt,
      })),
    )
    .returning({ id: schema.emails.id });
  for (const email of rows.slice(0, 5)) {
    await db.insert(schema.emailEvents).values({
      emailId: email.id,
      type: "complained",
      occurredAt: sentAt,
      createdAt: sentAt,
      snsMessageId: `sns-${email.id}`,
      data: {},
    });
  }
});
afterAll(() => close());

it("trips the region, mails the operator with the contributors, and stays quiet until it clears", async () => {
  expect(
    await runPlatformBreaker(db, { mailer, appBaseUrl: "https://app.example.test", now: NOW }),
  ).toEqual({
    tripped: ["sa-east-1"],
    resumed: [],
  });
  expect(sends).toHaveLength(1);
  expect(sends[0]).toMatchObject({ to: "op@example.com" });
  expect(sends[0]?.subject).toContain("paused in sa-east-1");
  expect(sends[0]?.text).toContain("Noisy Sender: 0 hard bounces, 5 complaints");

  expect(await runPlatformBreaker(db, { mailer, now: NOW })).toEqual({ tripped: [], resumed: [] });
  expect(sends).toHaveLength(1);

  await db.delete(schema.emailEvents).where(eq(schema.emailEvents.type, "complained"));
  expect(await runPlatformBreaker(db, { mailer, now: NOW })).toEqual({
    tripped: [],
    resumed: ["sa-east-1"],
  });
  expect(sends[1]?.subject).toContain("resumed in sa-east-1");
  expect((await db.select().from(schema.regionBreakers))[0]?.paused).toBe(false);
});
