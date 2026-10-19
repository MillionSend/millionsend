import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { migrationsFolder } from "../src/migrate.js";

const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta/_journal.json"), "utf8")) as {
  entries: { idx: number; tag: string }[];
};
const INBOXES = 51;
const sql = readFileSync(join(migrationsFolder, "0052_inboxes.sql"), "utf8");

let client: PGlite;
let team: string;
let receivingDomain: string;
let sendingDomain: string;
let receivedId: string;

async function domain(name: string, receiving: boolean): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into domains (team_id, name, region, status, receiving_enabled)
     values ($1, $2, 'us-east-1', 'verified', $3) returning id`,
    [team, name, receiving],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("no domain row");
  return id;
}

beforeAll(async () => {
  client = new PGlite();
  for (const entry of journal.entries.filter((e) => e.idx < INBOXES)) {
    await client.exec(readFileSync(join(migrationsFolder, `${entry.tag}.sql`), "utf8"));
  }
  team = randomUUID();
  await client.query("insert into teams (id, name, slug) values ($1, $2, $2)", [team, `t-${team}`]);
  receivingDomain = await domain("inbound.acme.test", true);
  sendingDomain = await domain("acme.test", false);
  const { rows } = await client.query<{ id: string }>(
    `insert into received_emails
       (team_id, domain_ids, raw_sha256, message_id, "from", received_for, envelope, authentication, size_bytes, created_at)
     values ($1, '{}', $2, '<m@x>', 'a@x.test', '["r@inbound.acme.test"]', '{}', '{}', 1, '2026-10-01T10:00:00Z')
     returning id`,
    [team, "f".repeat(64)],
  );
  receivedId = rows[0]?.id ?? "";
  await client.exec(sql);
});
afterAll(() => client.close());

it("keeps every domain receiving today a catch-all, and leaves the rest off", async () => {
  const { rows } = await client.query<{ id: string; receiving_catch_all: boolean }>(
    "select id, receiving_catch_all from domains",
  );
  expect(Object.fromEntries(rows.map((r) => [r.id, r.receiving_catch_all]))).toEqual({
    [receivingDomain]: true,
    [sendingDomain]: false,
  });
});

it("marks mail stored before the migration as already announced", async () => {
  const { rows } = await client.query<{ same: boolean; catch_all: boolean; trust: string }>(
    `select announced_at = created_at as same, catch_all, sender_trust as trust
     from received_emails where id = $1`,
    [receivedId],
  );
  expect(rows[0]).toEqual({ same: true, catch_all: true, trust: "unauthenticated" });
});

it("adds the emails foreign keys unvalidated and lets operators prebuild the emails indexes", async () => {
  const { rows } = await client.query<{ conname: string; convalidated: boolean }>(
    `select conname, convalidated from pg_constraint
     where conname in ('emails_inbox_id_inboxes_id_fk', 'emails_thread_id_inbox_threads_id_fk')
     order by conname`,
  );
  expect(rows).toEqual([
    { conname: "emails_inbox_id_inboxes_id_fk", convalidated: false },
    { conname: "emails_thread_id_inbox_threads_id_fk", convalidated: false },
  ]);
  expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS "emails_inbox_idx"/);
  expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS "emails_thread_created_idx"/);
});

it("holds an inbox to a domain, and a draft's thread and target together", async () => {
  await expect(
    client.query(
      `insert into inboxes (team_id, kind, email_address, local_part, name, safety)
       values ($1, 'agent', 'a@nowhere.test', 'a', 'a', '{}')`,
      [team],
    ),
  ).rejects.toThrow(/inboxes_has_domain/);
  const { rows } = await client.query<{ id: string }>(
    `insert into inboxes (team_id, kind, email_address, local_part, domain_id, name, safety)
     values ($1, 'agent', 'bot@inbound.acme.test', 'bot', $2, 'bot', '{}') returning id`,
    [team, receivingDomain],
  );
  const inbox = rows[0]?.id;
  await expect(
    client.query(
      `insert into inbox_drafts (team_id, inbox_id, type, reply_to_email_id, created_by)
       values ($1, $2, 'standalone', $3, 'system')`,
      [team, inbox, receivedId],
    ),
  ).rejects.toThrow(/inbox_drafts_reply_pair/);
  // An inbox-scoped key keeps its inbox from being deleted until it is revoked.
  await client.query(
    `insert into api_keys (team_id, name, token_prefix, key_hash, last4, inbox_id)
     values ($1, 'agent', 'ms_live_x', 'hash', 'abcd', $2)`,
    [team, inbox],
  );
  await expect(client.query("delete from inboxes where id = $1", [inbox])).rejects.toThrow(
    /api_keys_inbox_id_inboxes_id_fk/,
  );
});

it("lets the content monitor sample an agent's first contact", async () => {
  await client.query(
    `insert into monitor_samples (team_id, kind) values ($1, 'agent_first_contact')`,
    [team],
  );
  const { rows } = await client.query<{ n: number }>(
    "select count(*)::int as n from monitor_samples where kind = 'agent_first_contact'",
  );
  expect(rows[0]?.n).toBe(1);
});
