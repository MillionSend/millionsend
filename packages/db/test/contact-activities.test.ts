import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { migrationsFolder } from "../src/migrate.js";

let client: PGlite;
let teamId: string;

// The 0003 migration backfills visibility on rows that exist when it runs, so
// the test applies migrations in two steps around a topic insert instead of
// using the migrator (which only applies everything at once).
const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta/_journal.json"), "utf8")) as {
  entries: { idx: number; tag: string }[];
};

const execMigrations = async (filter: (idx: number) => boolean) => {
  for (const entry of journal.entries.filter((e) => filter(e.idx))) {
    await client.exec(readFileSync(join(migrationsFolder, `${entry.tag}.sql`), "utf8"));
  }
};

async function one<T>(query: string, params?: unknown[]): Promise<T> {
  const { rows } = await client.query<T>(query, params);
  const row = rows[0];
  if (row === undefined) throw new Error(`no row: ${query}`);
  return row;
}

beforeAll(async () => {
  client = new PGlite();
  await execMigrations((idx) => idx < 3);
  ({ id: teamId } = await one<{ id: string }>(
    "insert into teams (name, slug) values ('t', 't') returning id",
  ));
  await client.query(
    "insert into topics (team_id, name, default_subscribed) values ($1, 'legacy', true)",
    [teamId],
  );
  await execMigrations((idx) => idx >= 3);
});

afterAll(() => client.close());

it("backfills pre-existing topics to public; new topics default to private", async () => {
  const legacy = await one<{ visibility: string }>(
    "select visibility from topics where name = 'legacy'",
  );
  expect(legacy.visibility).toBe("public");

  const fresh = await one<{ visibility: string }>(
    "insert into topics (team_id, name, default_subscribed) values ($1, 'new', true) returning visibility",
    [teamId],
  );
  expect(fresh.visibility).toBe("private");
});

it("activity rows cascade away with the contact", async () => {
  const { id: contactId } = await one<{ id: string }>(
    "insert into contacts (team_id, email) values ($1, 'a@b.test') returning id",
    [teamId],
  );
  await client.query(
    "insert into contact_activities (team_id, contact_id, type, data) values ($1, $2, 'contact_created', '{\"source\":\"test\"}')",
    [teamId, contactId],
  );
  await client.query("delete from contacts where id = $1", [contactId]);
  const { n } = await one<{ n: number }>("select count(*)::int as n from contact_activities");
  expect(n).toBe(0);
});
