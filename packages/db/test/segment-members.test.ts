import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, expect, it } from "vitest";
import { migrateLocked, migrationsFolder } from "../src/migrate.js";

let client: PGlite;
let teamId: string;
let contactId: string;
let segmentId: string;

async function one<T>(query: string, params?: unknown[]): Promise<T> {
  const { rows } = await client.query<T>(query, params);
  const row = rows[0];
  if (row === undefined) throw new Error(`no row: ${query}`);
  return row;
}

beforeAll(async () => {
  client = new PGlite();
  const db = drizzle(client);
  await migrateLocked(db, () => migrate(db, { migrationsFolder }));

  ({ id: teamId } = await one<{ id: string }>(
    "insert into teams (name, slug) values ('t', 't') returning id",
  ));
  ({ id: contactId } = await one<{ id: string }>(
    "insert into contacts (team_id, email) values ($1, 'a@b.test') returning id",
    [teamId],
  ));
  // filter is nullable: a manual-membership-only segment has none.
  ({ id: segmentId } = await one<{ id: string }>(
    "insert into segments (team_id, name) values ($1, 'manual') returning id",
    [teamId],
  ));
});

afterAll(() => client.close());

it("composite PK rejects a duplicate membership", async () => {
  await client.query("insert into segment_members (segment_id, contact_id) values ($1, $2)", [
    segmentId,
    contactId,
  ]);
  await expect(
    client.query("insert into segment_members (segment_id, contact_id) values ($1, $2)", [
      segmentId,
      contactId,
    ]),
  ).rejects.toThrow(/segment_members_segment_id_contact_id_pk/);
});

it("membership cascades away when the contact is deleted", async () => {
  await client.query("delete from contacts where id = $1", [contactId]);
  const { n } = await one<{ n: number }>(
    "select count(*)::int as n from segment_members where segment_id = $1",
    [segmentId],
  );
  expect(n).toBe(0);
});

it("deleting a topic nulls emails.topic_id instead of blocking", async () => {
  const { id: topicId } = await one<{ id: string }>(
    "insert into topics (team_id, name, default_subscribed) values ($1, 'news', true) returning id",
    [teamId],
  );
  const { id: emailId } = await one<{ id: string }>(
    `insert into emails ("team_id", "topic_id", "from", "to", "subject")
     values ($1, $2, 'x@y.test', '["a@b.test"]', 's') returning id`,
    [teamId, topicId],
  );
  await client.query("delete from topics where id = $1", [topicId]);
  const row = await one<{ topic_id: string | null }>("select topic_id from emails where id = $1", [
    emailId,
  ]);
  expect(row.topic_id).toBeNull();
});
