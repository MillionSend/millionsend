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
const MOVE = 66;
const TODAY = "(now() AT TIME ZONE 'UTC')::date";

let client: PGlite;
afterAll(() => client.close());

it("moves each complaint it can still classify from the day it arrived to its mail's send day", async () => {
  client = new PGlite();
  for (const entry of journal.entries.filter((e) => e.idx < MOVE)) {
    await client.exec(migration(entry.idx));
  }
  const { rows: teams } = await client.query<{ id: string }>(
    "insert into teams (name, slug) values ('t', 't') returning id",
  );
  const teamId = teams[0]?.id;
  /** Adds `n` to a counter of the team's day `daysAgo` UTC days back. */
  const bump = (daysAgo: number, column: "sent" | "complained", n = 1) =>
    client.query(
      `insert into usage_counters (team_id, day, ${column}) values ($1, ${TODAY} - $2::int, $3)
       on conflict (team_id, day) do update set ${column} = usage_counters.${column} + $3`,
      [teamId, daysAgo, n],
    );
  /** The stored payload of a complaint about mail to `to`. */
  const payload = (to: string, complaintSubType?: string) => ({
    eventType: "Complaint",
    complaint: { complainedRecipients: [{ emailAddress: to }], complaintSubType },
  });
  /**
   * Mail sent `sentDaysAgo` and SES's complaint about it `arrivedDaysAgo`,
   * on the arrival day's counter when older releases counted it.
   */
  const complaint = async (
    sentDaysAgo: number,
    arrivedDaysAgo: number,
    data: object | null,
    counted: boolean,
  ) => {
    const { rows } = await client.query<{ id: string }>(
      `insert into emails (team_id, "from", "to", subject, sent_at)
       values ($1, 'f@example.com', '["r@example.com"]', 's', now() - make_interval(days => $2))
       returning id`,
      [teamId, sentDaysAgo],
    );
    await client.query(
      `insert into email_events (email_id, type, occurred_at, created_at, sns_message_id, data)
       values ($1, 'complained', now() - make_interval(days => $2), now() - make_interval(days => $2),
               gen_random_uuid()::text, $3)`,
      [rows[0]?.id, arrivedDaysAgo, data === null ? null : JSON.stringify(data)],
    );
    if (counted) await bump(arrivedDaysAgo, "complained");
  };
  await bump(0, "sent", 100);
  await bump(1, "sent", 100);
  await bump(3, "sent", 1000);
  await complaint(3, 0, payload("a@example.com"), true);
  await complaint(1, 1, payload("b@example.com"), true);
  // Stamped as sent after it arrived: a move only ever goes back in time.
  await complaint(0, 1, payload("f@example.com"), true);
  // Never counted, so nothing to move.
  await complaint(5, 0, payload("complaint@simulator.amazonses.com"), false);
  await complaint(5, 0, payload("c@example.com", "OnAccountSuppressionList"), false);
  // Stripped: it cannot say whether it was counted.
  await complaint(5, 0, null, true);
  // Counted, its email row since purged.
  await bump(0, "complained");
  // A send day whose `sent` was never counted has no row yet.
  await complaint(9, 2, payload("d@example.com"), true);
  // Arrived before the scan's 31 days.
  await complaint(45, 40, payload("e@example.com"), true);
  const total = async () =>
    (
      await client.query<{ n: number }>(
        "select sum(complained)::int as n from usage_counters where team_id = $1",
        [teamId],
      )
    ).rows[0]?.n;
  expect(await total()).toBe(7);

  await client.exec(migration(MOVE));
  const { rows } = await client.query<{ days_ago: number; sent: number; complained: number }>(
    `select ${TODAY} - day as days_ago, sent, complained from usage_counters
     where team_id = $1 order by day desc`,
    [teamId],
  );
  expect(rows).toEqual([
    { days_ago: 0, sent: 100, complained: 2 },
    { days_ago: 1, sent: 100, complained: 2 },
    { days_ago: 2, sent: 0, complained: 0 },
    { days_ago: 3, sent: 1000, complained: 1 },
    { days_ago: 9, sent: 0, complained: 1 },
    { days_ago: 40, sent: 0, complained: 1 },
  ]);
  expect(await total()).toBe(7);
});
