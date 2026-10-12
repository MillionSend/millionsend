import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, expect, it } from "vitest";
import { migrationsFolder } from "../src/migrate.js";

const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta/_journal.json"), "utf8")) as {
  entries: { idx: number; tag: string }[];
};
const migration = (idx: number) => {
  const entry = journal.entries.find((e) => e.idx === idx);
  if (!entry) throw new Error(`no migration ${idx}`);
  return readFileSync(join(migrationsFolder, `${entry.tag}.sql`), "utf8");
};
const BACKFILL = 51;
const TODAY = "(now() AT TIME ZONE 'UTC')::date";

let client: PGlite;
afterAll(() => client.close());

it("fills in the trailing week's sends no recipient can report, never past the day's sends", async () => {
  client = new PGlite();
  for (const entry of journal.entries.filter((e) => e.idx < BACKFILL)) {
    await client.exec(migration(entry.idx));
  }
  const teamId = randomUUID();
  await client.query("insert into teams (id, name, slug) values ($1, 't', 't')", [teamId]);
  /** A send `daysAgo` days back from now, or still queued when null. */
  const send = (daysAgo: number | null, to: string[], cc?: string[], bcc?: string[]) =>
    client.query(
      `insert into emails (team_id, "from", "to", cc, bcc, subject, sent_at)
       values ($1, 'f@a.example', $2, $3, $4, 's', now() - make_interval(days => $5))`,
      [
        teamId,
        JSON.stringify(to),
        cc ? JSON.stringify(cc) : null,
        bcc ? JSON.stringify(bcc) : null,
        daysAgo,
      ],
    );
  const counters = (daysAgo: number, sent: number) =>
    client.query(
      `insert into usage_counters (team_id, day, sent) values ($1, ${TODAY} - $2::int, $3)`,
      [teamId, daysAgo, sent],
    );
  await send(0, ["Ana <ana@GMail.COM>"]);
  await send(0, ["b@icloud.com"], ["c@me.com"], ["d@t-online.de"]);
  await send(0, ["e@gmail.com"], undefined, ["f@example.com"]);
  await send(0, []);
  await send(null, ["g@gmail.com"]);
  await counters(0, 4);
  // More rows than the day counted sends.
  await send(1, ["h@googlemail.com"]);
  await send(1, ["i@googlemail.com"]);
  await counters(1, 1);
  // The oldest day the week reads, and the day before it.
  await send(6, ["j@magenta.de"]);
  await counters(6, 5);
  await send(7, ["k@gmail.com"]);
  await counters(7, 1);

  await client.exec(migration(BACKFILL));
  const { rows } = await client.query<{ days_ago: number; sent_no_feedback: number }>(
    `select ${TODAY} - day as days_ago, sent_no_feedback from usage_counters
     where team_id = $1 order by day desc`,
    [teamId],
  );
  expect(rows).toEqual([
    { days_ago: 0, sent_no_feedback: 2 },
    { days_ago: 1, sent_no_feedback: 1 },
    { days_ago: 6, sent_no_feedback: 1 },
    { days_ago: 7, sent_no_feedback: 0 },
  ]);
});
