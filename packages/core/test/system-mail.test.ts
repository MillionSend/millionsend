import { randomBytes } from "node:crypto";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EnvKeyring } from "../src/crypto/keyring.js";
import { hashRecipient } from "../src/suppressions.js";
import {
  findSenderDomainOwner,
  SYSTEM_MAIL_TAG,
  type SystemMailMessage,
  SystemMailRefused,
  sendSystemMail,
} from "../src/system-mail.js";

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
  return {
    enqueued,
    raw,
    deps: {
      db,
      keyring,
      isCloud: true,
      enqueueEmailSend: async (id: string) => {
        enqueued.push(id);
      },
      raw: async (m: SystemMailMessage) => {
        raw.push(m);
      },
    },
  };
}

describe("findSenderDomainOwner", () => {
  it("matches the exact verified host, whatever the display name", async () => {
    expect(await findSenderDomainOwner(db, "Ops <ops@mail.example.com>")).toEqual({
      teamId: ownerTeam,
      domainId,
    });
    expect(await findSenderDomainOwner(db, "ops@MAIL.example.com")).toEqual({
      teamId: ownerTeam,
      domainId,
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
    expect(d.enqueued).toHaveLength(0);
  });
});
