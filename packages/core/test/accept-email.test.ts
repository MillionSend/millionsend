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
  verifyOnboardingSender,
} from "../src/accept-email.js";
import { EnvKeyring } from "../src/crypto/keyring.js";
import { QUOTA_TOLERANCE, type QuotaTeamRow, teamRung } from "../src/plans.js";
import { readPeriodUsage } from "../src/quota.js";
import { DAY_MS, utcDay } from "../src/utc-day.js";

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

describe("verifyOnboardingSender", () => {
  const platform = "MillionSend <onboarding@ms.example>";
  it("only the shared sender qualifies, and only for the team's own members", async () => {
    await db
      .insert(schema.user)
      .values([
        { id: "member-1", name: "Ada", email: "Ada@Example.com", emailVerified: true },
        { id: "member-2", name: "Bob", email: "bob@example.com" },
      ])
      .onConflictDoNothing();
    await db.insert(schema.teamMembers).values([
      { teamId, userId: "member-1", role: "owner" },
      { teamId, userId: "member-2", role: "member" },
    ]);

    expect(
      await verifyOnboardingSender(db, teamId, "a@acme.dev", ["ada@example.com"], platform),
    ).toBeNull();
    expect(
      await verifyOnboardingSender(db, teamId, platform, ["ada@example.com"], undefined),
    ).toBeNull();
    expect(
      await verifyOnboardingSender(
        db,
        teamId,
        "onboarding@ms.example",
        ["ada@example.com"],
        platform,
      ),
    ).toEqual({ ok: true, domainId: null, address: "onboarding@ms.example" });
    expect(
      await verifyOnboardingSender(
        db,
        teamId,
        platform,
        ["Ada <ada@example.com>", "stranger@example.com"],
        platform,
      ),
    ).toEqual({ ok: false, reason: "recipient_not_member" });
    // A member whose address was never verified may be anyone's inbox —
    // unless the instance cannot verify anyone, where members stay reachable.
    expect(
      await verifyOnboardingSender(db, teamId, platform, ["bob@example.com"], platform),
    ).toEqual({ ok: false, reason: "recipient_not_verified" });
    expect(
      await verifyOnboardingSender(db, teamId, platform, ["bob@example.com"], platform, {
        requireVerified: false,
      }),
    ).toMatchObject({ ok: true });
  });
});

const deps = () => ({
  db,
  keyring,
  isCloud: true,
  enqueueEmailSend: async (id: string) => {
    enqueued.push(id);
  },
});
const FREE: QuotaTeamRow = {
  plan: "free",
  planQuota: null,
  currentPeriodStart: null,
  currentPeriodEnd: null,
  overageEnabled: false,
};
const auth = () => ({ teamId, billing: FREE, apiKeyId: null });
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

  it("charges a scheduled send to its delivery day, not the accept day", async () => {
    const scheduledAt = new Date(Date.now() + 3 * DAY_MS);
    const result = await acceptEmail(deps(), auth(), { ...payload(), scheduledAt });
    expect(result).toMatchObject({ ok: true, parked: false });
    const [row] = await db
      .select({ accepted: schema.usageCounters.accepted })
      .from(schema.usageCounters)
      .where(
        and(
          eq(schema.usageCounters.teamId, teamId),
          eq(schema.usageCounters.day, utcDay(scheduledAt)),
        ),
      );
    expect(row?.accepted).toBe(1);
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
    const limit = teamRung("free", null).included;
    // Sends pass through up to the tolerance ceiling before parking starts.
    await db
      .update(schema.usageCounters)
      .set({ accepted: Math.floor(limit * (1 + QUOTA_TOLERANCE)) })
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

  it("refuses a monthly plan at its included volume with overage off, and bills past it with overage on", async () => {
    const monthly = await createTeam(db, "monthly");
    const periodStart = new Date(Date.now() - DAY_MS);
    const periodEnd = new Date(Date.now() + 20 * DAY_MS);
    const billing: QuotaTeamRow = {
      plan: "pro",
      planQuota: 100_000,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      overageEnabled: false,
    };
    await db
      .insert(schema.usagePeriods)
      .values({ teamId: monthly, periodStart, accepted: 100_000 });
    const refused = await acceptEmail(
      deps(),
      { teamId: monthly, billing, apiKeyId: null },
      payload({ domainId: null }),
    );
    expect(refused).toEqual({ ok: false, reason: "monthly_quota_exceeded", periodEnd });
    expect(
      await db
        .select({ id: schema.emails.id })
        .from(schema.emails)
        .where(eq(schema.emails.teamId, monthly)),
    ).toEqual([]);
    const billed = await acceptEmail(
      deps(),
      { teamId: monthly, billing: { ...billing, overageEnabled: true }, apiKeyId: null },
      payload({ domainId: null }),
    );
    expect(billed).toMatchObject({
      ok: true,
      parked: false,
      quota: { kind: "month", overage: true },
    });
    expect(await readPeriodUsage(db, monthly, periodStart)).toEqual({
      accepted: 100_001,
      reportedOverage: 0,
    });
  });
});
