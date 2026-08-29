import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { migrationsFolder } from "../src/migrate.js";

let client: PGlite;
let teamId: string;

// The 0004 migration casts contact_properties.type from text to the enum, so
// the test applies migrations in two steps around a property insert to cover
// rows that exist when the cast runs.
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
  await execMigrations((idx) => idx < 4);
  ({ id: teamId } = await one<{ id: string }>(
    "insert into teams (name, slug) values ('t', 't') returning id",
  ));
  await client.query("insert into contact_properties (team_id, key) values ($1, 'legacy')", [
    teamId,
  ]);
  await execMigrations((idx) => idx >= 4);
});

afterAll(() => client.close());

it("casts pre-existing property rows and keeps the 'string' default", async () => {
  const legacy = await one<{ type: string }>(
    "select type from contact_properties where key = 'legacy'",
  );
  expect(legacy.type).toBe("string");

  const fresh = await one<{ type: string }>(
    "insert into contact_properties (team_id, key) values ($1, 'fresh') returning type",
    [teamId],
  );
  expect(fresh.type).toBe("string");

  const numeric = await one<{ type: string }>(
    "insert into contact_properties (team_id, key, type) values ($1, 'score', 'number') returning type",
    [teamId],
  );
  expect(numeric.type).toBe("number");
});

it("rejects property types outside the enum", async () => {
  await expect(
    client.query(
      "insert into contact_properties (team_id, key, type) values ($1, 'b', 'boolean')",
      [teamId],
    ),
  ).rejects.toThrow(/invalid input value for enum contact_property_type/);
});

it("accepts valid hex colors; branding defaults to the team's own (0008 flip)", async () => {
  await client.query(
    "update teams set unsubscribe_background_color = '#000000', unsubscribe_text_color = '#FFFFFF', unsubscribe_accent_color = '#46a3f9' where id = $1",
    [teamId],
  );
  const row = await one<{ hidden: boolean }>(
    "select unsubscribe_hide_branding as hidden from teams where id = $1",
    [teamId],
  );
  expect(row.hidden).toBe(true);
});

it("rejects malformed hex colors", async () => {
  for (const bad of ["red", "#46a3f", "#46a3f9ff"]) {
    await expect(
      client.query("update teams set unsubscribe_accent_color = $1 where id = $2", [bad, teamId]),
    ).rejects.toThrow(/teams_unsubscribe_accent_color_hex/);
  }
});
