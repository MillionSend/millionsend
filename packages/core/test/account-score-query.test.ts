import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fetchAccountScoreInput, fetchContentFactors } from "../src/account-score.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;

const now = new Date("2026-09-04T12:00:00Z");
const inWindow = new Date("2026-09-01T00:00:00Z");
const beforeWindow = new Date("2026-07-01T00:00:00Z");

const fail = (id: string, penaltyHundredths: number) => ({
  id,
  severity: "major" as const,
  status: "fail" as const,
  penaltyHundredths,
});
const pass = {
  id: "alt_text",
  severity: "minor" as const,
  status: "pass" as const,
  penaltyHundredths: 0,
};

async function insertEmail(row: {
  teamId: string;
  to: string[];
  sentAt: Date;
  broadcastId?: string;
}): Promise<string> {
  const [email] = await db
    .insert(schema.emails)
    .values({ ...row, from: "f@a.com", subject: "s", createdAt: row.sentAt })
    .returning({ id: schema.emails.id });
  if (!email) throw new Error("seed failed");
  return email.id;
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "score-team");
  const otherTeamId = await createTeam(db, "other-team");

  // API sends: one scored in the window (2 recipients), one scored but stale,
  // one in the window with no insights row.
  const scored = await insertEmail({ teamId, to: ["a@b.com", "c@d.com"], sentAt: inWindow });
  const stale = await insertEmail({ teamId, to: ["a@b.com"], sentAt: beforeWindow });
  await insertEmail({ teamId, to: ["a@b.com"], sentAt: inWindow });
  const foreign = await insertEmail({ teamId: otherTeamId, to: ["a@b.com"], sentAt: inWindow });

  // One broadcast: three fan-out emails in the window plus one stale one,
  // all sharing the broadcast-keyed insights row.
  const [broadcast] = await db
    .insert(schema.broadcasts)
    .values({ teamId, from: "f@a.com", subject: "s" })
    .returning({ id: schema.broadcasts.id });
  if (!broadcast) throw new Error("seed failed");
  for (let n = 0; n < 3; n++) {
    await insertEmail({ teamId, to: [`r${n}@b.com`], sentAt: inWindow, broadcastId: broadcast.id });
  }
  await insertEmail({ teamId, to: ["old@b.com"], sentAt: beforeWindow, broadcastId: broadcast.id });

  await db.insert(schema.emailInsights).values([
    {
      teamId,
      emailId: scored,
      marketing: false,
      checks: [fail("no_plain_text", 50), pass],
      scoreTenths: 90,
      scoreVersion: 1,
    },
    {
      teamId,
      emailId: stale,
      marketing: false,
      checks: [fail("no_plain_text", 50)],
      scoreTenths: 10,
      scoreVersion: 1,
    },
    {
      teamId: otherTeamId,
      emailId: foreign,
      marketing: false,
      checks: [fail("no_plain_text", 50)],
      scoreTenths: 10,
      scoreVersion: 1,
    },
    {
      teamId,
      broadcastId: broadcast.id,
      marketing: true,
      checks: [fail("no_plain_text", 30), fail("missing_unsubscribe", 20), pass],
      scoreTenths: 60,
      scoreVersion: 1,
    },
  ]);
});

afterAll(() => close());

it("weights the content sub-score by recipients across API sends and fan-out emails", async () => {
  const input = await fetchAccountScoreInput(db, teamId, { now });
  // 90 × 2 recipients + 60 × 3 fan-out recipients; stale, unscored and foreign rows excluded.
  expect(input.contentWeightedTenths).toBe(90 * 2 + 60 * 3);
  expect(input.contentRecipients).toBe(5);
});

it("aggregates failing checks over the same population, heaviest first", async () => {
  const factors = await fetchContentFactors(db, teamId, { now });
  expect(factors).toEqual([
    {
      id: "no_plain_text",
      severity: "major",
      emails: 4,
      recipients: 5,
      weightedPenaltyHundredths: 50 * 2 + 30 * 3,
    },
    {
      id: "missing_unsubscribe",
      severity: "major",
      emails: 3,
      recipients: 3,
      weightedPenaltyHundredths: 20 * 3,
    },
  ]);
});
