import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb, readable } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { alertSendBursts } from "../src/handlers/send-bursts.js";

const NOW = new Date("2026-10-20T18:30:00Z");
const HOUR_MS = 3600_000;

let db: Db;
let close: () => Promise<void>;
const mails: { to: string; subject: string; text: string }[] = [];
const run = () =>
  alertSendBursts(db, {
    mailer: {
      send: async (to, m) => {
        mails.push({ to, subject: m.subject, text: readable(m.text) });
      },
    },
    appBaseUrl: "https://app.example.test",
    now: NOW,
  });

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await db.insert(schema.instanceSettings).values({
    id: 1,
    burstMinSent: 30,
    burstWindowHours: 3,
    burstTeamAgeDays: 2,
    burstSingleShare: 0.75,
    burstProviderShare: 0.5,
  });
  await db
    .insert(schema.user)
    .values({ id: "op", name: "Operator", email: "op@example.com", createdAt: new Date(0) });
});
afterAll(() => close());

/** A team created `ageHours` ago that sent one email per recipient list in the last hour. */
async function sender(name: string, ageHours: number, recipients: (i: number) => string[]) {
  const teamId = await createTeam(db, name);
  await db
    .update(schema.teams)
    .set({ createdAt: new Date(NOW.getTime() - ageHours * HOUR_MS) })
    .where(eq(schema.teams.id, teamId));
  const n = 40;
  await db.insert(schema.emails).values(
    Array.from({ length: n }, (_, i) => ({
      teamId,
      from: "a@example.com",
      to: recipients(i),
      subject: "s",
      latestStatus: "sent" as const,
      createdAt: new Date(NOW.getTime() - HOUR_MS + i * 1000),
      sentAt: new Date(NOW.getTime() - HOUR_MS + i * 1000),
    })),
  );
  await db
    .insert(schema.usageCountersHourly)
    .values({ teamId, hour: new Date("2026-10-20T17:00:00Z"), sent: n });
  return teamId;
}

it("alerts once on a young team's single-recipient burst to one provider family", async () => {
  const teamId = await sender("burst-team", 3, (i) => [`r${i}@${i % 2 ? "mail.ru" : "bk.ru"}`]);
  await sender("old-team", 72, (i) => [`r${i}@mail.ru`]);
  await sender("mixed-team", 3, (i) => [`r${i}@domain${i}.example`]);
  await sender("group-team", 3, (i) => [`r${i}@mail.ru`, `s${i}@mail.ru`]);
  expect(await run()).toBe(1);
  expect(mails).toHaveLength(1);
  expect(mails[0]?.to).toBe("op@example.com");
  expect(mails[0]?.text).toContain("burst-team");
  expect(mails[0]?.text).toContain("mail.ru");
  expect(mails[0]?.text).toContain(`https://app.example.test/console/safety/${teamId}`);
  expect(await run()).toBe(0);
});

it("leaves out a team an operator vouched for", async () => {
  const teamId = await sender("vouched-team", 3, (i) => [`r${i}@yandex.ru`]);
  await db.insert(schema.teamMonitor).values({ teamId, vouchedAt: NOW, vouchUntil: null });
  expect(await run()).toBe(0);
});

it("is off while the minimum is zero", async () => {
  await sender("quiet-team", 3, (i) => [`r${i}@yandex.ru`]);
  await db.update(schema.instanceSettings).set({ burstMinSent: 0 });
  expect(await run()).toBe(0);
  await db.update(schema.instanceSettings).set({ burstMinSent: 30 });
  expect(await run()).toBe(1);
});
