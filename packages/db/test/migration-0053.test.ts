import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { migrationsFolder } from "../src/migrate.js";

const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta/_journal.json"), "utf8")) as {
  entries: { idx: number; tag: string }[];
};
const LABEL = "acme.agents.example.test";

let client: PGlite;
let team: string;

async function newTeam(slug: string): Promise<string> {
  const id = randomUUID();
  await client.query("insert into teams (id, name, slug) values ($1, 'Acme', $2)", [id, slug]);
  return id;
}

beforeAll(async () => {
  client = new PGlite();
  for (const entry of journal.entries.filter((e) => e.idx < 53)) {
    await client.exec(readFileSync(join(migrationsFolder, `${entry.tag}.sql`), "utf8"));
  }
  team = await newTeam("acme");
  await client.query("insert into shared_inbox_domains (team_id, name) values ($1, $2)", [
    team,
    LABEL,
  ]);
  await client.exec(readFileSync(join(migrationsFolder, "0053_shared_inbox_sending.sql"), "utf8"));
});
afterAll(() => client.close());

it("keeps a deleted team's shared label taken, so it is never issued again", async () => {
  await client.query("delete from teams where id = $1", [team]);
  const { rows } = await client.query("select team_id from shared_inbox_domains where name = $1", [
    LABEL,
  ]);
  expect(rows).toEqual([{ team_id: null }]);
  const next = await newTeam("acme-2");
  await expect(
    client.query("insert into shared_inbox_domains (team_id, name) values ($1, $2)", [next, LABEL]),
  ).rejects.toThrow(/shared_inbox_domains_name_unique/);
});
