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
  await execMigrations((idx) => idx < 36);
  await client.query("insert into teams (name, slug, plan) values ('s', 's', 'scale')");
  await execMigrations((idx) => idx >= 36);
});

afterAll(() => client.close());

it("adds the system plan after the ladder and leaves existing rows alone", async () => {
  const before = await client.query<{ plan: string }>("select plan from teams where slug = 's'");
  expect(before.rows).toEqual([{ plan: "scale" }]);
  const values = await client.query<{ values: string[] }>(
    "select enum_range(null::plan)::text[] as values",
  );
  expect(values.rows[0]?.values).toEqual(["free", "starter", "pro", "scale", "system"]);
});

it("lets an operator set the system plan the documented way", async () => {
  const { rows } = await client.query<{ plan: string; plan_status: string }>(
    `update teams set plan = 'system', plan_quota = null, current_period_start = null,
       current_period_end = null, plan_status = 'none', pending_rung = null, cancel_at = null
     where slug = 's' and stripe_customer_id is null and stripe_subscription_id is null
     returning plan, plan_status`,
  );
  expect(rows).toEqual([{ plan: "system", plan_status: "none" }]);
});
