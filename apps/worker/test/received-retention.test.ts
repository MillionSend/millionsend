import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { purgeExpiredReceivedContent, purgeExpiredReceivedMetadata } from "../src/handlers/cron.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;
const NOW = new Date("2026-10-11T00:00:00Z");
const DAY = 86_400_000;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "received-retention");
});
afterEach(() => close());

async function received(ageDays: number, sha: string): Promise<string> {
  const sealed = Buffer.from("sealed");
  const [row] = await db
    .insert(schema.receivedEmails)
    .values({
      teamId,
      domainIds: [],
      rawSha256: sha,
      messageId: "<m@x>",
      from: "a@sender.example",
      to: ["agent@inbound.acme.test"],
      receivedFor: ["agent@inbound.acme.test"],
      subject: `aged ${ageDays}`,
      envelope: { mailFrom: "", clientIp: "192.0.2.1", helo: "h", tls: null },
      authentication: { spf: "pass", dkim: "pass", dmarc: "pass", arc: "none" },
      sizeBytes: 6,
      attachmentCount: 1,
      rawCiphertext: sealed,
      rawIv: sealed,
      rawWrappedDek: sealed,
      rawKeyVersion: 2_000_001,
      attachments: "sealed-list",
      createdAt: new Date(NOW.getTime() - ageDays * DAY),
    })
    .returning({ id: schema.receivedEmails.id });
  if (!row) throw new Error("insert failed");
  return row.id;
}

const rowOf = async (id: string) =>
  (await db.select().from(schema.receivedEmails).where(eq(schema.receivedEmails.id, id)))[0];

it("empties received content on the content clock and keeps the metadata", async () => {
  const old = await received(31, "a".repeat(64));
  const fresh = await received(29, "b".repeat(64));
  expect(await purgeExpiredReceivedContent(db, { defaultRetentionDays: 30, now: NOW })).toBe(1);
  expect(await rowOf(old)).toMatchObject({
    rawCiphertext: null,
    rawIv: null,
    rawWrappedDek: null,
    rawKeyVersion: null,
    attachments: null,
    contentPurgedAt: NOW,
    subject: "aged 31",
    receivedFor: ["agent@inbound.acme.test"],
    attachmentCount: 1,
  });
  expect((await rowOf(fresh))?.rawCiphertext).not.toBeNull();
  // Already purged rows are not visited again.
  expect(await purgeExpiredReceivedContent(db, { defaultRetentionDays: 30, now: NOW })).toBe(0);
  // The instance setting wins over the env default.
  await db.insert(schema.instanceSettings).values({ id: 1, emailRetentionDays: 7 });
  expect(await purgeExpiredReceivedContent(db, { defaultRetentionDays: 30, now: NOW })).toBe(1);
});

it("deletes whole received rows on the metadata clock", async () => {
  const old = await received(31, "c".repeat(64));
  const fresh = await received(29, "d".repeat(64));
  expect(await purgeExpiredReceivedMetadata(db, { retentionDays: 30, now: NOW })).toBe(1);
  expect(await rowOf(old)).toBeUndefined();
  expect(await rowOf(fresh)).toBeDefined();
});
