import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import type { SesIdentityClient, SesTenantClient } from "@millionsend/ses";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq, isNotNull } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  abandonTenantStatus,
  isTenantNotAssociated,
  retryTenantStatus,
  sharedTenantResolver,
  syncTenants,
} from "../src/handlers/tenants.js";

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(() => {
  vi.restoreAllMocks();
  return close();
});

function fakeSes(failFor: string[] = []) {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const client: SesIdentityClient = {
    async send(command) {
      const name = command.constructor.name;
      const input = (command as unknown as { input: Record<string, unknown> }).input;
      calls.push({ name, input });
      if (name === "CreateTenantCommand") {
        if (failFor.includes(String(input.TenantName))) {
          throw Object.assign(new Error("throttled"), { name: "TooManyRequestsException" });
        }
        return { TenantArn: `arn:aws:ses:sa-east-1:123456789012:tenant/${input.TenantName}` };
      }
      return {};
    },
  };
  return { client, calls };
}

async function insertDomain(teamId: string, name: string, region = "sa-east-1") {
  const [row] = await db
    .insert(schema.domains)
    .values({ teamId, name, region })
    .returning({ id: schema.domains.id });
  if (!row) throw new Error("insert failed");
  return row.id;
}

it("associates every unmarked domain, stamps it, and names the team's tenant", async () => {
  const teamId = await createTeam(db, "acme");
  const a = await insertDomain(teamId, "a.acme.dev");
  const b = await insertDomain(teamId, "b.acme.dev", "us-east-1");
  const { client, calls } = fakeSes();
  const now = new Date("2026-09-03T12:00:00Z");

  expect(
    await syncTenants(db, {
      clientForRegion: () => client,
      configurationSet: "millionsend",
      enabled: true,
      now,
    }),
  ).toEqual({ associated: 2, failed: 0 });
  // Per domain: tenant in its region, then identity + configuration set associations.
  expect(calls.map((c) => c.name)).toEqual([
    "CreateTenantCommand",
    "CreateTenantResourceAssociationCommand",
    "CreateTenantResourceAssociationCommand",
    "CreateTenantCommand",
    "CreateTenantResourceAssociationCommand",
    "CreateTenantResourceAssociationCommand",
  ]);
  expect(calls[1]?.input.ResourceArn).toBe(
    "arn:aws:ses:sa-east-1:123456789012:identity/a.acme.dev",
  );
  expect(calls[2]?.input.ResourceArn).toBe(
    "arn:aws:ses:sa-east-1:123456789012:configuration-set/millionsend",
  );
  for (const id of [a, b]) {
    const [row] = await db.select().from(schema.domains).where(eq(schema.domains.id, id));
    expect(row?.sesTenantAssociatedAt).toEqual(now);
    expect(row?.sesTenantConfigSet).toBe("millionsend");
  }
  const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
  expect(team?.sesTenantName).toBe(teamId);

  // Nothing left to do on the next run.
  expect(
    await syncTenants(db, {
      clientForRegion: () => client,
      configurationSet: "millionsend",
      enabled: true,
    }),
  ).toEqual({ associated: 0, failed: 0 });
});

it("re-associates a domain whose recorded configuration set drifted from the env", async () => {
  const teamId = await createTeam(db, "acme");
  const id = await insertDomain(teamId, "a.acme.dev");
  await db
    .update(schema.domains)
    .set({ sesTenantAssociatedAt: new Date("2026-01-01T00:00:00Z"), sesTenantConfigSet: "old" })
    .where(eq(schema.domains.id, id));
  const { client, calls } = fakeSes();
  expect(
    await syncTenants(db, {
      clientForRegion: () => client,
      configurationSet: "millionsend",
      enabled: true,
    }),
  ).toEqual({ associated: 1, failed: 0 });
  expect(calls.map((c) => c.name)).toEqual([
    "CreateTenantCommand",
    "CreateTenantResourceAssociationCommand",
    "CreateTenantResourceAssociationCommand",
  ]);
  const [row] = await db.select().from(schema.domains).where(eq(schema.domains.id, id));
  expect(row?.sesTenantConfigSet).toBe("millionsend");
});

it("one failing domain is logged and skipped; the others still get associated", async () => {
  const bad = await createTeam(db, "bad");
  const good = await createTeam(db, "good");
  await insertDomain(bad, "bad.dev");
  await insertDomain(good, "good.dev");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { client } = fakeSes([bad]);

  expect(await syncTenants(db, { clientForRegion: () => client, enabled: true })).toEqual({
    associated: 1,
    failed: 1,
  });
  expect(warn).toHaveBeenCalledTimes(1);
  const marked = await db
    .select({ name: schema.domains.name })
    .from(schema.domains)
    .where(isNotNull(schema.domains.sesTenantAssociatedAt));
  expect(marked).toEqual([{ name: "good.dev" }]);
});

it("does nothing when tenants are disabled", async () => {
  await insertDomain(await createTeam(db, "acme"), "a.acme.dev");
  const { client, calls } = fakeSes();
  expect(await syncTenants(db, { clientForRegion: () => client, enabled: false })).toEqual({
    associated: 0,
    failed: 0,
  });
  expect(calls).toEqual([]);
});

async function sharedTeam(): Promise<string> {
  const teamId = await createTeam(db, "acme");
  await db.insert(schema.sharedInboxDomains).values({ teamId, name: "acme.agents.example" });
  return teamId;
}

const sharedMarker = async (teamId: string) =>
  (
    await db
      .select({
        region: schema.sharedInboxDomains.sesTenantRegion,
        configSet: schema.sharedInboxDomains.sesTenantConfigSet,
      })
      .from(schema.sharedInboxDomains)
      .where(eq(schema.sharedInboxDomains.teamId, teamId))
  )[0];

const ASSOCIATION = [
  "CreateTenantCommand",
  "CreateTenantResourceAssociationCommand",
  "CreateTenantResourceAssociationCommand",
];

it("associates the shared identity with the team's tenant once, and again when the region or set changes", async () => {
  const teamId = await sharedTeam();
  const { client, calls } = fakeSes();
  const deps = { client, region: "us-east-1", sharedInboxDomain: "agents.example" };
  const resolve = sharedTenantResolver(db, deps);

  expect(await resolve(teamId, "millionsend")).toBe(teamId);
  expect(calls.map((c) => c.name)).toEqual(ASSOCIATION);
  expect(calls[0]?.input.TenantName).toBe(teamId);
  expect(calls.slice(1).map((c) => c.input.ResourceArn)).toEqual([
    "arn:aws:ses:us-east-1:123456789012:identity/agents.example",
    "arn:aws:ses:us-east-1:123456789012:configuration-set/millionsend",
  ]);
  expect(await sharedMarker(teamId)).toEqual({ region: "us-east-1", configSet: "millionsend" });

  calls.length = 0;
  expect(await resolve(teamId, "millionsend")).toBe(teamId);
  expect(calls).toEqual([]);

  expect(await resolve(teamId, "other-set")).toBe(teamId);
  expect(
    await sharedTenantResolver(db, { ...deps, region: "sa-east-1" })(teamId, "other-set"),
  ).toBe(teamId);
  expect(calls.map((c) => c.name)).toEqual([...ASSOCIATION, ...ASSOCIATION]);
  expect(await sharedMarker(teamId)).toEqual({ region: "sa-east-1", configSet: "other-set" });
});

it("a failed shared association sends without a tenant and leaves the team alone for an hour", async () => {
  const teamId = await sharedTeam();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const failing = [teamId];
  const { client, calls } = fakeSes(failing);
  let now = Date.parse("2026-10-13T12:00:00Z");
  const resolve = sharedTenantResolver(db, {
    client,
    region: "us-east-1",
    sharedInboxDomain: "agents.example",
    now: () => now,
  });

  expect(await resolve(teamId, "millionsend")).toBeUndefined();
  expect(calls.map((c) => c.name)).toEqual(["CreateTenantCommand"]);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(await sharedMarker(teamId)).toEqual({ region: null, configSet: null });

  failing.length = 0;
  now += 59 * 60_000;
  expect(await resolve(teamId, "millionsend")).toBeUndefined();
  expect(calls).toHaveLength(1);

  now += 60_000;
  expect(await resolve(teamId, "millionsend")).toBe(teamId);
  expect(await sharedMarker(teamId)).toEqual({ region: "us-east-1", configSet: "millionsend" });
});

/** Per-region fake for the status calls; a region in `failing` refuses every call. */
function statusSes(failing: string[] = []) {
  const updates: { region: string; status: unknown }[] = [];
  const clientForRegion = (region: string): SesTenantClient => ({
    async send(command) {
      if (failing.includes(region)) {
        throw Object.assign(new Error("not authorized"), { name: "AccessDeniedException" });
      }
      if (command.constructor.name === "GetTenantCommand") {
        return { Tenant: { TenantArn: `arn:aws:ses:${region}:123456789012:tenant/t/tn-1` } };
      }
      const input = (command as unknown as { input: { SendingStatus: string } }).input;
      updates.push({ region, status: input.SendingStatus });
      return {};
    },
  });
  return { clientForRegion, updates };
}

const tenantRows = () =>
  db
    .select({
      action: schema.auditLog.action,
      actorId: schema.auditLog.actorId,
      teamId: schema.auditLog.teamId,
      target: schema.auditLog.target,
      data: schema.auditLog.data,
    })
    .from(schema.auditLog);

it("the tenant.status retry applies the team's standing at run time in every domain region", async () => {
  const teamId = await createTeam(db, "acme");
  await insertDomain(teamId, "a.acme.dev");
  await insertDomain(teamId, "b.acme.dev", "us-east-1");
  await db
    .update(schema.teams)
    .set({ suspendedAt: new Date(), suspensionReason: "phishing" })
    .where(eq(schema.teams.id, teamId));
  const ses = statusSes();

  await retryTenantStatus(db, { clientForRegion: ses.clientForRegion, enabled: true }, teamId);
  expect(ses.updates).toEqual([
    { region: "sa-east-1", status: "DISABLED" },
    { region: "us-east-1", status: "DISABLED" },
  ]);
  expect(await tenantRows()).toEqual([
    {
      action: "team.ses_tenant_updated",
      actorId: "system",
      teamId: null,
      target: `team:${teamId}`,
      data: { team: "acme", status: "DISABLED", regions: "sa-east-1, us-east-1" },
    },
  ]);

  // Reinstated before the retry ran: the retry enables instead.
  await db
    .update(schema.teams)
    .set({ suspendedAt: null, suspensionReason: null })
    .where(eq(schema.teams.id, teamId));
  ses.updates.length = 0;
  await retryTenantStatus(db, { clientForRegion: ses.clientForRegion, enabled: true }, teamId);
  expect(ses.updates.map((u) => u.status)).toEqual(["ENABLED", "ENABLED"]);
});

it("the tenant.status retry also covers the region the team's shared mail was associated in", async () => {
  const teamId = await sharedTeam();
  await db
    .update(schema.sharedInboxDomains)
    .set({ sesTenantRegion: "us-east-1", sesTenantConfigSet: "millionsend" })
    .where(eq(schema.sharedInboxDomains.teamId, teamId));
  await db
    .update(schema.teams)
    .set({ suspendedAt: new Date(), suspensionReason: "phishing" })
    .where(eq(schema.teams.id, teamId));
  const ses = statusSes();

  await retryTenantStatus(db, { clientForRegion: ses.clientForRegion, enabled: true }, teamId);
  expect(ses.updates).toEqual([{ region: "us-east-1", status: "DISABLED" }]);

  await insertDomain(teamId, "a.acme.dev");
  await insertDomain(teamId, "b.acme.dev", "us-east-1");
  ses.updates.length = 0;
  await retryTenantStatus(db, { clientForRegion: ses.clientForRegion, enabled: true }, teamId);
  expect(ses.updates).toEqual([
    { region: "sa-east-1", status: "DISABLED" },
    { region: "us-east-1", status: "DISABLED" },
  ]);
});

it("a reinstate landing mid-retry makes the job run again instead of keeping DISABLED", async () => {
  const teamId = await createTeam(db, "acme");
  await insertDomain(teamId, "a.acme.dev");
  await db
    .update(schema.teams)
    .set({ suspendedAt: new Date(), suspensionReason: "phishing" })
    .where(eq(schema.teams.id, teamId));
  const ses = statusSes();
  const reinstatedMidCall = (region: string): SesTenantClient => ({
    async send(command) {
      if (command.constructor.name !== "GetTenantCommand") {
        await db
          .update(schema.teams)
          .set({ suspendedAt: null, suspensionReason: null })
          .where(eq(schema.teams.id, teamId));
      }
      return ses.clientForRegion(region).send(command);
    },
  });

  await expect(
    retryTenantStatus(db, { clientForRegion: reinstatedMidCall, enabled: true }, teamId),
  ).rejects.toThrow(/standing changed/);
  expect(await tenantRows()).toEqual([]);

  await retryTenantStatus(db, { clientForRegion: ses.clientForRegion, enabled: true }, teamId);
  expect(ses.updates.map((u) => u.status)).toEqual(["DISABLED", "ENABLED"]);
  expect(await tenantRows()).toMatchObject([
    { action: "team.ses_tenant_updated", data: { status: "ENABLED" } },
  ]);
});

it("the retry throws while a region still fails, and giving up is audited", async () => {
  const teamId = await createTeam(db, "acme");
  await insertDomain(teamId, "a.acme.dev");
  await insertDomain(teamId, "b.acme.dev", "us-east-1");
  await db
    .update(schema.teams)
    .set({ suspendedAt: new Date(), suspensionReason: "phishing" })
    .where(eq(schema.teams.id, teamId));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const ses = statusSes(["us-east-1"]);

  await expect(
    retryTenantStatus(db, { clientForRegion: ses.clientForRegion, enabled: true }, teamId),
  ).rejects.toThrow(/DISABLED still failing .* in us-east-1/);
  expect(ses.updates).toEqual([{ region: "sa-east-1", status: "DISABLED" }]);
  expect(await tenantRows()).toEqual([]);

  await abandonTenantStatus(db, teamId);
  expect(await tenantRows()).toEqual([
    {
      action: "team.ses_tenant_update_failed",
      actorId: "system",
      teamId: null,
      target: `team:${teamId}`,
      data: { team: "acme", retrying: false },
    },
  ]);
  expect(error).toHaveBeenCalledTimes(1);
});

it("the retry does nothing when tenants are disabled", async () => {
  const teamId = await createTeam(db, "acme");
  await insertDomain(teamId, "a.acme.dev");
  const ses = statusSes();
  await retryTenantStatus(db, { clientForRegion: ses.clientForRegion, enabled: false }, teamId);
  expect(ses.updates).toEqual([]);
  expect(await tenantRows()).toEqual([]);
});

// The refusals live SES sends answered on 2026-10-14, plus near misses.
it.each([
  [
    "AccessDeniedException",
    "Tenant not associated with resources [arn:aws:ses:us-east-1:111122223333:identity/agents.example.test].",
    true,
  ],
  [
    "MessageRejected",
    "Sending disabled for <arn:aws:ses:us-east-1:111122223333:tenant/t/tn-0>. For more information, please check the resource configuration and status.",
    false,
  ],
  ["SendingPausedException", "Sending is paused for this tenant", false],
  ["AccessDeniedException", "User is not authorized to perform ses:SendEmail", false],
  ["BadRequestException", "Identity is not associated with the tenant", false],
])("isTenantNotAssociated(%s: %s) is %s", (name, message, expected) => {
  expect(isTenantNotAssociated(Object.assign(new Error(message), { name }))).toBe(expected);
});
