import { randomUUID } from "node:crypto";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { purgeAccountSignups, recordSignup } from "../src/account-signups.js";
import { suspendTeam } from "../src/team-standing.js";
import { DAY_MS } from "../src/utc-day.js";

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(() => close());

async function account(teamId?: string): Promise<string> {
  const id = randomUUID();
  const email = `${id}@example.com`;
  await db.insert(schema.user).values({ id, name: "Person", email });
  await recordSignup(db, { userId: id, email, ip: "203.0.113.9", userAgent: "Firefox" });
  if (teamId) await db.insert(schema.teamMembers).values({ teamId, userId: id, role: "owner" });
  return id;
}

async function record(userId: string) {
  const [row] = await db
    .select()
    .from(schema.accountSignups)
    .where(eq(schema.accountSignups.userId, userId));
  return row ?? null;
}

const deleteAccount = (userId: string) => db.delete(schema.user).where(eq(schema.user.id, userId));

const daysAfter = (start: Date, days: number) => new Date(start.getTime() + days * DAY_MS);

describe("recordSignup", () => {
  it("keeps the IP and browser, and leaves out what is not an address", async () => {
    await recordSignup(db, {
      userId: "a",
      email: "a@example.com",
      ip: "2001:DB8::1",
      userAgent: "x".repeat(2000),
    });
    await recordSignup(db, { userId: "b", email: "b@example.com", ip: "unknown", userAgent: "" });
    expect(await record("a")).toMatchObject({ ip: "2001:db8::1", email: "a@example.com" });
    expect((await record("a"))?.userAgent).toHaveLength(512);
    expect(await record("b")).toMatchObject({ ip: null, userAgent: null });
  });
});

describe("purgeAccountSignups", () => {
  it("keeps the record for the account's life and 90 days after its deletion", async () => {
    const id = await account();
    const start = new Date();
    await purgeAccountSignups(db, daysAfter(start, 400));
    expect(await record(id)).toMatchObject({ deletedAt: null });

    await deleteAccount(id);
    const deletedSeen = daysAfter(start, 401);
    await purgeAccountSignups(db, deletedSeen);
    expect((await record(id))?.deletedAt).toEqual(deletedSeen);

    expect(await purgeAccountSignups(db, daysAfter(deletedSeen, 89))).toBe(0);
    expect(await record(id)).not.toBeNull();
    expect(await purgeAccountSignups(db, daysAfter(deletedSeen, 91))).toBe(1);
    expect(await record(id)).toBeNull();
  });

  it("keeps it 12 months after deletion for an account in a team suspended for abuse", async () => {
    const teamId = await createTeam(db, "phish");
    const id = await account(teamId);
    await suspendTeam(db, { teamId, reason: "phishing" });
    const start = new Date();
    await purgeAccountSignups(db, start);
    expect(await record(id)).toMatchObject({ abuseSuspended: true });

    await deleteAccount(id);
    await purgeAccountSignups(db, daysAfter(start, 1));
    expect(await purgeAccountSignups(db, daysAfter(start, 200))).toBe(0);
    expect(await record(id)).toMatchObject({ abuseSuspended: true });
    expect(await purgeAccountSignups(db, daysAfter(start, 367))).toBe(1);
  });

  it("does not count a review hold or non-payment as abuse, and follows a reinstatement", async () => {
    const teamId = await createTeam(db, "held");
    const id = await account(teamId);
    await suspendTeam(db, { teamId, reason: "review" });
    await purgeAccountSignups(db);
    expect(await record(id)).toMatchObject({ abuseSuspended: false });

    await suspendTeam(db, { teamId, reason: "manual" });
    await purgeAccountSignups(db);
    expect(await record(id)).toMatchObject({ abuseSuspended: true });

    await db
      .update(schema.teams)
      .set({ suspendedAt: null, suspensionReason: null })
      .where(eq(schema.teams.id, teamId));
    await purgeAccountSignups(db);
    expect(await record(id)).toMatchObject({ abuseSuspended: false });
  });
});
