import { randomBytes } from "node:crypto";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type AcceptEmailPayload,
  acceptEmail,
  MAX_ATTACHMENT_BYTES,
  QUOTA_BACKLOG_DAYS,
} from "../src/accept-email.js";
import { EnvKeyring } from "../src/crypto/keyring.js";
import { PLAN_DAILY_LIMIT } from "../src/plans.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;
let domainId: string;
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
const enqueued: string[] = [];

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db);
  const [domain] = await db
    .insert(schema.domains)
    .values({ teamId, name: "acme.dev", region: "us-east-1", status: "verified" })
    .returning({ id: schema.domains.id });
  if (!domain) throw new Error("domain insert failed");
  domainId = domain.id;
});
afterAll(() => close());

const deps = () => ({
  db,
  keyring,
  isCloud: true,
  enqueueEmailSend: async (id: string) => {
    enqueued.push(id);
  },
});
const auth = () => ({ teamId, plan: "free" as const, apiKeyId: null });
const payload = (over: Partial<AcceptEmailPayload> = {}): AcceptEmailPayload => ({
  from: "a@acme.dev",
  to: ["r@example.com"],
  subject: "s",
  text: "t",
  domainId,
  ...over,
});
const acceptedToday = async () => {
  const [row] = await db
    .select({ accepted: schema.usageCounters.accepted })
    .from(schema.usageCounters)
    .where(eq(schema.usageCounters.teamId, teamId));
  return row?.accepted ?? 0;
};

describe("acceptEmail", () => {
  it("charges quota per distinct recipient across to/cc/bcc", async () => {
    const before = await acceptedToday();
    const result = await acceptEmail(deps(), auth(), {
      ...payload(),
      to: ["one@example.com", "Two <two@example.com>"],
      cc: ["two@example.com", "three@example.com"],
      bcc: ["THREE@example.com", "four@example.com"],
    });
    expect(result).toMatchObject({ ok: true, parked: false });
    expect((await acceptedToday()) - before).toBe(4);
  });

  it("rejects attachments whose decoded bytes exceed the cap", async () => {
    const content = Buffer.alloc(MAX_ATTACHMENT_BYTES / 2 + 1).toString("base64");
    const result = await acceptEmail(deps(), auth(), {
      ...payload(),
      attachments: [
        { filename: "a.bin", content },
        { filename: "b.bin", content },
      ],
    });
    expect(result).toEqual({
      ok: false,
      reason: "attachments_too_large",
      maxBytes: MAX_ATTACHMENT_BYTES,
    });
  });

  it("parks over-quota mail until the backlog cap, then refuses", async () => {
    const limit = PLAN_DAILY_LIMIT.free as number;
    await db
      .update(schema.usageCounters)
      .set({ accepted: limit })
      .where(eq(schema.usageCounters.teamId, teamId));
    const parkedBefore = (
      await db
        .select({ id: schema.emails.id })
        .from(schema.emails)
        .where(
          and(eq(schema.emails.teamId, teamId), eq(schema.emails.latestStatus, "queued_quota")),
        )
    ).length;
    const cap = limit * QUOTA_BACKLOG_DAYS;
    // Bulk-insert up to one short of the cap; acceptEmail itself parks the last slot.
    await db.insert(schema.emails).values(
      Array.from({ length: cap - 1 - parkedBefore }, () => ({
        teamId,
        domainId,
        from: "a@acme.dev",
        to: ["r@example.com"],
        subject: "s",
        latestStatus: "queued_quota" as const,
      })),
    );
    const parked = await acceptEmail(deps(), auth(), payload());
    expect(parked).toMatchObject({ ok: true, parked: true });
    const refused = await acceptEmail(deps(), auth(), payload());
    expect(refused).toEqual({ ok: false, reason: "quota_backlog_full" });
  });
});
