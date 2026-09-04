import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { afterAll, beforeAll, expect, it } from "vitest";
import { findTopicOptOuts } from "../src/topics.js";

let db: Awaited<ReturnType<typeof createTestDb>>["db"];
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

it("a globally unsubscribed contact is opted out of every topic, whatever its per-topic rows say", async () => {
  const teamId = await createTeam(db, "topic-optouts");
  const [topic] = await db
    .insert(schema.topics)
    .values({ teamId, name: "Digest", defaultSubscribed: true })
    .returning({ id: schema.topics.id });
  if (!topic) throw new Error("topic insert failed");
  const [gone, staying] = await db
    .insert(schema.contacts)
    .values([
      { teamId, email: "gone@example.com", unsubscribed: true },
      { teamId, email: "staying@example.com" },
    ])
    .returning({ id: schema.contacts.id });
  if (!gone || !staying) throw new Error("contact insert failed");
  // An explicit opt-in row does not override the global choice.
  await db
    .insert(schema.contactTopicSubscriptions)
    .values({ contactId: gone.id, topicId: topic.id, subscribed: true });

  const optedOut = await findTopicOptOuts(db, teamId, topic.id, [
    "Gone <gone@example.com>",
    "staying@example.com",
    "stranger@example.com",
  ]);
  expect([...optedOut]).toEqual(["Gone <gone@example.com>"]);
});
