import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { purgeExpiredReceivedContent, purgeInboxData } from "../src/handlers/cron.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;
let inboxId: string;
const NOW = new Date("2026-10-12T00:00:00Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "inbox-retention");
  const [domain] = await db
    .insert(schema.domains)
    .values({ teamId, name: "in.retention.test", region: "us-east-1", status: "verified" })
    .returning({ id: schema.domains.id });
  const [inbox] = await db
    .insert(schema.inboxes)
    .values({
      teamId,
      kind: "agent",
      emailAddress: "bot@in.retention.test",
      localPart: "bot",
      domainId: domain?.id ?? null,
      name: "Bot",
      safety: {
        accept_from: "verified",
        allowlist: [],
        owner_addresses: [],
        screening: true,
        extract_codes: true,
        send_policy: "reply_only",
        require_approval: false,
        private_codes: true,
        send_cap: 200,
        forward_to: [],
      },
    })
    .returning({ id: schema.inboxes.id });
  inboxId = inbox?.id as string;
});
afterEach(() => close());

async function received(ageDays: number, sha: string): Promise<string> {
  const [row] = await db
    .insert(schema.receivedEmails)
    .values({
      teamId,
      domainIds: [],
      rawSha256: sha.padEnd(64, "0"),
      messageId: "<m@x>",
      from: "a@sender.example",
      receivedFor: ["bot@in.retention.test"],
      envelope: { mailFrom: "", clientIp: "192.0.2.1", helo: "h", tls: null },
      authentication: { spf: "pass", dkim: "pass", dmarc: "pass", arc: "none" },
      sizeBytes: 6,
      rawCiphertext: Buffer.from("sealed"),
      rawIv: Buffer.from("iv"),
      rawWrappedDek: Buffer.from("dek"),
      rawKeyVersion: 2_000_001,
      extracted: "sealed-read",
      createdAt: ago(ageDays),
    })
    .returning({ id: schema.receivedEmails.id });
  return row?.id as string;
}

const thread = async () =>
  (
    await db
      .insert(schema.inboxThreads)
      .values({ teamId, inboxId })
      .returning({ id: schema.inboxThreads.id })
  )[0]?.id as string;

it("empties the sealed extracted read with the rest of the content (S25)", async () => {
  const old = await received(31, "a");
  const fresh = await received(1, "b");
  expect(await purgeExpiredReceivedContent(db, { defaultRetentionDays: 30, now: NOW })).toBe(1);
  const [oldRow] = await db
    .select()
    .from(schema.receivedEmails)
    .where(eq(schema.receivedEmails.id, old));
  const [freshRow] = await db
    .select()
    .from(schema.receivedEmails)
    .where(eq(schema.receivedEmails.id, fresh));
  expect(oldRow?.extracted).toBeNull();
  expect(freshRow?.extracted).toBe("sealed-read");
});

it("purges inbox data on its clocks: empty threads, drafts, activity, correspondents, usage, secrets", async () => {
  const empty = await thread();
  const kept = await thread();
  const withDraft = await thread();
  const row = await received(1, "c");
  await db.insert(schema.receivedEmailInboxes).values({
    receivedEmailId: row,
    inboxId,
    teamId,
    threadId: kept,
    address: "bot@in.retention.test",
    senderTrust: "external",
    verdict: "clean",
  });
  const draft = (values: Partial<typeof schema.inboxDrafts.$inferInsert>) =>
    db
      .insert(schema.inboxDrafts)
      .values({ teamId, inboxId, type: "standalone", createdBy: "system", ...values })
      .returning({ id: schema.inboxDrafts.id });
  await draft({
    type: "reply",
    threadId: withDraft,
    replyToEmailId: row,
    status: "draft",
    bodyCiphertext: Buffer.from("x"),
    updatedAt: ago(1),
  });
  const [oldBody] = await draft({
    bodyCiphertext: Buffer.from("x"),
    bodyIv: Buffer.from("i"),
    updatedAt: ago(40),
  });
  await draft({ updatedAt: ago(100) });
  await db.insert(schema.inboxActivity).values([
    { teamId, inboxId, actor: "system", action: "email.quarantined", createdAt: ago(100) },
    { teamId, inboxId, actor: "system", action: "email.quarantined", createdAt: ago(1) },
  ]);
  await db.insert(schema.inboxCorrespondents).values([
    { inboxId, address: "old@x.example", lastSeenAt: ago(100) },
    { inboxId, address: "new@x.example", lastSeenAt: ago(1) },
  ]);
  await db.insert(schema.inboxUsageDaily).values([
    { inboxId, day: "2026-08-01", received: 1 },
    { inboxId, day: "2026-10-11", received: 1 },
  ]);
  await db.insert(schema.receivedSecrets).values([
    {
      teamId,
      mac: Buffer.alloc(32, 1),
      receivedEmailId: row,
      kind: "code",
      createdAt: new Date(NOW.getTime() - 25 * 3_600_000),
    },
    {
      teamId,
      mac: Buffer.alloc(32, 2),
      receivedEmailId: row,
      kind: "code",
      createdAt: new Date(NOW.getTime() - 3_600_000),
    },
  ]);

  expect(await purgeInboxData(db, { contentDays: 30, metadataDays: 90, now: NOW })).toEqual({
    inboxEmptyThreads: 1,
    inboxDraftBodies: 2,
    inboxDrafts: 1,
    inboxActivity: 1,
    inboxCorrespondents: 1,
    inboxUsage: 1,
    receivedSecrets: 1,
  });
  const threads = (await db.select({ id: schema.inboxThreads.id }).from(schema.inboxThreads)).map(
    (t) => t.id,
  );
  expect(threads.sort()).toEqual([kept, withDraft].sort());
  expect(threads).not.toContain(empty);
  const [purged] = await db
    .select()
    .from(schema.inboxDrafts)
    .where(eq(schema.inboxDrafts.id, oldBody?.id ?? ""));
  expect(purged).toMatchObject({ bodyCiphertext: null, bodyIv: null, bodyPurgedAt: NOW });
  expect((await db.select().from(schema.inboxCorrespondents)).map((c) => c.address)).toEqual([
    "new@x.example",
  ]);
});
