import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import type { SesIdentityClient } from "@millionsend/ses";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq, isNotNull } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { syncTenants } from "../src/handlers/tenants.js";

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
