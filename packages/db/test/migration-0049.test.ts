import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { migrationsFolder } from "../src/migrate.js";

let client: PGlite;

beforeAll(async () => {
  client = new PGlite();
  for (const file of readdirSync(migrationsFolder)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    await client.exec(readFileSync(join(migrationsFolder, file), "utf8"));
  }
});
afterAll(() => client.close());

async function team(): Promise<string> {
  const id = randomUUID();
  await client.query("insert into teams (id, name, slug) values ($1, $2, $2)", [id, `t-${id}`]);
  return id;
}

async function domain(teamId: string, name: string, receiving: boolean): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into domains (team_id, name, region, status, receiving_enabled)
     values ($1, $2, 'us-east-1', 'verified', $3) returning id`,
    [teamId, name, receiving],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("no domain row");
  return id;
}

it("lets a receiving domain name belong to one team only", async () => {
  const a = await team();
  const b = await team();
  await domain(a, "inbound.shared.test", true);
  // Holding the same name without receiving stays possible (self-host).
  const bDomain = await domain(b, "inbound.shared.test", false);
  await expect(
    client.query("update domains set receiving_enabled = true where id = $1", [bDomain]),
  ).rejects.toThrow(/domains_receiving_name_idx/);
  await expect(domain(b, "inbound.shared.test", true)).rejects.toThrow();
});

it("keeps one received row per team and raw message", async () => {
  const a = await team();
  const b = await team();
  const insert = (teamId: string) =>
    client.query(
      `insert into received_emails
         (team_id, domain_ids, raw_sha256, message_id, "from", received_for, envelope, authentication, size_bytes)
       values ($1, '{}', $2, '<m@x>', 'a@x.test', '["r@x.test"]', '{}', '{}', 1)`,
      [teamId, "f".repeat(64)],
    );
  await insert(a);
  await insert(b);
  await expect(insert(a)).rejects.toThrow(/received_emails_team_raw_idx/);
});

it("starts every usage counter's received column at zero", async () => {
  const a = await team();
  await client.query("insert into usage_counters (team_id, day) values ($1, '2026-10-11')", [a]);
  await client.query(
    "insert into usage_periods (team_id, period_start) values ($1, '2026-10-01T00:00:00Z')",
    [a],
  );
  const { rows } = await client.query<{ daily: number; period: number }>(
    `select (select received from usage_counters where team_id = $1) as daily,
            (select received from usage_periods where team_id = $1) as period`,
    [a],
  );
  expect(rows[0]).toEqual({ daily: 0, period: 0 });
});
