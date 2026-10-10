import { randomBytes } from "node:crypto";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_MAIL_TAG } from "../src/accept-email.js";
import { ACCOUNT_MAIL_KINDS } from "../src/account-mail.js";
import { EnvKeyring } from "../src/crypto/keyring.js";
import { hashRecipient } from "../src/suppressions.js";
import {
  findSenderDomainOwner,
  SENT_WHILE_SUSPENDED,
  type SenderDomainOwner,
  type SystemMailKind,
  type SystemMailMessage,
  SystemMailRefused,
  sendSystemMail,
} from "../src/system-mail.js";
import {
  SILENT_SUSPENSIONS,
  SUSPENSION_REASONS,
  type SuspensionReason,
} from "../src/team-standing.js";

let db: Db;
let close: () => Promise<void>;
let ownerTeam: string;
let otherTeam: string;
let domainId: string;
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  ownerTeam = await createTeam(db, "owner");
  otherTeam = await createTeam(db, "other");
  const [domain] = await db
    .insert(schema.domains)
    .values({
      teamId: ownerTeam,
      name: "mail.example.com",
      region: "us-east-1",
      status: "verified",
      verifiedAt: new Date("2026-01-01"),
    })
    .returning({ id: schema.domains.id });
  if (!domain) throw new Error("domain insert failed");
  domainId = domain.id;
  // The apex in another team, pending: neither the name nor the status matches.
  await db
    .insert(schema.domains)
    .values({ teamId: otherTeam, name: "example.com", region: "us-east-1", status: "pending" });
});
afterAll(() => close());

const message = (over: Partial<SystemMailMessage> = {}): SystemMailMessage => ({
  from: "MillionSend <no-reply@mail.example.com>",
  to: "ada@example.com",
  subject: "Reset your password",
  html: "<p>hi</p>",
  text: "hi",
  kind: "password_reset",
  ...over,
});

function deps() {
  const enqueued: string[] = [];
  const raw: SystemMailMessage[] = [];
  const rawOwners: (SenderDomainOwner | null)[] = [];
  return {
    enqueued,
    raw,
    rawOwners,
    deps: {
      db,
      keyring,
      isCloud: true,
      enqueueEmailSend: async (id: string) => {
        enqueued.push(id);
      },
      raw: async (m: SystemMailMessage, owner: SenderDomainOwner | null) => {
        raw.push(m);
        rawOwners.push(owner);
      },
    },
  };
}

describe("findSenderDomainOwner", () => {
  it("matches the exact verified host, whatever the display name", async () => {
    expect(await findSenderDomainOwner(db, "Ops <ops@mail.example.com>")).toEqual({
      teamId: ownerTeam,
      domainId,
      region: "us-east-1",
    });
    expect(await findSenderDomainOwner(db, "ops@MAIL.example.com")).toEqual({
      teamId: ownerTeam,
      domainId,
      region: "us-east-1",
    });
  });

  it("does not walk up to the apex, ignore pending rows, or accept a malformed sender", async () => {
    expect(await findSenderDomainOwner(db, "ops@example.com")).toBeNull();
    expect(await findSenderDomainOwner(db, "ops@other.example.com")).toBeNull();
    expect(await findSenderDomainOwner(db, "not an address")).toBeNull();
  });

  it("prefers the oldest verified row when self-host teams share a host", async () => {
    const [later] = await db
      .insert(schema.domains)
      .values({
        teamId: otherTeam,
        name: "mail.example.com",
        region: "us-east-1",
        status: "verified",
        verifiedAt: new Date("2026-06-01"),
      })
      .returning({ id: schema.domains.id });
    expect((await findSenderDomainOwner(db, "x@mail.example.com"))?.teamId).toBe(ownerTeam);
    await db.delete(schema.domains).where(eq(schema.domains.id, later?.id ?? ""));
  });
});

describe("sendSystemMail", () => {
  it("rides the pipeline into the owning team: tagged, unmetered, transactional, enqueued", async () => {
    const d = deps();
    expect(await sendSystemMail(d.deps, message())).toBe("pipeline");
    expect(d.raw).toHaveLength(0);
    expect(d.enqueued).toHaveLength(1);
    const [row] = await db
      .select()
      .from(schema.emails)
      .where(eq(schema.emails.id, d.enqueued[0] ?? ""));
    expect(row).toMatchObject({
      teamId: ownerTeam,
      domainId,
      apiKeyId: null,
      topicId: null,
      from: "MillionSend <no-reply@mail.example.com>",
      to: ["ada@example.com"],
      latestStatus: "queued",
      tags: { [SYSTEM_MAIL_TAG]: "password_reset" },
    });
    // Counted, never parked: plan `scale` nulls the limit while accepted still records.
    const [usage] = await db
      .select({ accepted: schema.usageCounters.accepted })
      .from(schema.usageCounters)
      .where(eq(schema.usageCounters.teamId, ownerTeam));
    expect(usage?.accepted).toBe(1);
  });

  it("falls back to raw when no team owns the sender's domain", async () => {
    const d = deps();
    const m = message({ from: "no-reply@unowned.example.com" });
    expect(await sendSystemMail(d.deps, m)).toBe("raw");
    expect(d.raw).toEqual([m]);
    // No owner: the raw send has no region of its own (the caller's default).
    expect(d.rawOwners).toEqual([null]);
    expect(d.enqueued).toHaveLength(0);
  });

  it("a suppressed recipient is refused, never sent raw", async () => {
    const d = deps();
    await db.insert(schema.suppressions).values({
      teamId: ownerTeam,
      email: "bounced@example.com",
      emailHash: hashRecipient("bounced@example.com"),
      reason: "hard_bounce",
    });
    await expect(sendSystemMail(d.deps, message({ to: "bounced@example.com" }))).rejects.toThrow(
      SystemMailRefused,
    );
    expect(d.raw).toHaveLength(0);
    expect(d.enqueued).toHaveLength(0);
  });

  it("a one-click unsubscribe never blocks account mail", async () => {
    const d = deps();
    await db.insert(schema.suppressions).values({
      teamId: ownerTeam,
      email: "unsubscribed@example.com",
      emailHash: hashRecipient("unsubscribed@example.com"),
      reason: "one_click_unsubscribe",
    });
    expect(await sendSystemMail(d.deps, message({ to: "unsubscribed@example.com" }))).toBe(
      "pipeline",
    );
  });

  it("an accept failure falls back to raw so account mail outlives the pipeline", async () => {
    const d = deps();
    const broken = {
      ...d.deps,
      keyring: {
        wrapDek: async () => {
          throw new Error("kms down");
        },
        unwrapDek: async () => {
          throw new Error("kms down");
        },
      },
    };
    const m = message();
    expect(await sendSystemMail(broken, m)).toBe("raw");
    expect(d.raw).toEqual([m]);
    // The owning domain's region rides along so the raw send targets the
    // region its identity is verified in.
    expect(d.rawOwners).toEqual([{ teamId: ownerTeam, domainId, region: "us-east-1" }]);
    expect(d.enqueued).toHaveLength(0);
  });
});

describe("suspended teams", () => {
  const suspend = (team: string, reason: SuspensionReason | null) =>
    db
      .update(schema.teams)
      .set({ suspendedAt: reason ? new Date() : null, suspensionReason: reason })
      .where(eq(schema.teams.id, team));

  it("lists the notices a suspended team still gets", () => {
    expect([...SENT_WHILE_SUSPENDED].sort()).toEqual([
      "api_key.created",
      "billing.cancel_reminder",
      "billing.cancel_scheduled",
      "billing.downgraded",
      "billing.payment_failed",
      "billing.plan_activated",
      "billing.plan_changed",
      "member.joined",
      "team.reinstated",
      "team.suspended",
      "webhook.secret_rotated",
    ]);
  });

  it("mutes every other notice about the team, and all of them under a silent suspension", async () => {
    const team = await createTeam(db, "suspended");
    const kinds: SystemMailKind[] = [
      ...ACCOUNT_MAIL_KINDS,
      "invitation",
      "quota.warning",
      "quota.reached",
      "quota.paused",
      "deliverability.warning",
      "deliverability.paused",
      "region.paused",
      "region.resumed",
      "webhook.failing",
      "webhook.auto_disabled",
      "webhook.backlog",
    ];
    const silent: readonly string[] = ["phishing", "review"];
    expect(SILENT_SUSPENSIONS).toEqual(silent);
    const d = deps();
    for (const reason of SUSPENSION_REASONS) {
      await suspend(team, reason);
      for (const kind of kinds) {
        expect(
          await sendSystemMail(d.deps, message({ kind, aboutTeamId: team })),
          `${reason} ${kind}`,
        ).toBe(!silent.includes(reason) && SENT_WHILE_SUSPENDED.has(kind) ? "pipeline" : "muted");
      }
    }
  });

  it("never mutes mail that names no team, or another team", async () => {
    const team = await createTeam(db, "silenced");
    await suspend(team, "phishing");
    const d = deps();
    for (const kind of [
      "password_reset",
      "email_verification",
      "updates.confirm",
      "welcome",
      "password_changed",
      "monitor.alert",
      "monitor.team_held",
      "quota.paused",
    ] as const) {
      expect(await sendSystemMail(d.deps, message({ kind })), kind).toBe("pipeline");
    }
    expect(
      await sendSystemMail(d.deps, message({ kind: "domain.verified", aboutTeamId: otherTeam })),
    ).toBe("pipeline");

    await suspend(team, null);
    expect(
      await sendSystemMail(d.deps, message({ kind: "domain.verified", aboutTeamId: team })),
    ).toBe("pipeline");
  });
});
