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

beforeAll(async () => {
  client = new PGlite();
  // Teams that existed before rungs did, as the migration finds them.
  await execMigrations((idx) => idx < 35);
  await client.query(
    `insert into teams (name, slug, plan, current_period_end) values
      ('s', 's', 'scale', '2026-10-01T00:00:00Z'),
      ('p', 'p', 'pro', '2026-09-15T12:00:00Z'),
      ('f', 'f', 'free', null)`,
  );
  await execMigrations((idx) => idx >= 35);
});

afterAll(() => client.close());

it("puts existing paid teams on their plan's first rung and backfills the period start a month before its end", async () => {
  const { rows } = await client.query(
    "select slug, plan_quota, current_period_start from teams order by slug",
  );
  expect(rows).toEqual([
    { slug: "f", plan_quota: null, current_period_start: null },
    { slug: "p", plan_quota: 100_000, current_period_start: new Date("2026-08-15T12:00:00Z") },
    { slug: "s", plan_quota: 500_000, current_period_start: new Date("2026-09-01T00:00:00Z") },
  ]);
});

it("adds the overage switch (off), the pending rung and the pending overage counter", async () => {
  const teams = await client.query(
    "select overage_enabled, pending_rung from teams where slug = 'p'",
  );
  expect(teams.rows).toEqual([{ overage_enabled: false, pending_rung: null }]);
  const period = await client.query(
    "insert into usage_periods (team_id, period_start) select id, now() from teams where slug = 'p' returning accepted, reported_overage, pending_overage",
  );
  expect(period.rows).toEqual([{ accepted: 0, reported_overage: 0, pending_overage: null }]);
});

it("adds the starter plan", async () => {
  const { rows } = await client.query<{ plan: string }>(
    "update teams set plan = 'starter' where slug = 'f' returning plan",
  );
  expect(rows).toEqual([{ plan: "starter" }]);
});
