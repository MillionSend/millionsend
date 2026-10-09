import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import type { SesIdentityClient, SesTenantClient } from "@millionsend/ses";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq, isNotNull } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { abandonTenantStatus, retryTenantStatus, syncTenants } from "../src/handlers/tenants.js";

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
      data: { status: "DISABLED", regions: "sa-east-1, us-east-1" },
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
    { action: "team.ses_tenant_update_failed", actorId: "system", data: { retrying: false } },
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
