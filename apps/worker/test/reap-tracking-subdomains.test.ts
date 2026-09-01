import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import type { DnsResolver } from "@millionsend/ses";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { reapStaleTrackingSubdomains } from "../src/handlers/cron.js";

const TARGET = "t.edge.example.com";

let db: Db;
let close: () => Promise<void>;
let teamId: string;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "reap-tracking-team");
});
afterEach(() => close());

/** Resolves only the full CNAME names in `live` to the expected target. */
function cnameResolver(live: Set<string>): DnsResolver {
  return {
    resolveTxt: async () => [],
    resolveMx: async () => [],
    resolveCname: async (name) => (live.has(name) ? [TARGET] : []),
  };
}

async function insertDomain(fields: {
  trackingSubdomain: string | null;
  trackingSubdomainSetAt: Date | null;
}): Promise<string> {
  const [row] = await db
    .insert(schema.domains)
    .values({
      teamId,
      name: "acme.dev",
      region: "us-east-1",
      status: "verified",
      dkimSelector: "sel",
      dkimPublicKey: "PUB",
      mailFromSubdomain: "send",
      trackingSubdomain: fields.trackingSubdomain,
      trackingSubdomainSetAt: fields.trackingSubdomainSetAt,
    })
    .returning({ id: schema.domains.id });
  if (!row) throw new Error("insert failed");
  return row.id;
}

async function domainRow(id: string) {
  const [row] = await db.select().from(schema.domains).where(eq(schema.domains.id, id));
  if (!row) throw new Error("missing");
  return row;
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000);

it("clears the clock for good once the tracking CNAME resolves", async () => {
  const id = await insertDomain({
    trackingSubdomain: "links",
    trackingSubdomainSetAt: hoursAgo(1),
  });
  const r = await reapStaleTrackingSubdomains(db, {
    resolver: cnameResolver(new Set(["links.acme.dev"])),
    trackingCnameValue: TARGET,
  });
  expect(r).toEqual({ verified: 1, unset: 0 });
  const row = await domainRow(id);
  expect(row.trackingSubdomain).toBe("links");
  expect(row.trackingSubdomainSetAt).toBeNull();
});

it("unsets a subdomain whose CNAME never resolved past 72h", async () => {
  const id = await insertDomain({
    trackingSubdomain: "links",
    trackingSubdomainSetAt: hoursAgo(73),
  });
  const r = await reapStaleTrackingSubdomains(db, {
    resolver: cnameResolver(new Set()),
    trackingCnameValue: TARGET,
  });
  expect(r).toEqual({ verified: 0, unset: 1 });
  const row = await domainRow(id);
  expect(row.trackingSubdomain).toBeNull();
  expect(row.trackingSubdomainSetAt).toBeNull();
});

it("leaves an unresolved subdomain alone before 72h", async () => {
  const id = await insertDomain({
    trackingSubdomain: "links",
    trackingSubdomainSetAt: hoursAgo(10),
  });
  const r = await reapStaleTrackingSubdomains(db, {
    resolver: cnameResolver(new Set()),
    trackingCnameValue: TARGET,
  });
  expect(r).toEqual({ verified: 0, unset: 0 });
  const row = await domainRow(id);
  expect(row.trackingSubdomain).toBe("links");
  expect(row.trackingSubdomainSetAt).not.toBeNull();
});

it("no-ops when the target host cannot be computed", async () => {
  const id = await insertDomain({
    trackingSubdomain: "links",
    trackingSubdomainSetAt: hoursAgo(99),
  });
  const r = await reapStaleTrackingSubdomains(db, {
    resolver: cnameResolver(new Set()),
    trackingCnameValue: null,
  });
  expect(r).toEqual({ verified: 0, unset: 0 });
  expect((await domainRow(id)).trackingSubdomain).toBe("links");
});
