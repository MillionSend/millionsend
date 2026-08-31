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

let teamId: string;
let emailId: string;
let broadcastId: string;

beforeAll(async () => {
  client = new PGlite();
  for (const entry of journal.entries) {
    await client.exec(readFileSync(join(migrationsFolder, `${entry.tag}.sql`), "utf8"));
  }
  ({ id: teamId } = await one("insert into teams (name, slug) values ('a', 'a') returning id"));
  ({ id: emailId } = await one(
    `insert into emails (team_id, "from", "to", subject) values ($1, 'f@a.com', '["t@b.com"]', 's') returning id`,
    [teamId],
  ));
  ({ id: broadcastId } = await one(
    `insert into broadcasts (team_id, "from", subject) values ($1, 'f@a.com', 's') returning id`,
    [teamId],
  ));
});

afterAll(() => client.close());

const INSERT_INSIGHT =
  "insert into email_insights (team_id, email_id, broadcast_id, marketing, checks, score_tenths, score_version) values ($1, $2, $3, false, '[]', 1000, 1)";

it("rejects an insights row targeting neither or both of email/broadcast", async () => {
  await expect(client.query(INSERT_INSIGHT, [teamId, null, null])).rejects.toThrow(
    /email_insights_one_target/,
  );
  await expect(client.query(INSERT_INSIGHT, [teamId, emailId, broadcastId])).rejects.toThrow(
    /email_insights_one_target/,
  );
});

it("keeps one insights row per email and per broadcast", async () => {
  await client.query(INSERT_INSIGHT, [teamId, emailId, null]);
  await expect(client.query(INSERT_INSIGHT, [teamId, emailId, null])).rejects.toThrow(
    /email_insights_email_id_unique/,
  );
  await client.query(INSERT_INSIGHT, [teamId, null, broadcastId]);
  await expect(client.query(INSERT_INSIGHT, [teamId, null, broadcastId])).rejects.toThrow(
    /email_insights_broadcast_id_unique/,
  );
});

it("insights cascade with their email row (metadata retention clock)", async () => {
  await client.query("delete from emails where id = $1", [emailId]);
  const row = await one<{ n: number }>(
    "select count(*)::int as n from email_insights where email_id is not null",
  );
  expect(row.n).toBe(0);
});

it("usage_counters.hard_bounced defaults to 0", async () => {
  const row = await one<{ hard_bounced: number; bounced: number }>(
    "insert into usage_counters (team_id, day, bounced) values ($1, '2026-08-30', 2) returning hard_bounced, bounced",
    [teamId],
  );
  expect(row).toEqual({ bounced: 2, hard_bounced: 0 });
});

it("domains gained the DNS-snapshot columns, null until a verification pass", async () => {
  const row = await one<{ dns_records: unknown; dmarc_policy: string | null }>(
    "insert into domains (team_id, name, region) values ($1, 'd.com', 'us-east-1') returning dns_records, dmarc_policy",
    [teamId],
  );
  expect(row).toEqual({ dns_records: null, dmarc_policy: null });
});
