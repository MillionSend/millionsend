import { randomUUID } from "node:crypto";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb, createWebhookEndpoint } from "@millionsend/test-utils";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { confirmSystemContact } from "../src/system-contacts.js";
import { suspendTeam } from "../src/team-standing.js";

let db: Db;
let close: () => Promise<void>;
let systemTeam: string;
let suspended: string;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  systemTeam = await createTeam(db, randomUUID());
  await db.update(schema.teams).set({ plan: "system" }).where(eq(schema.teams.id, systemTeam));
  suspended = await createTeam(db, randomUUID());
});
afterEach(() => close());

type Role = "owner" | "admin" | "member";

/** An account in the given teams whose address is a subscribed contact of the system team. */
async function person(...memberships: [teamId: string, role: Role][]) {
  const email = `${randomUUID()}@example.com`;
  const userId = randomUUID();
  await db.insert(schema.user).values({ id: userId, name: "Person", email });
  for (const [teamId, role] of memberships) {
    await db.insert(schema.teamMembers).values({ teamId, userId, role });
  }
  await db.insert(schema.contacts).values({ teamId: systemTeam, email: email.toUpperCase() });
  return email;
}

async function contact(email: string, teamId = systemTeam) {
  const c = schema.contacts;
  const [row] = await db
    .select({ unsubscribed: c.unsubscribed, unsubscribedAt: c.unsubscribedAt })
    .from(c)
    .where(and(eq(c.teamId, teamId), sql`lower(${c.email}) = ${email}`));
  if (!row) throw new Error(`no contact ${email}`);
  return row;
}

const subscribed = async (email: string, teamId = systemTeam) =>
  !(await contact(email, teamId)).unsubscribed;

async function timeline() {
  return db
    .select({ teamId: schema.contactActivities.teamId, type: schema.contactActivities.type })
    .from(schema.contactActivities);
}

it("a suspension over the rules unsubscribes every member from the system team's list, saying why and firing no webhook", async () => {
  await createWebhookEndpoint(db, systemTeam, null);
  const elsewhere = await createTeam(db, randomUUID());
  const owner = await person([suspended, "owner"]);
  const member = await person([suspended, "member"]);
  const alsoInGoodStanding = await person([elsewhere, "owner"], [suspended, "admin"]);
  const bystander = await person([elsewhere, "member"]);
  await db.insert(schema.contacts).values({ teamId: elsewhere, email: owner });

  expect(await suspendTeam(db, { teamId: suspended, reason: "manual" })).toBe(true);

  expect(await subscribed(owner)).toBe(false);
  expect(await subscribed(member)).toBe(false);
  expect(await subscribed(alsoInGoodStanding)).toBe(false);
  expect((await contact(owner)).unsubscribedAt).toBeInstanceOf(Date);
  expect(await subscribed(bystander)).toBe(true);
  expect(await subscribed(owner, elsewhere)).toBe(true);
  expect(await timeline()).toEqual(
    Array(3).fill({ teamId: systemTeam, type: "unsubscribed_team_suspended" }),
  );
  expect(await db.select().from(schema.webhookDeliveries)).toEqual([]);
});

it("a review hold and non_payment leave the list alone; a hold that becomes phishing does not", async () => {
  const held = await person([suspended, "owner"]);
  const unpaid = await createTeam(db, randomUUID());
  const debtor = await person([unpaid, "owner"]);

  await suspendTeam(db, { teamId: suspended, reason: "review", ifNotSuspended: true });
  await suspendTeam(db, { teamId: unpaid, reason: "non_payment" });
  expect(await subscribed(held)).toBe(true);
  expect(await subscribed(debtor)).toBe(true);

  await suspendTeam(db, { teamId: suspended, reason: "phishing" });
  expect(await subscribed(held)).toBe(false);
  // non_payment turning into a suspension over the rules unsubscribes too.
  await suspendTeam(db, { teamId: unpaid, reason: "reputation" });
  expect(await subscribed(debtor)).toBe(false);
});

it("suspending again changes nothing, and keeps the opt-in of someone who came back", async () => {
  const returning = await person([suspended, "owner"]);
  const quiet = await person([suspended, "member"]);
  await suspendTeam(db, { teamId: suspended, reason: "manual" });
  await confirmSystemContact(db, systemTeam, { email: returning, name: "Person" });
  expect(await subscribed(returning)).toBe(true);

  await suspendTeam(db, { teamId: suspended, reason: "reputation", note: "repeat" });
  await suspendTeam(db, { teamId: suspended, reason: "phishing" });

  expect(await subscribed(returning)).toBe(true);
  expect(await subscribed(quiet)).toBe(false);
  expect((await timeline()).map((row) => row.type).sort()).toEqual([
    "resubscribed",
    "unsubscribed_team_suspended",
    "unsubscribed_team_suspended",
  ]);
});

it("an instance without a system team suspends as before", async () => {
  await db.update(schema.teams).set({ plan: "free" }).where(eq(schema.teams.id, systemTeam));
  const owner = await person([suspended, "owner"]);

  expect(await suspendTeam(db, { teamId: suspended, reason: "phishing" })).toBe(true);
  expect(await subscribed(owner)).toBe(true);
  expect(await timeline()).toEqual([]);
});

it("a failed unsubscribe leaves the team unsuspended, so a retry does both", async () => {
  const owner = await person([suspended, "owner"]);
  await db.execute(sql`
    create function refuse_contact_update() returns trigger language plpgsql as $$
    begin raise exception 'contacts unavailable'; end $$`);
  await db.execute(
    sql`create trigger refuse_contact_update before update on contacts for each row execute function refuse_contact_update()`,
  );

  await expect(suspendTeam(db, { teamId: suspended, reason: "manual" })).rejects.toThrow();
  const [team] = await db
    .select({ suspendedAt: schema.teams.suspendedAt })
    .from(schema.teams)
    .where(eq(schema.teams.id, suspended));
  expect(team?.suspendedAt).toBeNull();

  await db.execute(sql`drop trigger refuse_contact_update on contacts`);
  await suspendTeam(db, { teamId: suspended, reason: "manual" });
  expect(await subscribed(owner)).toBe(false);
});
