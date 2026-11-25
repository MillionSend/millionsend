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
    "insert into teams (name, slug) values ('t', 't') returning id",
  );
  teamId = rows[0]?.id ?? "";
});

afterAll(() => client.close());

it("keeps one monitor row per team with the risk fraction and the levers", async () => {
  await client.query(
    "insert into team_monitor (team_id, sent_total, first_send_at, override_rate, override_until) values ($1, 3, now(), 1, now() + interval '7 days')",
    [teamId],
  );
  await expect(
    client.query("insert into team_monitor (team_id) values ($1)", [teamId]),
  ).rejects.toThrow(/team_monitor_pkey/);
  const { rows } = await client.query(
    "select sent_total, risk, risk_num, risk_den, override_rate, broadcasts_paused_at, alerted_at from team_monitor where team_id = $1",
    [teamId],
  );
  expect(rows).toEqual([
    {
      sent_total: 3,
      risk: null,
      risk_num: 0,
      risk_den: 0,
      override_rate: 1,
      broadcasts_paused_at: null,
      alerted_at: null,
    },
  ]);
});

it("stores a sample's verdict fields and nulls its email once the email is gone", async () => {
  const email = await client.query<{ id: string }>(
    "insert into emails (team_id, \"from\", \"to\", subject) values ($1, 'a@example.com', '[\"b@example.com\"]', 's') returning id",
    [teamId],
  );
  const emailId = email.rows[0]?.id ?? "";
  const sample = await client.query<{ id: string }>(
    "insert into monitor_samples (team_id, email_id, kind, status, score, verdict, categories, reasons, model, latency_ms) values ($1, $2, 'first_sends', 'judged', 88, 'abuse', '[\"phishing\"]', '[\"lookalike_domain\"]', 'example-model', 540) returning id",
    [teamId, emailId],
  );
  await expect(
    client.query(
      "insert into monitor_samples (team_id, kind, status) values ($1, 'copy', 'judged')",
      [teamId],
    ),
  ).rejects.toThrow(/monitor_sample_kind/);
  await client.query("delete from emails where id = $1", [emailId]);
  const { rows } = await client.query(
    "select email_id, kind, status, score, categories, attempts from monitor_samples where id = $1",
    [sample.rows[0]?.id],
  );
  expect(rows).toEqual([
    {
      email_id: null,
      kind: "first_sends",
      status: "judged",
      score: 88,
      categories: ["phishing"],
      attempts: 0,
    },
  ]);
});

it("indexes the sample's email and broadcast keys and stamps a resume", async () => {
  const { rows } = await client.query<{ indexname: string }>(
    "select indexname from pg_indexes where tablename = 'monitor_samples' order by indexname",
  );
  expect(rows.map((r) => r.indexname)).toEqual([
    "monitor_samples_broadcast_idx",
    "monitor_samples_created_idx",
    "monitor_samples_email_idx",
    "monitor_samples_pkey",
    "monitor_samples_team_created_idx",
    "monitor_samples_team_pending_screening_idx",
  ]);
  const resumed = await client.query(
    "update team_monitor set broadcasts_resumed_at = now() where team_id = $1 returning broadcasts_resumed_at is not null as resumed",
    [teamId],
  );
  expect(resumed.rows).toEqual([{ resumed: true }]);
});

it("adds the monitor settings and the standing's risk column", async () => {
  await client.query(
    "insert into instance_settings (id, monitor_first_sends, monitor_trusted_rate, monitor_auto_pause) values (1, 500, 0.005, false)",
  );
  const settings = await client.query(
    "select monitor_first_sends, monitor_ramp_rate, monitor_trusted_rate, monitor_auto_pause, monitor_flag_score from instance_settings",
  );
  expect(settings.rows).toEqual([
    {
      monitor_first_sends: 500,
      monitor_ramp_rate: null,
      monitor_trusted_rate: 0.005,
      monitor_auto_pause: false,
      monitor_flag_score: null,
    },
  ]);
  const standing = await client.query(
    "insert into team_standings (team_id, guardrail, monitor_risk) values ($1, 'ok', 0.42) returning monitor_risk",
    [teamId],
  );
  expect(standing.rows).toEqual([{ monitor_risk: 0.42 }]);
});
