import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { migrationsFolder } from "../src/migrate.js";

let client: PGlite;

const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta/_journal.json"), "utf8")) as {
  entries: { idx: number; tag: string }[];
};

const execMigrations = async (filter: (idx: number) => boolean) => {
  for (const entry of journal.entries.filter((e) => filter(e.idx))) {
    await client.exec(readFileSync(join(migrationsFolder, `${entry.tag}.sql`), "utf8"));
  }
};

const lockedAt = async (name: string) => {
  const { rows } = await client.query<{ locked_at: Date | null }>(
    "select locked_at from shared_inbox_domains where name = $1",
    [name],
  );
  return rows[0]?.locked_at;
};

beforeAll(async () => {
  client = new PGlite();
  await execMigrations((idx) => idx < 54);
  await client.query("insert into teams (name, slug) values ('Acme', 'acme'), ('Gone', 'gone')");
  await client.query(
    "insert into shared_inbox_domains (team_id, name) select id, slug || '.agents.example.com' from teams",
  );
  // ON DELETE SET NULL leaves the deleted team's label as a tombstone.
  await client.query("delete from teams where slug = 'gone'");
  await execMigrations((idx) => idx >= 54);
});

afterAll(() => client.close());

it("locks every label from before 0054, a tombstone included", async () => {
  expect(await lockedAt("acme.agents.example.com")).toBeInstanceOf(Date);
  expect(await lockedAt("gone.agents.example.com")).toBeInstanceOf(Date);
});

it("leaves a label written after it unlocked", async () => {
  await client.query("insert into teams (name, slug) values ('New', 'new')");
  await client.query(
    "insert into shared_inbox_domains (team_id, name) select id, 'new.agents.example.com' from teams where slug = 'new'",
  );
  expect(await lockedAt("new.agents.example.com")).toBeNull();
});
