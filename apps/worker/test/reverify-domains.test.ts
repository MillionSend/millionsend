import { verifySenderDomain } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import type { DnsResolver, SesIdentityClient } from "@millionsend/ses";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { reverifyDomains } from "../src/handlers/cron.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "reverify-team");
});
afterEach(() => close());

/** SES identity fake: SUCCESS/SUCCESS/verified, except a region that throws. */
function clientForRegion(region: string): SesIdentityClient {
  if (region === "throw-region") {
    return {
      async send() {
        throw new Error("SES down");
      },
    };
  }
  return {
    async send(command) {
      if (command.constructor.name === "GetEmailIdentityCommand") {
        return {
          VerifiedForSendingStatus: true,
          DkimAttributes: { Status: "SUCCESS" },
          MailFromAttributes: { MailFromDomainStatus: "SUCCESS" },
        };
      }
      return {};
    },
  };
}

/** Every required record resolves live, except SPF TXT for names in spfMissing. */
function fakeDns(spfMissing = new Set<string>(), dmarc?: string): DnsResolver {
  return {
    resolveTxt: async (name) => {
      if (name.includes("._domainkey.")) return [["v=DKIM1; k=rsa; p=PUB"]];
      const spf = name.match(/^send\.(.+)$/);
      if (spf) return spfMissing.has(spf[1] ?? "") ? [] : [["v=spf1 include:amazonses.com ~all"]];
      if (name.startsWith("_dmarc.") && dmarc) return [[dmarc]];
      return []; // _dmarc not published unless the test provides it
    },
    resolveMx: async (name) =>
      name.startsWith("send.")
        ? [{ priority: 10, exchange: "feedback-smtp.us-east-1.amazonses.com" }]
        : [],
    resolveCname: async () => [],
  };
}

async function insertDomain(fields: {
  name: string;
  status: "pending" | "verified" | "temporary_failure" | "failed";
  region?: string;
  verifiedAt?: Date | null;
  lastCheckedAt?: Date | null;
}): Promise<string> {
  const [row] = await db
    .insert(schema.domains)
    .values({
      teamId,
      name: fields.name,
      region: fields.region ?? "us-east-1",
      status: fields.status,
      dkimSelector: "sel",
      dkimPublicKey: "PUB",
      mailFromSubdomain: "send",
      verifiedAt: fields.verifiedAt ?? null,
      lastCheckedAt: fields.lastCheckedAt ?? null,
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

const stale = new Date(Date.now() - 60 * 60 * 1000);

it("demotes a verified domain whose SPF went live-missing, blocking further sends", async () => {
  const verifiedAt = new Date("2026-01-01T00:00:00Z");
  const id = await insertDomain({
    name: "acme.dev",
    status: "verified",
    verifiedAt,
    lastCheckedAt: stale,
  });

  await reverifyDomains(db, {
    clientForRegion,
    resolver: fakeDns(new Set(["acme.dev"])),
  });

  const row = await domainRow(id);
  expect(row.status).toBe("pending");
  // Historical verifiedAt is kept on demotion.
  expect(row.verifiedAt?.getTime()).toBe(verifiedAt.getTime());
  // The send gate now refuses this sender.
  const verdict = await verifySenderDomain(db, teamId, "hi@acme.dev");
  expect(verdict.ok).toBe(false);
});

it("promotes a fully-present pending domain and stamps verifiedAt", async () => {
  const id = await insertDomain({
    name: "good.dev",
    status: "pending",
    verifiedAt: null,
    lastCheckedAt: null,
  });

  await reverifyDomains(db, { clientForRegion, resolver: fakeDns() });

  const row = await domainRow(id);
  expect(row.status).toBe("verified");
  expect(row.verifiedAt).not.toBeNull();
  expect(row.lastCheckedAt).not.toBeNull();
  // The pass persists the per-record snapshot so send-time insights never do
  // live DNS: required records found, unpublished DMARC conclusively missing.
  expect(row.dnsRecords?.map((r) => r.status)).toEqual(["found", "found", "found", "missing"]);
  expect(row.dmarcPolicy).toBeNull();
  expect(row.dmarcCheckedAt).not.toBeNull();
});

it("persists the published DMARC policy alongside the verification pass", async () => {
  const id = await insertDomain({ name: "good.dev", status: "pending", lastCheckedAt: stale });

  await reverifyDomains(db, {
    clientForRegion,
    resolver: fakeDns(new Set(), "v=DMARC1; p=quarantine;"),
  });

  const row = await domainRow(id);
  expect(row.dmarcPolicy).toBe("quarantine");
  expect(row.dnsRecords?.find((r) => r.group === "dmarc")?.status).toBe("found");
});

it("a resolver outage demotes to pending but keeps the last good snapshot", async () => {
  const goodSnapshot = [
    {
      group: "verification",
      name: "sel._domainkey.zone.dev",
      type: "TXT",
      status: "found" as const,
    },
    { group: "sending", name: "send.zone.dev", type: "MX", status: "found" as const },
  ];
  const checkedAt = new Date("2026-01-02T00:00:00Z");
  const id = await insertDomain({ name: "zone.dev", status: "verified", lastCheckedAt: stale });
  await db
    .update(schema.domains)
    .set({ dnsRecords: goodSnapshot, dmarcPolicy: "reject", dmarcCheckedAt: checkedAt })
    .where(eq(schema.domains.id, id));
  const servfail: DnsResolver = {
    resolveTxt: async () => {
      throw new Error("servfail");
    },
    resolveMx: async () => {
      throw new Error("servfail");
    },
    resolveCname: async () => {
      throw new Error("servfail");
    },
  };

  await reverifyDomains(db, { clientForRegion, resolver: servfail });

  const row = await domainRow(id);
  // Conservative-closed for the send gate: an inconclusive pass demotes...
  expect(row.status).toBe("pending");
  // ...conservative-open for scoring: the all-unknown pass writes neither
  // snapshot nor DMARC, so a blip never stamps a score penalty.
  expect(row.dnsRecords).toEqual(goodSnapshot);
  expect(row.dmarcPolicy).toBe("reject");
  expect(row.dmarcCheckedAt?.getTime()).toBe(checkedAt.getTime());
});

it("a per-domain SES error does not abort the batch", async () => {
  const bad = await insertDomain({
    name: "bad.dev",
    status: "pending",
    region: "throw-region",
    lastCheckedAt: stale,
  });
  const good = await insertDomain({ name: "ok.dev", status: "pending", lastCheckedAt: stale });

  const result = await reverifyDomains(db, { clientForRegion, resolver: fakeDns() });

  expect(result.failed).toBe(1);
  // The healthy sibling still got processed and promoted.
  expect((await domainRow(good)).status).toBe("verified");
  // The failed one is untouched — old status, lastCheckedAt not advanced.
  const badRow = await domainRow(bad);
  expect(badRow.status).toBe("pending");
  expect(badRow.lastCheckedAt?.getTime()).toBe(stale.getTime());
});

it("skips freshly-checked domains (staleness filter)", async () => {
  const now = new Date();
  const fresh = await insertDomain({
    name: "fresh.dev",
    status: "verified",
    verifiedAt: stale,
    lastCheckedAt: now,
  });

  const result = await reverifyDomains(db, {
    clientForRegion,
    // Would demote if checked, but it's not due.
    resolver: fakeDns(new Set(["fresh.dev"])),
    now,
  });

  expect(result.checked).toBe(0);
  expect((await domainRow(fresh)).status).toBe("verified");
});

it("caps the batch and defers the freshest-checked domains", async () => {
  const t = (min: number) => new Date(Date.now() - min * 60 * 1000);
  const oldest = await insertDomain({ name: "a.dev", status: "pending", lastCheckedAt: t(90) });
  const mid = await insertDomain({ name: "b.dev", status: "pending", lastCheckedAt: t(60) });
  const newest = await insertDomain({ name: "c.dev", status: "pending", lastCheckedAt: t(45) });

  const result = await reverifyDomains(db, {
    clientForRegion,
    resolver: fakeDns(),
    batchSize: 2,
  });

  expect(result.capped).toBe(true);
  expect(result.checked).toBe(2);
  // Oldest two processed; least-stale deferred to next run.
  expect((await domainRow(oldest)).status).toBe("verified");
  expect((await domainRow(mid)).status).toBe("verified");
  expect((await domainRow(newest)).status).toBe("pending");
});

it("a domain whose SES identity no longer exists is marked failed, not left verified", async () => {
  const gone = await insertDomain({ name: "gone.dev", status: "verified", lastCheckedAt: stale });
  const missingIdentity = (): SesIdentityClient => ({
    async send() {
      throw Object.assign(new Error("identity not found"), { name: "NotFoundException" });
    },
  });

  const result = await reverifyDomains(db, {
    clientForRegion: missingIdentity,
    resolver: fakeDns(),
  });

  expect(result.failed).toBe(0);
  const row = await domainRow(gone);
  expect(row.status).toBe("failed");
  expect(row.lastCheckedAt?.getTime()).toBeGreaterThan(stale.getTime());
});
