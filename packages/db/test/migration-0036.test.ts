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

beforeAll(async () => {
  client = new PGlite();
  for (const entry of journal.entries) {
    await client.exec(readFileSync(join(migrationsFolder, `${entry.tag}.sql`), "utf8"));
  }
  const { rows } = await client.query<{ id: string }>(
    "insert into teams (name, slug, daily_send_ceiling, suspended_at, suspension_reason) values ('t', 't', 500, now(), 'manual') returning id",
  );
  teamId = rows[0]?.id ?? "";
});

afterAll(() => client.close());

it("adds the operator override columns to teams", async () => {
  const { rows } = await client.query(
    "select daily_send_ceiling, suspension_reason, suspended_at is not null as suspended, broadcasts_paused_by_operator_at, suspension_note from teams where id = $1",
    [teamId],
  );
  expect(rows).toEqual([
    {
      daily_send_ceiling: 500,
      suspension_reason: "manual",
      suspended: true,
      broadcasts_paused_by_operator_at: null,
      suspension_note: null,
    },
  ]);
});

it("adds manual_reason to region_breakers", async () => {
  const { rows } = await client.query(
    "insert into region_breakers (region, paused, manual_reason, paused_at) values ('us-east-1', true, 'incident', now()) returning region, paused, manual_reason, reason",
  );
  expect(rows).toEqual([
    { region: "us-east-1", paused: true, manual_reason: "incident", reason: null },
  ]);
});

it("allows one open flag per team", async () => {
  const insert = () =>
    client.query("insert into team_flags (team_id, reason) values ($1, 'manual')", [teamId]);
  await insert();
  await expect(insert()).rejects.toThrow(/team_flags_open_idx/);
  // A cleared flag beside the open one is fine.
  await client.query(
    "insert into team_flags (team_id, reason, status, cleared_at) values ($1, 'score', 'cleared', now())",
    [teamId],
  );
  const { rows } = await client.query<{ n: number }>(
    "select count(*)::int as n from team_flags where team_id = $1",
    [teamId],
  );
  expect(rows).toEqual([{ n: 2 }]);
});

it("accepts an instance probe sample and a team standing", async () => {
  const probe = await client.query(
    "insert into instance_probes (probe, taken_at, value, ok) values ('pg_latency_ms', now(), 12.5, true) returning probe, value, ok",
  );
  expect(probe.rows).toEqual([{ probe: "pg_latency_ms", value: 12.5, ok: true }]);
  const standing = await client.query(
    "insert into team_standings (team_id, guardrail) values ($1, 'ok') returning score_tenths, guardrail, sent_7d, sent_30d",
    [teamId],
  );
  expect(standing.rows).toEqual([{ score_tenths: null, guardrail: "ok", sent_7d: 0, sent_30d: 0 }]);
});
