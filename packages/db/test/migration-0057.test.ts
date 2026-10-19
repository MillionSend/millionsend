import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { migrationsFolder } from "../src/migrate.js";

const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta/_journal.json"), "utf8")) as {
  entries: { idx: number; tag: string }[];
};

let client: PGlite;

beforeAll(async () => {
  client = new PGlite();
  for (const entry of journal.entries.filter((e) => e.idx < 57)) {
    await client.exec(readFileSync(join(migrationsFolder, `${entry.tag}.sql`), "utf8"));
  }
  await client.exec(`
    insert into "user" (id, name, email) values
      ('ada', 'Ada', 'ada@example.com'), ('bob', 'Bob', 'bob@example.com');
    insert into account (id, provider_id, account_id, issuer, user_id) values
      ('twin-old', 'google', 'sub-1', 'local:oauth:google', 'ada'),
      ('twin-new', 'google', 'sub-1', 'https://accounts.google.com', 'ada'),
      ('moved-old', 'google', 'sub-2', 'local:oauth:google', 'bob'),
      ('moved-new', 'google', 'sub-2', 'https://accounts.google.com', 'ada'),
      ('lone', 'google', 'sub-3', 'local:oauth:google', 'bob'),
      ('github', 'github', 'gh-1', 'local:oauth:github', 'ada'),
      ('password', 'credential', 'ada', 'local:credential', 'ada');
  `);
  await client.exec(
    readFileSync(join(migrationsFolder, "0057_account_issuer_nullable.sql"), "utf8"),
  );
});
afterAll(() => client.close());

it("keeps one row per provider account, the one Google sign-in resolved to", async () => {
  const { rows } = await client.query<{ id: string }>("select id from account order by id");
  expect(rows.map((row) => row.id)).toEqual([
    "github",
    "lone",
    "moved-new",
    "password",
    "twin-new",
  ]);
  const duplicates = await client.query(
    "select provider_id, account_id from account group by 1, 2 having count(*) > 1",
  );
  expect(duplicates.rows).toEqual([]);
});

it("takes the rows newer Better Auth writes without an issuer", async () => {
  await client.query(
    "insert into account (id, provider_id, account_id, user_id) values ('new', 'google', 'sub-4', 'bob')",
  );
  const { rows } = await client.query<{ issuer: string | null }>(
    "select issuer from account where id = 'new'",
  );
  expect(rows[0]?.issuer).toBeNull();
});
