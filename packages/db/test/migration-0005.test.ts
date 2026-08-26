import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { migrationsFolder } from "../src/migrate.js";

let client: PGlite;

const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta/_journal.json"), "utf8")) as {
  entries: { tag: string }[];
};

async function one<T>(query: string, params?: unknown[]): Promise<T> {
  const { rows } = await client.query<T>(query, params);
  const row = rows[0];
  if (row === undefined) throw new Error(`no row: ${query}`);
  return row;
}

beforeAll(async () => {
  client = new PGlite();
  for (const entry of journal.entries) {
    await client.exec(readFileSync(join(migrationsFolder, `${entry.tag}.sql`), "utf8"));
  }
  await client.query("insert into teams (name, slug) values ('a', 'a'), ('b', 'b')");
});

afterAll(() => client.close());

it("defaults billing columns to unsubscribed", async () => {
  const row = await one(
    "select stripe_customer_id, stripe_subscription_id, plan_status, current_period_end from teams where slug = 'a'",
  );
  expect(row).toEqual({
    stripe_customer_id: null,
    stripe_subscription_id: null,
    plan_status: "none",
    current_period_end: null,
  });
});

it("enforces unique stripe_customer_id while allowing many nulls", async () => {
  await client.query("update teams set stripe_customer_id = 'cus_1' where slug = 'a'");
  await expect(
    client.query("update teams set stripe_customer_id = 'cus_1' where slug = 'b'"),
  ).rejects.toThrow(/teams_stripe_customer_id_unique/);
});

it("rejects plan_status outside the enum", async () => {
  await expect(
    client.query("update teams set plan_status = 'paused' where slug = 'a'"),
  ).rejects.toThrow(/invalid input value for enum plan_status/);
});

it("dedupes stripe events on the event id", async () => {
  const row = await one<{ received_at: Date }>(
    "insert into stripe_events (id, type) values ('evt_1', 'invoice.paid') returning received_at",
  );
  expect(row.received_at).toBeInstanceOf(Date);
  await expect(
    client.query("insert into stripe_events (id, type) values ('evt_1', 'invoice.paid')"),
  ).rejects.toThrow(/stripe_events_pkey/);
});
