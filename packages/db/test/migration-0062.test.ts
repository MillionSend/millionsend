import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { migrationsFolder } from "../src/migrate.js";

let client: PGlite;
let teamId: string;

const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta/_journal.json"), "utf8")) as {
  entries: { idx: number; tag: string }[];
};

const execMigrations = async (filter: (idx: number) => boolean) => {
  for (const entry of journal.entries.filter((e) => filter(e.idx))) {
    await client.exec(readFileSync(join(migrationsFolder, `${entry.tag}.sql`), "utf8"));
  }
};

beforeAll(async () => {
  client = new PGlite();
  await execMigrations((idx) => idx < 62);
  const { rows } = await client.query<{ id: string }>(
    "insert into teams (name, slug) values ('t', 't') returning id",
  );
  teamId = rows[0]?.id ?? "";
  await client.query(
    "insert into contact_properties (team_id, key, type) values ($1, 'plan', 'string'), ($1, 'seats', 'number')",
    [teamId],
  );
  await execMigrations((idx) => idx >= 62);
});

afterAll(() => client.close());

it("adds the date type after string and number, leaving existing properties alone", async () => {
  const values = await client.query<{ values: string[] }>(
    "select enum_range(null::contact_property_type)::text[] as values",
  );
  expect(values.rows[0]?.values).toEqual(["string", "number", "date"]);
  const kept = await client.query("select key, type from contact_properties order by key");
  expect(kept.rows).toEqual([
    { key: "plan", type: "string" },
    { key: "seats", type: "number" },
  ]);
});

it("takes a date property and keeps 'string' as the default", async () => {
  const { rows } = await client.query(
    "insert into contact_properties (team_id, key, type) values ($1, 'last_login', 'date'), ($1, 'city', default) returning key, type",
    [teamId],
  );
  expect(rows).toEqual([
    { key: "last_login", type: "date" },
    { key: "city", type: "string" },
  ]);
});
