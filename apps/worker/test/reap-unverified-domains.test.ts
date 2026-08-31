import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import type { SesIdentityClient } from "@millionsend/ses";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { reapUnverifiedDomains } from "../src/handlers/cron.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "reap-team");
});
afterEach(() => close());

/**
 * Answers GetEmailIdentity (DKIM FAILED unless the name is in dkimSuccess)
 * and records DeleteEmailIdentity calls; throws per-identity when told to.
 */
function fakeSes(opts: { throwFor?: Record<string, string>; dkimSuccess?: Set<string> } = {}) {
  const deleted: string[] = [];
  const clientForRegion = (): SesIdentityClient => ({
    async send(command) {
      const identity =
        (command as { input?: { EmailIdentity?: string } }).input?.EmailIdentity ?? "";
      const errName = opts.throwFor?.[identity];
      if (errName) throw Object.assign(new Error(errName), { name: errName });
      if (command.constructor.name === "GetEmailIdentityCommand") {
        return {
          DkimAttributes: { Status: opts.dkimSuccess?.has(identity) ? "SUCCESS" : "FAILED" },
        };
      }
      deleted.push(identity);
      return {};
    },
  });
  return { deleted, clientForRegion };
}

const HOUR_MS = 60 * 60 * 1000;
const oldEnough = new Date(Date.now() - 73 * HOUR_MS);

async function insertDomain(fields: {
  name: string;
  createdAt: Date;
  verifiedAt?: Date | null;
  team?: string;
  region?: string;
  status?: "pending" | "verified" | "temporary_failure" | "failed";
}): Promise<string> {
  const [row] = await db
    .insert(schema.domains)
    .values({
      teamId: fields.team ?? teamId,
      name: fields.name,
      region: fields.region ?? "us-east-1",
      status: fields.status ?? "pending",
      dkimSelector: "sel",
      dkimPublicKey: "PUB",
      mailFromSubdomain: "send",
      createdAt: fields.createdAt,
      verifiedAt: fields.verifiedAt ?? null,
    })
    .returning({ id: schema.domains.id });
  if (!row) throw new Error("insert failed");
  return row.id;
}

async function domainExists(id: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.domains.id })
    .from(schema.domains)
    .where(eq(schema.domains.id, id));
  return rows.length > 0;
}

it("reaps a never-verified domain past 72h: row, SES identity, and an audit trail", async () => {
  const id = await insertDomain({ name: "squat.dev", createdAt: oldEnough });
  const ses = fakeSes();

  const reaped = await reapUnverifiedDomains(db, { clientForRegion: ses.clientForRegion });

  expect(reaped).toBe(1);
  expect(await domainExists(id)).toBe(false);
  expect(ses.deleted).toEqual(["squat.dev"]);
  const [audit] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.teamId, teamId));
  expect(audit?.action).toBe("domain.deleted");
  expect(audit?.actorId).toBe("system");
  expect(audit?.data).toMatchObject({ name: "squat.dev", reason: "unverified_expired" });
});

it("keeps a never-verified domain still inside the 72h window", async () => {
  const id = await insertDomain({
    name: "young.dev",
    createdAt: new Date(Date.now() - 71 * HOUR_MS),
  });
  const ses = fakeSes();

  expect(await reapUnverifiedDomains(db, { clientForRegion: ses.clientForRegion })).toBe(0);
  expect(await domainExists(id)).toBe(true);
  expect(ses.deleted).toEqual([]);
});

it("never touches a domain that verified once, even degraded and ancient", async () => {
  const id = await insertDomain({
    name: "was-verified.dev",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    verifiedAt: new Date("2026-01-02T00:00:00Z"),
    status: "failed",
  });
  const ses = fakeSes();

  expect(await reapUnverifiedDomains(db, { clientForRegion: ses.clientForRegion })).toBe(0);
  expect(await domainExists(id)).toBe(true);
  expect(ses.deleted).toEqual([]);
});

it("leaves the SES identity while another row shares (name, region)", async () => {
  const otherTeam = await createTeam(db, "other-team");
  const squat = await insertDomain({ name: "shared.dev", createdAt: oldEnough });
  const owner = await insertDomain({
    name: "shared.dev",
    createdAt: oldEnough,
    verifiedAt: new Date(),
    status: "verified",
    team: otherTeam,
  });
  const ses = fakeSes();

  expect(await reapUnverifiedDomains(db, { clientForRegion: ses.clientForRegion })).toBe(1);
  expect(await domainExists(squat)).toBe(false);
  expect(await domainExists(owner)).toBe(true);
  expect(ses.deleted).toEqual([]);
});

it("leaves a domain SES just verified (stamp lag) for the reverify cron to promote", async () => {
  const id = await insertDomain({ name: "late.dev", createdAt: oldEnough });
  const ses = fakeSes({ dkimSuccess: new Set(["late.dev"]) });

  expect(await reapUnverifiedDomains(db, { clientForRegion: ses.clientForRegion })).toBe(0);
  expect(await domainExists(id)).toBe(true);
  expect(ses.deleted).toEqual([]);
});

it("terminally fails the domain's queued emails so the worker never retries a gone sender", async () => {
  const id = await insertDomain({ name: "queued.dev", createdAt: oldEnough });
  const [email] = await db
    .insert(schema.emails)
    .values({
      teamId,
      domainId: id,
      from: "a@queued.dev",
      to: ["r@example.com"],
      subject: "stuck",
      latestStatus: "queued",
    })
    .returning({ id: schema.emails.id });
  if (!email) throw new Error("insert failed");
  const ses = fakeSes();

  expect(await reapUnverifiedDomains(db, { clientForRegion: ses.clientForRegion })).toBe(1);
  const [row] = await db.select().from(schema.emails).where(eq(schema.emails.id, email.id));
  expect(row?.latestStatus).toBe("failed");
  const events = await db
    .select()
    .from(schema.emailEvents)
    .where(eq(schema.emailEvents.emailId, email.id));
  expect(events.map((e) => e.type)).toEqual(["failed"]);
});

it("an SES error keeps the row for the next run and never blocks the batch", async () => {
  // Strictly older so the sweep (createdAt asc) meets the failure first.
  const broken = await insertDomain({
    name: "ses-down.dev",
    createdAt: new Date(Date.now() - 74 * HOUR_MS),
  });
  const fine = await insertDomain({ name: "fine.dev", createdAt: oldEnough });
  const ses = fakeSes({ throwFor: { "ses-down.dev": "ThrottlingException" } });

  expect(await reapUnverifiedDomains(db, { clientForRegion: ses.clientForRegion })).toBe(1);
  expect(await domainExists(broken)).toBe(true);
  expect(await domainExists(fine)).toBe(false);
});

it("an identity already gone from SES does not block removing the row", async () => {
  const id = await insertDomain({ name: "gone.dev", createdAt: oldEnough });
  const ses = fakeSes({ throwFor: { "gone.dev": "NotFoundException" } });

  expect(await reapUnverifiedDomains(db, { clientForRegion: ses.clientForRegion })).toBe(1);
  expect(await domainExists(id)).toBe(false);
});

it("revokes domain-scoped api keys so the delete is not blocked (FK is restrict)", async () => {
  const id = await insertDomain({ name: "keyed.dev", createdAt: oldEnough });
  const [key] = await db
    .insert(schema.apiKeys)
    .values({
      teamId,
      name: "scoped",
      tokenPrefix: "ms_test_reap01",
      keyHash: "hash-reap-test",
      last4: "ap01",
      domainId: id,
    })
    .returning({ id: schema.apiKeys.id });
  if (!key) throw new Error("insert failed");
  const ses = fakeSes();

  expect(await reapUnverifiedDomains(db, { clientForRegion: ses.clientForRegion })).toBe(1);
  expect(await domainExists(id)).toBe(false);
  const [row] = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, key.id));
  expect(row?.revokedAt).not.toBeNull();
  expect(row?.domainId).toBeNull();
});
