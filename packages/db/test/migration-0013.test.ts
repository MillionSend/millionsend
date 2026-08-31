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

const BACKFILL_TAG = "0013_backfill_hard_bounced";

let teamId: string;

beforeAll(async () => {
  client = new PGlite();
  // Apply everything BEFORE the backfill, seed history, then run the backfill —
  // mirroring a deploy onto a database with pre-existing events.
  for (const entry of journal.entries.filter((e) => e.tag !== BACKFILL_TAG)) {
    await client.exec(readFileSync(join(migrationsFolder, `${entry.tag}.sql`), "utf8"));
  }
  ({ id: teamId } = await one("insert into teams (name, slug) values ('a', 'a') returning id"));
  const { id: emailId } = await one<{ id: string }>(
    `insert into emails (team_id, "from", "to", subject) values ($1, 'f@a.com', '["t@b.com"]', 's') returning id`,
    [teamId],
  );
  const insertEvent = (occurredAt: string, data: string | null) =>
    client.query(
      "insert into email_events (email_id, type, occurred_at, data) values ($1, 'bounced', $2, $3)",
      [emailId, occurredAt, data],
    );
  // Two Permanent bounces on a day that already has a counters row...
  await insertEvent("2026-08-15T10:00:00Z", '{"bounce":{"bounceType":"Permanent"}}');
  await insertEvent("2026-08-15T23:59:00Z", '{"bounce":{"bounceType":"Permanent"}}');
  // ...one on a day with no row, one Transient, and one retention-stripped.
  await insertEvent("2026-08-16T00:00:00Z", '{"bounce":{"bounceType":"Permanent"}}');
  await insertEvent("2026-08-15T11:00:00Z", '{"bounce":{"bounceType":"Transient"}}');
  await insertEvent("2026-08-15T12:00:00Z", null);
  await client.query(
    "insert into usage_counters (team_id, day, bounced, hard_bounced) values ($1, '2026-08-15', 5, 0)",
    [teamId],
  );
  await client.exec(readFileSync(join(migrationsFolder, `${BACKFILL_TAG}.sql`), "utf8"));
});

afterAll(() => client.close());

it("adds Permanent-bounce counts onto the existing day row, ignoring Transient/stripped", async () => {
  const row = await one<{ hard_bounced: number; bounced: number }>(
    "select hard_bounced, bounced from usage_counters where team_id = $1 and day = '2026-08-15'",
    [teamId],
  );
  expect(row).toEqual({ hard_bounced: 2, bounced: 5 });
});

it("creates a missing day row with defaults for the other counters", async () => {
  const row = await one<{ hard_bounced: number; bounced: number; sent: number }>(
    "select hard_bounced, bounced, sent from usage_counters where team_id = $1 and day = '2026-08-16'",
    [teamId],
  );
  expect(row).toEqual({ hard_bounced: 1, bounced: 0, sent: 0 });
});
