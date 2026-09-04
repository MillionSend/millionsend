import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { afterAll, beforeAll, expect, it } from "vitest";
import { findSuppressed, hashRecipient } from "../src/index.js";

let db: Awaited<ReturnType<typeof createTestDb>>["db"];
let close: () => Promise<void>;
let teamId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "suppression-scope");
  await db.insert(schema.suppressions).values([
    {
      teamId,
      email: "opted@example.com",
      emailHash: hashRecipient("opted@example.com"),
      reason: "one_click_unsubscribe",
    },
    {
      teamId,
      email: "bounced@example.com",
      emailHash: hashRecipient("bounced@example.com"),
      reason: "hard_bounce",
    },
    {
      teamId,
      email: "blocked@example.com",
      emailHash: hashRecipient("blocked@example.com"),
      reason: "manual",
    },
  ]);
});
afterAll(() => close());

const recipients = [
  "opted@example.com",
  "bounced@example.com",
  "blocked@example.com",
  "fine@example.com",
];

it("a recipient's own unsubscribe blocks topic and broadcast sends but not transactional ones", async () => {
  expect([...(await findSuppressed(db, teamId, recipients))].sort()).toEqual([
    "blocked@example.com",
    "bounced@example.com",
    "opted@example.com",
  ]);
  expect(
    [...(await findSuppressed(db, teamId, recipients, { transactional: true }))].sort(),
  ).toEqual(["blocked@example.com", "bounced@example.com"]);
  expect([
    ...(await findSuppressed(db, teamId, recipients, { transactional: false })),
  ]).toHaveLength(3);
});
