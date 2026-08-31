import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fetchEmailInsights } from "../src/email-insights-lookup.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;
let otherTeamId: string;
let emailId: string;
let broadcastEmailId: string;
let broadcastId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "insights-team");
  otherTeamId = await createTeam(db, "other-team");

  const [apiEmail] = await db
    .insert(schema.emails)
    .values({ teamId, from: "f@a.com", to: ["t@b.com"], subject: "s" })
    .returning({ id: schema.emails.id });
  const [broadcast] = await db
    .insert(schema.broadcasts)
    .values({ teamId, from: "f@a.com", subject: "s" })
    .returning({ id: schema.broadcasts.id });
  if (!apiEmail || !broadcast) throw new Error("seed failed");
  emailId = apiEmail.id;
  broadcastId = broadcast.id;
  const [fanout] = await db
    .insert(schema.emails)
    .values({ teamId, broadcastId, from: "f@a.com", to: ["t@b.com"], subject: "s" })
    .returning({ id: schema.emails.id });
  if (!fanout) throw new Error("seed failed");
  broadcastEmailId = fanout.id;

  await db.insert(schema.emailInsights).values([
    { teamId, emailId, marketing: false, checks: [], scoreTenths: 100, scoreVersion: 1 },
    { teamId, broadcastId, marketing: true, checks: [], scoreTenths: 80, scoreVersion: 1 },
  ]);
});

afterAll(() => close());

it("resolves an API send by its emailId-keyed row", async () => {
  const row = await fetchEmailInsights(db, teamId, { emailId, broadcastId: null });
  expect(row?.scoreTenths).toBe(100);
});

it("falls back to the shared broadcastId-keyed row for fan-out emails", async () => {
  const row = await fetchEmailInsights(db, teamId, { emailId: broadcastEmailId, broadcastId });
  expect(row?.scoreTenths).toBe(80);
});

it("is team-scoped: another team's id resolves nothing", async () => {
  expect(await fetchEmailInsights(db, otherTeamId, { emailId, broadcastId })).toBeNull();
});

it("returns null when no row exists (pre-feature emails)", async () => {
  expect(
    await fetchEmailInsights(db, teamId, { emailId: broadcastEmailId, broadcastId: null }),
  ).toBeNull();
});
