import { randomBytes } from "node:crypto";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq } from "drizzle-orm";
import { createTransport } from "nodemailer";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type AcceptEmailPayload,
  acceptEmail,
  estimateMimeBytes,
  MAX_ATTACHMENT_BYTES,
  QUOTA_BACKLOG_DAYS,
  SES_MAX_MESSAGE_BYTES,
  SYSTEM_MAIL_TAG,
} from "../src/accept-email.js";
import { EnvKeyring } from "../src/crypto/keyring.js";
import { OVERAGE_HARD_CAP, QUOTA_TOLERANCE, type QuotaTeamRow, teamRung } from "../src/plans.js";
import { readPeriodUsage } from "../src/quota.js";
import { hashRecipient } from "../src/suppressions.js";
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
afterEach(() => {
  vi.unstubAllEnvs();
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
  planStatus: "none",
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

  it("charges a send scheduled in the past to today: an earlier day's quota never reopens", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-09T10:00:00Z"), toFake: ["Date"] });
    try {
      const team = await createTeam(db, "backdated-sender");
      const [old] = await db
        .insert(schema.domains)
        .values({
          teamId: team,
          name: "backdated.dev",
          region: "us-east-1",
          status: "verified",
          registeredAt: new Date("2014-01-01T00:00:00Z"),
        })
        .returning({ id: schema.domains.id });
      const ceiling = Math.floor(teamRung("free", null).included * (1 + QUOTA_TOLERANCE));
      await db
        .insert(schema.usageCounters)
        .values({ teamId: team, day: "2026-10-09", accepted: ceiling });
      const result = await acceptEmail(
        deps(),
        { teamId: team, billing: FREE, apiKeyId: null },
        payload({
          from: "a@backdated.dev",
          domainId: old?.id ?? null,
          scheduledAt: new Date("2026-10-06T10:00:00Z"),
        }),
      );
      expect(result).toMatchObject({ ok: true, parked: true, day: "2026-10-09" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses over 10 MiB of attachments, or a send SES would refuse once encoded", async () => {
    const overCap = Buffer.alloc(MAX_ATTACHMENT_BYTES + 3).toString("base64");
    expect(
      await acceptEmail(deps(), auth(), {
        ...payload(),
        attachments: [{ filename: "a.bin", content: overCap }],
      }),
    ).toEqual({ ok: false, reason: "attachments_too_large", maxBytes: MAX_ATTACHMENT_BYTES });
    // 9 MiB of files under 30 MiB of html: over 40 MiB as the worker builds the message.
    const nine = Buffer.alloc(9 * 1024 * 1024).toString("base64");
    expect(
      await acceptEmail(deps(), auth(), {
        ...payload(),
        html: "a".repeat(30 * 1024 * 1024),
        attachments: [{ filename: "a.bin", content: nine }],
      }),
    ).toEqual({ ok: false, reason: "attachments_too_large", maxBytes: SES_MAX_MESSAGE_BYTES });
  });

  it("measures the worker's MIME message from above, and closely", async () => {
    const transport = createTransport({ streamTransport: true, buffer: true });
    for (const [mib, html] of [
      [1, "<p>hi</p>"],
      [29, `<p>Olá, ${"número ".repeat(5000)}</p>`],
    ] as const) {
      const content = Buffer.alloc(mib * 1024 * 1024, 7).toString("base64");
      const email = {
        subject: "Pedido nº 42",
        html,
        text: "hi",
        headers: { "X-Entity-Ref-ID": "r1" },
      };
      const built = await transport.sendMail({
        from: "a@acme.dev",
        to: "b@example.com",
        ...email,
        attachments: [{ filename: "a.bin", content, encoding: "base64" }],
      });
      const estimate = estimateMimeBytes({ ...email, attachments: [{ content }] });
      expect(estimate).toBeGreaterThanOrEqual((built.message as Buffer).length);
      expect(estimate - (built.message as Buffer).length).toBeLessThan(64 * 1024);
    }
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

  it("refuses a monthly plan at its included volume with overage off, bills past it with overage on, and stops at the hard cap", async () => {
    const monthly = await createTeam(db, "monthly");
    const periodStart = new Date(Date.now() - DAY_MS);
    const periodEnd = new Date(Date.now() + 20 * DAY_MS);
    const billing: QuotaTeamRow = {
      plan: "pro",
      planQuota: 100_000,
      planStatus: "active",
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
    expect(refused).toEqual({
      ok: false,
      reason: "monthly_quota_exceeded",
      periodEnd,
      overage: false,
    });
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
    await db
      .update(schema.usagePeriods)
      .set({ accepted: 100_000 * OVERAGE_HARD_CAP })
      .where(eq(schema.usagePeriods.teamId, monthly));
    const capped = await acceptEmail(
      deps(),
      { teamId: monthly, billing: { ...billing, overageEnabled: true }, apiKeyId: null },
      payload({ domainId: null }),
    );
    expect(capped).toEqual({
      ok: false,
      reason: "monthly_quota_exceeded",
      periodEnd,
      overage: true,
    });
  });

  it("charges a past scheduled_at to today, so a full day parks it instead of an unspent past one", async () => {
    const backdating = await createTeam(db, "backdating");
    const ceiling = Math.floor(teamRung("free", null).included * (1 + QUOTA_TOLERANCE));
    await db
      .insert(schema.usageCounters)
      .values({ teamId: backdating, day: utcDay(), accepted: ceiling });
    const past = new Date(Date.now() - 3 * DAY_MS);
    const result = await acceptEmail(
      deps(),
      { teamId: backdating, billing: FREE, apiKeyId: null },
      payload({ domainId: null, scheduledAt: past }),
    );
    expect(result).toMatchObject({ ok: true, parked: true, day: utcDay() });
    const days = await db
      .select({ day: schema.usageCounters.day, accepted: schema.usageCounters.accepted })
      .from(schema.usageCounters)
      .where(eq(schema.usageCounters.teamId, backdating));
    expect(days).toEqual([{ day: utcDay(), accepted: ceiling }]);
  });

  it("refuses a suspended or paused team before writing anything; account mail still lands", async () => {
    const held = await createTeam(db, "held");
    const heldAuth = { teamId: held, billing: FREE, apiKeyId: null };
    const rows = () =>
      db.select({ id: schema.emails.id }).from(schema.emails).where(eq(schema.emails.teamId, held));

    await db
      .update(schema.teams)
      .set({ suspendedAt: new Date(), suspensionReason: "manual" })
      .where(eq(schema.teams.id, held));
    expect(await acceptEmail(deps(), heldAuth, payload({ domainId: null }))).toEqual({
      ok: false,
      reason: "team_suspended",
      suspension: "manual",
    });

    await db
      .update(schema.teams)
      .set({ suspendedAt: null, suspensionReason: null })
      .where(eq(schema.teams.id, held));
    // 10% hard bounces over 200 sends: past the volume floor and the event minimum.
    await db
      .insert(schema.usageCounters)
      .values({ teamId: held, day: utcDay(), sent: 200, hardBounced: 20 });
    expect(await acceptEmail(deps(), heldAuth, payload({ domainId: null }))).toMatchObject({
      ok: false,
      reason: "sending_paused",
      pause: { metric: "bounce", tier: "paused" },
    });
    expect(await rows()).toEqual([]);

    const account = await acceptEmail(
      deps(),
      { ...heldAuth, billing: "uncapped" },
      payload({ domainId: null }),
    );
    expect(account).toMatchObject({ ok: true, parked: false });
    expect(await rows()).toHaveLength(1);
  });

  it("keeps the system-mail mark on the account-mail path alone", async () => {
    const tagged = await createTeam(db, "tagged");
    const tags = { [SYSTEM_MAIL_TAG]: "password_reset", campaign: "launch" };
    const storedTags = async (billing: QuotaTeamRow | "uncapped") => {
      const result = await acceptEmail(
        deps(),
        { teamId: tagged, billing, apiKeyId: null },
        payload({ domainId: null, tags }),
      );
      if (!result.ok) throw new Error(result.reason);
      const [row] = await db
        .select({ tags: schema.emails.tags })
        .from(schema.emails)
        .where(eq(schema.emails.id, result.id));
      return row?.tags;
    };
    expect(await storedTags(FREE)).toEqual({ campaign: "launch" });
    expect(await storedTags("uncapped")).toEqual(tags);
  });

  it("keeps a refused send's tags on its suppressed record, the system-mail mark dropped", async () => {
    const refusing = await createTeam(db, "record-tags");
    await db.insert(schema.suppressions).values({
      teamId: refusing,
      email: "gone@example.com",
      emailHash: hashRecipient("gone@example.com"),
      reason: "hard_bounce",
    });
    const result = await acceptEmail(
      deps(),
      { teamId: refusing, billing: FREE, apiKeyId: null },
      payload({
        domainId: null,
        to: ["gone@example.com"],
        tags: { [SYSTEM_MAIL_TAG]: "password_reset", campaign: "launch" },
      }),
      { recordSuppressed: true },
    );
    expect(result).toEqual({ ok: false, reason: "all_suppressed" });
    const rows = await db
      .select({ status: schema.emails.latestStatus, tags: schema.emails.tags })
      .from(schema.emails)
      .where(eq(schema.emails.teamId, refusing));
    expect(rows).toEqual([{ status: "suppressed", tags: { campaign: "launch" } }]);
  });

  it("refuses a recipient whose domain can never receive mail, unless the caller checked already", async () => {
    vi.stubEnv("RECIPIENT_DOMAIN_CHECK", "on");
    const teamAuth = { teamId: await createTeam(db, "unreachable"), billing: FREE, apiKeyId: null };
    const impossible = payload({
      domainId: null,
      to: ["success@simulator.amazonses.com"],
      cc: ["Printer <X@Printer.LOCAL>"],
      bcc: ["x@mail.example.com"],
    });
    expect(await acceptEmail(deps(), teamAuth, impossible)).toEqual({
      ok: false,
      reason: "undeliverable_recipient",
      address: "x@printer.local",
      why: "reserved_name",
    });
    expect(
      await acceptEmail(deps(), teamAuth, impossible, { recipientsChecked: true }),
    ).toMatchObject({ ok: true, parked: false });
  });

  it("shares one daily cap between the Free teams of one creator, a deleted team's sends included", async () => {
    const owner = "u-accept-pool";
    const a = await createTeam(db, "accept-pool-a", { poolOwnerId: owner });
    const b = await createTeam(db, "accept-pool-b", { poolOwnerId: owner });
    const pooled = (team: string) => ({
      teamId: team,
      billing: { ...FREE, poolOwnerId: owner },
      apiKeyId: null,
    });
    const ceiling = Math.floor(teamRung("free", null).included * (1 + QUOTA_TOLERANCE));
    const send = payload({ domainId: null });
    const ownAccepted = async (team: string) => {
      const [row] = await db
        .select({ accepted: schema.usageCounters.accepted })
        .from(schema.usageCounters)
        .where(eq(schema.usageCounters.teamId, team));
      return row?.accepted ?? 0;
    };
    expect(await acceptEmail(deps(), pooled(a), send)).toMatchObject({ ok: true, parked: false });
    // The rest of the pool's day but one, spent elsewhere in it.
    await db
      .update(schema.freePoolUsage)
      .set({ accepted: ceiling - 1 })
      .where(eq(schema.freePoolUsage.ownerId, owner));
    expect(await acceptEmail(deps(), pooled(b), send)).toMatchObject({ ok: true, parked: false });
    // a has sent once of its own, yet the pool is spent: it parks.
    expect(await acceptEmail(deps(), pooled(a), send)).toMatchObject({ ok: true, parked: true });
    expect(await ownAccepted(a)).toBe(1);
    await db.delete(schema.teams).where(eq(schema.teams.id, b));
    expect(await acceptEmail(deps(), pooled(a), send)).toMatchObject({ ok: true, parked: true });
  });

  it("refuses every Free team of a creator once their shared complaints pause the pool", async () => {
    const owner = "u-accept-paused";
    await db
      .insert(schema.freePoolUsage)
      .values({ ownerId: owner, day: utcDay(), sent: 20, complained: 3 });
    for (const slug of ["accept-paused-a", "accept-paused-b"]) {
      const team = await createTeam(db, slug, { poolOwnerId: owner });
      expect(
        await acceptEmail(
          deps(),
          { teamId: team, billing: { ...FREE, poolOwnerId: owner }, apiKeyId: null },
          payload({ domainId: null }),
        ),
      ).toMatchObject({ ok: false, reason: "sending_paused" });
    }
  });

  it("leaves a paid team, an unrecorded Free team and a self-hosted team out of any pool", async () => {
    const owner = "u-accept-full";
    await db
      .insert(schema.freePoolUsage)
      .values({ ownerId: owner, day: utcDay(), accepted: 1_000 });
    const send = payload({ domainId: null });
    const paid = await createTeam(db, "accept-paid", { poolOwnerId: owner });
    await db.update(schema.teams).set({ plan: "starter" }).where(eq(schema.teams.id, paid));
    expect(
      await acceptEmail(
        deps(),
        { teamId: paid, billing: { ...FREE, plan: "starter", poolOwnerId: owner }, apiKeyId: null },
        send,
      ),
    ).toMatchObject({ ok: true, parked: false });
    const unrecorded = await createTeam(db, "accept-unrecorded");
    expect(
      await acceptEmail(deps(), { teamId: unrecorded, billing: FREE, apiKeyId: null }, send),
    ).toMatchObject({ ok: true, parked: false });
    const selfHosted = await createTeam(db, "accept-self-host", { poolOwnerId: owner });
    expect(
      await acceptEmail(
        { ...deps(), isCloud: false },
        { teamId: selfHosted, billing: { ...FREE, poolOwnerId: owner }, apiKeyId: null },
        send,
      ),
    ).toMatchObject({ ok: true, parked: false });
  });
});
