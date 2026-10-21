import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { deleteTopic } from "../src/topics.js";

let db: Awaited<ReturnType<typeof createTestDb>>["db"];
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

async function seedTopic(teamId: string, name: string): Promise<string> {
  const [topic] = await db
    .insert(schema.topics)
    .values({ teamId, name, defaultSubscribed: true })
    .returning({ id: schema.topics.id });
  if (!topic) throw new Error("topic insert failed");
  return topic.id;
}

async function topicExists(topicId: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.topics.id })
    .from(schema.topics)
    .where(eq(schema.topics.id, topicId));
  return rows.length > 0;
}

it("refuses another team's topic, and one a broadcast uses", async () => {
  const teamId = await createTeam(db, "topic-delete-held");
  const otherTeam = await createTeam(db, "topic-delete-other");
  const topicId = await seedTopic(teamId, "Held");

  expect(await deleteTopic(db, otherTeam, topicId)).toBe("not_found");

  await db
    .insert(schema.broadcasts)
    .values({ teamId, from: "Acme <a@acme.dev>", subject: "Scoped", topicId });
  expect(await deleteTopic(db, teamId, topicId)).toBe("in_broadcast");
  expect(await topicExists(topicId)).toBe(true);
});

it("refuses while an email sent with the topic still waits to go out, and deletes once none does", async () => {
  const teamId = await createTeam(db, "topic-delete-waiting");
  for (const [latestStatus, settled] of [
    ["queued", "canceled"],
    ["queued_quota", "sent"],
  ] as const) {
    const topicId = await seedTopic(teamId, `Waiting ${latestStatus}`);
    const [email] = await db
      .insert(schema.emails)
      .values({
        teamId,
        from: "a@acme.dev",
        to: ["ada@example.com"],
        subject: "later",
        topicId,
        latestStatus,
      })
      .returning({ id: schema.emails.id });
    if (!email) throw new Error("email insert failed");

    expect(await deleteTopic(db, teamId, topicId)).toBe("emails_waiting");
    expect(await topicExists(topicId)).toBe(true);

    // Once it has gone out or been canceled, it no longer holds the topic.
    await db
      .update(schema.emails)
      .set({ latestStatus: settled })
      .where(eq(schema.emails.id, email.id));
    expect(await deleteTopic(db, teamId, topicId)).toBeNull();
    expect(await topicExists(topicId)).toBe(false);
    const [sent] = await db
      .select({ topicId: schema.emails.topicId })
      .from(schema.emails)
      .where(eq(schema.emails.id, email.id));
    expect(sent?.topicId).toBeNull();
  }
});

it("doesn't wait for an email SES already has, whatever its status still says", async () => {
  const teamId = await createTeam(db, "topic-delete-handed");
  const topicId = await seedTopic(teamId, "Handed over");
  await db.insert(schema.emails).values({
    teamId,
    from: "a@acme.dev",
    to: ["ada@example.com"],
    subject: "gone",
    topicId,
    sesMessageId: "ses-handed-over",
  });

  expect(await deleteTopic(db, teamId, topicId)).toBeNull();
});
