import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, expect, it } from "vitest";
import { migrationsFolder } from "../src/migrate.js";

const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta/_journal.json"), "utf8")) as {
  entries: { idx: number; tag: string }[];
};
const migration = (idx: number) => {
  const entry = journal.entries.find((e) => e.idx === idx);
  if (!entry) throw new Error(`no migration ${idx}`);
  return readFileSync(join(migrationsFolder, `${entry.tag}.sql`), "utf8");
};
const BACKFILL = 48;

let client: PGlite;
afterEach(() => client.close());

async function team(plan: string, reason: string | null = null): Promise<string> {
  const id = randomUUID();
  await client.query(
    `insert into teams (id, name, slug, plan, suspended_at, suspension_reason)
     values ($1, $2, $2, $3, $4, $5)`,
    [id, `team-${id}`, plan, reason ? "2026-10-01T00:00:00Z" : null, reason],
  );
  return id;
}

/** An account in `teams`, with a contact in `contactTeam` last written at `updatedAt`. */
async function person(
  teams: string[],
  contactTeam: string,
  opts: { updatedAt?: string; unsubscribed?: boolean } = {},
): Promise<string> {
  const userId = randomUUID();
  const email = `${userId}@example.com`;
  await client.query(`insert into "user" (id, name, email) values ($1, 'P', $2)`, [userId, email]);
  for (const teamId of teams) {
    await client.query("insert into team_members (team_id, user_id) values ($1, $2)", [
      teamId,
      userId,
    ]);
  }
  await client.query(
    `insert into contacts (team_id, email, unsubscribed, unsubscribed_at, updated_at)
     values ($1, $2, $3, $4, $5)`,
    [
      contactTeam,
      email.toUpperCase(),
      opts.unsubscribed ?? false,
      opts.unsubscribed ? "2026-09-15T00:00:00Z" : null,
      opts.updatedAt ?? "2026-09-01T00:00:00Z",
    ],
  );
  return email;
}

async function state(email: string, teamId: string) {
  const { rows } = await client.query<{ unsubscribed: boolean; activities: string[] }>(
    `select c.unsubscribed,
       coalesce(array_agg(a.type) filter (where a.id is not null), '{}') as activities
     from contacts c left join contact_activities a on a.contact_id = c.id
     where c.team_id = $1 and lower(c.email) = $2
     group by c.id`,
    [teamId, email],
  );
  return rows[0];
}

it("unsubscribes once the system team's contacts of people in teams suspended over the rules", async () => {
  client = new PGlite();
  for (const entry of journal.entries.filter((e) => e.idx < BACKFILL)) {
    await client.exec(migration(entry.idx));
  }
  const system = await team("system");
  const elsewhere = await team("free");
  const good = await team("free");
  const manual = await person([await team("free", "manual")], system);
  const phishingAndGood = await person([await team("free", "phishing"), good], system);
  const reputation = await team("pro", "reputation");
  const optedInSince = await person([reputation], system, { updatedAt: "2026-10-05T00:00:00Z" });
  const alreadyOut = await person([reputation], system, { unsubscribed: true });
  const review = await person([await team("free", "review")], system);
  const unpaid = await person([await team("pro", "non_payment")], system);
  const inGoodStanding = await person([good], system);
  await client.query("insert into contacts (team_id, email) values ($1, $2)", [elsewhere, manual]);

  await client.exec(migration(BACKFILL));

  const out = { unsubscribed: true, activities: ["unsubscribed_team_suspended"] };
  const untouched = { unsubscribed: false, activities: [] };
  expect(await state(manual, system)).toEqual(out);
  expect(await state(phishingAndGood, system)).toEqual(out);
  expect(await state(optedInSince, system)).toEqual(untouched);
  expect(await state(alreadyOut, system)).toEqual({ unsubscribed: true, activities: [] });
  expect(await state(review, system)).toEqual(untouched);
  expect(await state(unpaid, system)).toEqual(untouched);
  expect(await state(inGoodStanding, system)).toEqual(untouched);
  expect(await state(manual, elsewhere)).toEqual(untouched);
  const { rows } = await client.query<{ at: Date | null }>(
    "select unsubscribed_at as at from contacts where lower(email) = $1 and team_id = $2",
    [alreadyOut, system],
  );
  expect(rows[0]?.at?.toISOString()).toBe("2026-09-15T00:00:00.000Z");
});

it("runs in the same transaction as the migration that adds the system plan", async () => {
  client = new PGlite();
  for (const entry of journal.entries.filter((e) => e.idx < 36)) {
    await client.exec(migration(entry.idx));
  }
  await client.query("insert into teams (name, slug, plan) values ('t', 't', 'pro')");
  // drizzle's migrator applies every pending migration in one transaction.
  const pending = journal.entries.filter((e) => e.idx >= 36).map((e) => migration(e.idx));
  await client.exec(`begin;\n${pending.join(";\n")};\ncommit;`);
  const { rows } = await client.query<{ n: number }>("select count(*)::int as n from teams");
  expect(rows[0]?.n).toBe(1);
});
