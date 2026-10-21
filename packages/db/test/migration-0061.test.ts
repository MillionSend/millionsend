import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { migrationsFolder } from "../src/migrate.js";

let client: PGlite;
let teamId: string;
let domainId: string;

const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta/_journal.json"), "utf8")) as {
  entries: { idx: number; tag: string }[];
};

beforeAll(async () => {
  client = new PGlite();
  for (const entry of journal.entries) {
    await client.exec(readFileSync(join(migrationsFolder, `${entry.tag}.sql`), "utf8"));
  }
  await client.query(
    "insert into \"user\" (id, name, email) values ('ana', 'Ana', 'ana@example.com')",
  );
  const team = await client.query<{ id: string }>(
    "insert into teams (name, slug) values ('t', 't') returning id",
  );
  teamId = team.rows[0]?.id ?? "";
  const domain = await client.query<{ id: string }>(
    "insert into domains (team_id, name, region) values ($1, 'nova.example', 'us-east-1') returning id",
    [teamId],
  );
  domainId = domain.rows[0]?.id ?? "";
});

afterAll(() => client.close());

const ask = () =>
  client.query<{ id: string; status: string }>(
    "insert into domain_limit_requests (team_id, domain_id, requested_by, sends, per_day, source) values ($1, $2, 'ana', 'account', 2000, 'new') returning id, status",
    [teamId, domainId],
  );

it("keeps one open request per domain, opens with status open, and keeps the answered ones", async () => {
  const first = await ask();
  expect(first.rows[0]?.status).toBe("open");
  await expect(ask()).rejects.toThrow(/domain_limit_requests_open_domain_idx/);
  await client.query("update domain_limit_requests set status = 'declined' where id = $1", [
    first.rows[0]?.id,
  ]);
  await ask();
  const { rows } = await client.query<{ n: number }>(
    "select count(*)::int as n from domain_limit_requests",
  );
  expect(rows[0]?.n).toBe(2);
});

it("outlives who asked, and goes with its domain", async () => {
  await client.query("delete from \"user\" where id = 'ana'");
  const kept = await client.query<{ requested_by: string | null }>(
    "select requested_by from domain_limit_requests",
  );
  expect(kept.rows.map((r) => r.requested_by)).toEqual([null, null]);
  await client.query("delete from domains where id = $1", [domainId]);
  const gone = await client.query<{ n: number }>(
    "select count(*)::int as n from domain_limit_requests",
  );
  expect(gone.rows[0]?.n).toBe(0);
});
