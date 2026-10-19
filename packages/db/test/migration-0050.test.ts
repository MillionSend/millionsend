import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { migrationsFolder } from "../src/migrate.js";

let client: PGlite;
const sql = readFileSync(join(migrationsFolder, "0050_phishing_defenses.sql"), "utf8");
const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta/_journal.json"), "utf8")) as {
  entries: { idx: number; tag: string }[];
};

beforeAll(async () => {
  client = new PGlite();
  for (const entry of journal.entries.filter((e) => e.idx < 50)) {
    await client.exec(readFileSync(join(migrationsFolder, `${entry.tag}.sql`), "utf8"));
  }
});

afterAll(() => client.close());

it("lets an operator build the review list's index CONCURRENTLY before deploying", async () => {
  expect(sql).toMatch(/-- IF NOT EXISTS: an operator may build it CONCURRENTLY/);
  // Built beforehand under the same name (CONCURRENTLY on a live instance;
  // PGlite builds it plainly), the migration leaves it and goes on.
  await client.exec(
    `CREATE INDEX "emails_review_list_idx" ON "emails" USING btree ("created_at") WHERE "emails"."latest_status" = 'queued_quota'`,
  );
  await client.exec(sql);
  const { rows } = await client.query<{ indexname: string }>(
    "select indexname from pg_indexes where indexname = 'emails_review_list_idx'",
  );
  expect(rows).toHaveLength(1);
});
