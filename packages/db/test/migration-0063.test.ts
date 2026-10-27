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
  await execMigrations((idx) => idx < 63);
  const { rows } = await client.query<{ id: string }>(
    "insert into teams (name, slug) values ('t', 't') returning id",
  );
  teamId = rows[0]?.id ?? "";
  await client.query(
    `insert into emails (team_id, "from", "to", subject, latest_status, park_reason)
     values ($1, 'a@example.com', '["r@example.com"]', 'held', 'queued_quota', 'review')`,
    [teamId],
  );
  await client.query(
    "insert into region_breakers (region, paused, paused_at) values ('us-east-1', true, now())",
  );
  await execMigrations((idx) => idx >= 63);
});

afterAll(() => client.close());

it("adds the fuse park reason last, leaving parked mail alone", async () => {
  const values = await client.query<{ values: string[] }>(
    "select enum_range(null::email_park_reason)::text[] as values",
  );
  expect(values.rows[0]?.values).toEqual([
    "warmup",
    "review",
    "screening",
    "destination",
    "media",
    "recipient",
    "fuse",
  ]);
  const kept = await client.query("select subject, park_reason from emails");
  expect(kept.rows).toEqual([{ subject: "held", park_reason: "review" }]);
});

it("parks mail on the fuse", async () => {
  const { rows } = await client.query(
    `insert into emails (team_id, "from", "to", subject, latest_status, park_reason)
     values ($1, 'a@example.com', '["r@example.com"]', 'fused', 'queued_quota', 'fuse')
     returning park_reason`,
    [teamId],
  );
  expect(rows).toEqual([{ park_reason: "fuse" }]);
});

it("reads a pause written before scoped holds as holding the whole region", async () => {
  const { rows } = await client.query(
    "select paused, held_teams, ses_enforcement_status from region_breakers",
  );
  expect(rows).toEqual([{ paused: true, held_teams: null, ses_enforcement_status: null }]);
});

it("records unmatched SES feedback once per SNS message", async () => {
  const insert = () =>
    client.query(
      `insert into ses_unmatched_events (sns_message_id, ses_message_id, type, occurred_at)
       values ('sns-1', 'ses-1', 'complained', now()) on conflict do nothing returning id`,
    );
  expect((await insert()).rows).toHaveLength(1);
  expect((await insert()).rows).toHaveLength(0);
});
