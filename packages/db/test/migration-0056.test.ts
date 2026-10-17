import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { migrationsFolder } from "../src/migrate.js";

const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta/_journal.json"), "utf8")) as {
  entries: { idx: number; tag: string }[];
};
const SHOWN = new Date("2026-01-08T04:40:00Z");

let client: PGlite;
const ids = { pending: randomUUID(), shown: randomUUID(), withheld: randomUUID() };

const stamps = async (id: string) => {
  const { rows } = await client.query<{
    notice_sent_at: Date | null;
    team_visible_at: Date | null;
  }>("select notice_sent_at, team_visible_at from content_access_grants where id = $1", [id]);
  return rows[0];
};

beforeAll(async () => {
  client = new PGlite();
  for (const entry of journal.entries.filter((e) => e.idx < 56)) {
    await client.exec(readFileSync(join(migrationsFolder, `${entry.tag}.sql`), "utf8"));
  }
  const team = randomUUID();
  await client.query("insert into teams (id, name, slug) values ($1, 'Acme', 'acme')", [team]);
  const grant = (id: string, noticeSentAt: Date | null, teamVisibleAt: Date | null) =>
    client.query(
      `insert into content_access_grants
         (id, team_id, operator_user_id, reason, justification, scope, email_ids,
          created_at, expires_at, notice_sent_at, team_visible_at)
       values ($1, $2, 'op', 'phishing_or_malware', 'a lure the insights cannot explain',
               'email', '[]', '2026-01-01T00:00:00Z', '2026-01-01T00:30:00Z', $3, $4)`,
      [id, team, noticeSentAt, teamVisibleAt],
    );
  await grant(ids.pending, null, null);
  await grant(ids.shown, SHOWN, SHOWN);
  await grant(ids.withheld, SHOWN, null);
  await client.exec(
    readFileSync(join(migrationsFolder, "0056_withhold_pending_reveal_notices.sql"), "utf8"),
  );
});
afterAll(() => client.close());

it("marks a grant still waiting for its disclosure as withheld", async () => {
  const pending = await stamps(ids.pending);
  expect(pending?.notice_sent_at).toBeInstanceOf(Date);
  expect(pending?.team_visible_at).toBeNull();
});

it("leaves the grants an earlier build already settled as they were", async () => {
  expect(await stamps(ids.shown)).toEqual({ notice_sent_at: SHOWN, team_visible_at: SHOWN });
  expect(await stamps(ids.withheld)).toEqual({ notice_sent_at: SHOWN, team_visible_at: null });
});
