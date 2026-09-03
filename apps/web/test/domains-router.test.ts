import { createPublicKey } from "node:crypto";
import { PLAN_DOMAIN_LIMIT } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import type { DkimVerificationStatus, DnsResolver, SesIdentityClient } from "@millionsend/ses";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDomainsRouter, type DomainsSesDeps } from "@/server/routers/domains";
import { type Context, createCallerFactory, router } from "@/server/trpc";

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  // Validation is skipped under vitest, so zod's AWS_REGION default never applies.
  vi.stubEnv("AWS_REGION", "us-east-1");
});

afterEach(async () => {
  await close();
  vi.restoreAllMocks();
  // Deployment-mode stubs would otherwise leak into the next test in the file.
  vi.unstubAllEnvs();
});

interface FakeSesState {
  dkimStatus?: DkimVerificationStatus;
  verifiedForSending?: boolean;
  nsHosts?: string[];
  dns?: Partial<DnsResolver>;
}

const ENOTFOUND = Object.assign(new Error("queryTxt ENOTFOUND"), { code: "ENOTFOUND" });

// Default resolver answers nothing (every record reads Missing) and touches no
// network; individual tests override the methods they exercise.
function fakeDns(overrides: Partial<DnsResolver> = {}): DnsResolver {
  return {
    resolveTxt: overrides.resolveTxt ?? (async () => []),
    resolveMx: overrides.resolveMx ?? (async () => []),
    resolveCname: overrides.resolveCname ?? (async () => []),
  };
}

/** Fake SesIdentityClient discriminating on AWS command class names. */
function fakeSes(state: FakeSesState = {}) {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const client: SesIdentityClient = {
    async send(command) {
      const name = command.constructor.name;
      calls.push({
        name,
        input: (command as unknown as { input: Record<string, unknown> }).input,
      });
      if (name === "GetEmailIdentityCommand") {
        return {
          VerifiedForSendingStatus: state.verifiedForSending ?? false,
          DkimAttributes: { Status: state.dkimStatus ?? "PENDING" },
          MailFromAttributes: {
            MailFromDomainStatus: state.verifiedForSending ? "SUCCESS" : "PENDING",
          },
        };
      }
      if (name === "CreateTenantCommand" || name === "GetTenantCommand") {
        const tenantName = (command as unknown as { input: { TenantName: string } }).input
          .TenantName;
        const arn = `arn:aws:ses:us-east-1:123456789012:tenant/${tenantName}`;
        return name === "CreateTenantCommand" ? { TenantArn: arn } : { Tenant: { TenantArn: arn } };
      }
      return {};
    },
  };
  const deps: DomainsSesDeps = {
    clientForRegion: () => client,
    resolveNs: async () => state.nsHosts ?? [],
    dns: fakeDns(state.dns ?? {}),
  };
  return { deps, calls };
}

/** The DomainSigningPrivateKey the router uploaded, captured by the fake client. */
function uploadedPrivateKey(calls: { name: string; input: Record<string, unknown> }[]): string {
  const create = calls.find((c) => c.name === "CreateEmailIdentityCommand");
  const attrs = create?.input.DkimSigningAttributes as
    | { DomainSigningSelector?: string; DomainSigningPrivateKey?: string }
    | undefined;
  const key = attrs?.DomainSigningPrivateKey;
  if (!key) throw new Error("no private key captured");
  return key;
}

function callerFor(
  teamId: string,
  deps: DomainsSesDeps,
  role: "owner" | "admin" | "member" = "owner",
) {
  const factory = createCallerFactory(router({ domains: createDomainsRouter(deps) }));
  const ctx: Context = {
    db,
    session: { user: { id: "u1", email: "u1@example.com", name: "u1" } },
    teamId,
    role,
  };
  return factory(ctx);
}

describe("domains.create", () => {
  it("forbids ordinary members from creating SES identities", async () => {
    const teamId = await createTeam(db);
    await expect(
      callerFor(teamId, fakeSes().deps, "member").domains.create({
        name: "member.example.com",
        region: "us-east-1",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("refuses a region other than the one the deployment serves, before touching SES", async () => {
    const teamId = await createTeam(db);
    const { deps, calls } = fakeSes();
    await expect(
      callerFor(teamId, deps).domains.create({ name: "far.example.com", region: "sa-east-1" }),
    ).rejects.toMatchObject({
      code: "UNPROCESSABLE_CONTENT",
      message: "Region sa-east-1 is not available; this deployment serves us-east-1",
    });
    expect(calls).toHaveLength(0);
  });
  it("uploads a BYODKIM key to SES and stores only the selector and public half", async () => {
    const teamId = await createTeam(db);
    const { deps, calls } = fakeSes();
    const consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method),
    );
    const { id } = await callerFor(teamId, deps).domains.create({
      name: "updates.example.com",
      region: "us-east-1",
    });

    expect(calls.map((c) => c.name)).toEqual([
      "CreateEmailIdentityCommand",
      "PutEmailIdentityMailFromAttributesCommand",
    ]);
    expect(calls[0]?.input).toMatchObject({
      EmailIdentity: "updates.example.com",
      DkimSigningAttributes: { DomainSigningSelector: "millionsend" },
    });
    expect(calls[1]?.input).toMatchObject({
      EmailIdentity: "updates.example.com",
      MailFromDomain: "send.updates.example.com",
    });

    const privateKeyB64 = uploadedPrivateKey(calls);
    const [row] = await db.select().from(schema.domains).where(eq(schema.domains.id, id));
    expect(row).toMatchObject({
      teamId,
      name: "updates.example.com",
      region: "us-east-1",
      status: "pending",
      mailFromSubdomain: "send",
      dkimSelector: "millionsend",
    });

    // The stored public key is the public half of the uploaded private key.
    const derivedPublic = createPublicKey({
      key: Buffer.from(privateKeyB64, "base64"),
      format: "der",
      type: "pkcs1",
    });
    expect(row?.dkimPublicKey).toBe(
      derivedPublic.export({ format: "der", type: "spki" }).toString("base64"),
    );

    // Security invariant: no column of the persisted row contains any
    // private-key material.
    for (const [column, value] of Object.entries(row ?? {})) {
      expect(String(value), `column ${column}`).not.toContain(privateKeyB64);
    }
    // ...and nothing logged it either.
    for (const spy of consoleSpies) {
      for (const args of spy.mock.calls) {
        expect(args.map(String).join(" ")).not.toContain(privateKeyB64);
      }
    }
  });

  it("generates a distinct keypair per domain", async () => {
    const teamId = await createTeam(db);
    const { deps, calls } = fakeSes();
    const caller = callerFor(teamId, deps);
    const a = await caller.domains.create({ name: "a.example.com", region: "us-east-1" });
    const b = await caller.domains.create({ name: "b.example.com", region: "us-east-1" });

    const [rowA] = await db.select().from(schema.domains).where(eq(schema.domains.id, a.id));
    const [rowB] = await db.select().from(schema.domains).where(eq(schema.domains.id, b.id));
    expect(rowA?.dkimPublicKey).not.toBe(rowB?.dkimPublicKey);
    const keys = calls
      .filter((c) => c.name === "CreateEmailIdentityCommand")
      .map(
        (c) =>
          (c.input.DkimSigningAttributes as { DomainSigningPrivateKey: string })
            .DomainSigningPrivateKey,
      );
    expect(new Set(keys).size).toBe(2);
  });

  it("rejects an uppercase or bare-label name", async () => {
    const teamId = await createTeam(db);
    const caller = callerFor(teamId, fakeSes().deps);
    await expect(
      caller.domains.create({ name: "Updates.Example.com", region: "us-east-1" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.domains.create({ name: "localhost", region: "us-east-1" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("dedupes per team but allows the same name on another team", async () => {
    const teamA = await createTeam(db, "team-a");
    const teamB = await createTeam(db, "team-b");
    const { deps } = fakeSes();

    await callerFor(teamA, deps).domains.create({ name: "example.com", region: "us-east-1" });
    await expect(
      callerFor(teamA, deps).domains.create({ name: "example.com", region: "us-east-1" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const other = await callerFor(teamB, deps).domains.create({
      name: "example.com",
      region: "us-east-1",
    });
    expect(other.id).toBeTruthy();
  });

  it("with SES_TENANTS on, creates the team's tenant, associates identity + configuration set, and detaches on delete", async () => {
    vi.stubEnv("SES_TENANTS", "true");
    vi.stubEnv("SES_CONFIGURATION_SET", "millionsend");
    const teamId = await createTeam(db, "tenant-team");
    const { deps, calls } = fakeSes();
    const { id } = await callerFor(teamId, deps).domains.create({
      name: "tenant.example.com",
      region: "us-east-1",
    });
    expect(calls.map((c) => c.name)).toEqual([
      "CreateEmailIdentityCommand",
      "PutEmailIdentityMailFromAttributesCommand",
      "CreateTenantCommand",
      "CreateTenantResourceAssociationCommand",
      "CreateTenantResourceAssociationCommand",
    ]);
    expect(calls[2]?.input).toEqual({ TenantName: teamId });
    expect(calls.slice(3).map((c) => c.input.ResourceArn)).toEqual([
      "arn:aws:ses:us-east-1:123456789012:identity/tenant.example.com",
      "arn:aws:ses:us-east-1:123456789012:configuration-set/millionsend",
    ]);
    const [row] = await db.select().from(schema.domains).where(eq(schema.domains.id, id));
    expect(row?.sesTenantAssociatedAt).toBeInstanceOf(Date);
    const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
    expect(team?.sesTenantName).toBe(teamId);

    calls.length = 0;
    await callerFor(teamId, deps).domains.delete({ id });
    expect(calls.map((c) => c.name)).toEqual([
      "GetTenantCommand",
      "DeleteTenantResourceAssociationCommand",
      "DeleteEmailIdentityCommand",
    ]);
  });

  it("with SES_TENANTS on, delete detaches an identity whose association never completed", async () => {
    vi.stubEnv("SES_TENANTS", "true");
    vi.stubEnv("SES_CONFIGURATION_SET", "millionsend");
    const teamId = await createTeam(db, "tenant-partial");
    const { deps, calls } = fakeSes();
    // Identity association succeeds, configuration-set association fails: the
    // identity is attached to the tenant while the row stays unmarked.
    const inner = deps.clientForRegion("us-east-1");
    const partial: DomainsSesDeps = {
      ...deps,
      clientForRegion: () => ({
        async send(command) {
          const input = (command as unknown as { input: { ResourceArn?: string } }).input;
          if (
            command.constructor.name === "CreateTenantResourceAssociationCommand" &&
            input.ResourceArn?.includes(":configuration-set/")
          ) {
            throw Object.assign(new Error("no such set"), { name: "NotFoundException" });
          }
          return inner.send(command);
        },
      }),
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { id } = await callerFor(teamId, partial).domains.create({
      name: "partial.example.com",
      region: "us-east-1",
    });
    warn.mockRestore();
    const [row] = await db.select().from(schema.domains).where(eq(schema.domains.id, id));
    expect(row?.sesTenantAssociatedAt).toBeNull();

    // SES refuses to delete an attached identity, so the delete detaches first
    // even though nothing on the row says the identity is attached.
    calls.length = 0;
    await callerFor(teamId, partial).domains.delete({ id });
    expect(calls.map((c) => c.name)).toEqual([
      "GetTenantCommand",
      "DeleteTenantResourceAssociationCommand",
      "DeleteEmailIdentityCommand",
    ]);
  });

  it("in cloud, 409s a domain another team holds in the region and never adopts SES identities", async () => {
    vi.stubEnv("IS_CLOUD", "true");
    const teamA = await createTeam(db, "team-a");
    const teamB = await createTeam(db, "team-b");
    const { deps, calls } = fakeSes();
    await callerFor(teamA, deps).domains.create({
      name: "victim.example.com",
      region: "us-east-1",
    });
    await expect(
      callerFor(teamB, deps).domains.create({ name: "victim.example.com", region: "us-east-1" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(calls.filter((c) => c.name === "CreateEmailIdentityCommand")).toHaveLength(1);

    const existing: SesIdentityClient = {
      async send(command) {
        if (command.constructor.name === "CreateEmailIdentityCommand") {
          throw Object.assign(new Error("identity exists"), { name: "AlreadyExistsException" });
        }
        throw new Error(`unexpected ${command.constructor.name}`);
      },
    };
    await expect(
      callerFor(teamB, {
        clientForRegion: () => existing,
        resolveNs: async () => [],
      }).domains.create({ name: "taken.example.com", region: "us-east-1" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(
      await db.select().from(schema.domains).where(eq(schema.domains.teamId, teamB)),
    ).toHaveLength(0);
  });

  it("refuses public mailbox providers, and in cloud the platform and system-mail domains", async () => {
    const teamId = await createTeam(db);
    const caller = callerFor(teamId, fakeSes().deps);
    vi.stubEnv("AUTH_EMAIL_FROM", "MillionSend <no-reply@mail.ms-ops.dev>");
    await expect(
      caller.domains.create({ name: "gmail.com", region: "us-east-1" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // Self-host: the operator's auth domain is one of their own team domains.
    await caller.domains.create({ name: "mail.ms-ops.dev", region: "us-east-1" });

    vi.stubEnv("IS_CLOUD", "true");
    for (const name of ["millionsend.com", "app.millionsend.com", "mail.ms-ops.dev"]) {
      await expect(caller.domains.create({ name, region: "us-east-1" })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    }
  });

  it("in cloud, caps domains per plan", async () => {
    vi.stubEnv("IS_CLOUD", "true");
    const teamId = await createTeam(db);
    const caller = callerFor(teamId, fakeSes().deps);
    const limit = PLAN_DOMAIN_LIMIT.free ?? 0;
    for (let i = 0; i < limit; i++) {
      await caller.domains.create({ name: `d${i}.example.com`, region: "us-east-1" });
    }
    await expect(
      caller.domains.create({ name: "over.example.com", region: "us-east-1" }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("adopts an SES identity orphaned by a partial earlier create", async () => {
    const teamId = await createTeam(db);
    const calls: string[] = [];
    const client: SesIdentityClient = {
      async send(command) {
        const name = command.constructor.name;
        calls.push(name);
        if (name === "CreateEmailIdentityCommand") {
          throw Object.assign(new Error("identity exists"), { name: "AlreadyExistsException" });
        }
        return {};
      },
    };
    const { id } = await callerFor(teamId, {
      clientForRegion: () => client,
      resolveNs: async () => [],
    }).domains.create({
      name: "example.com",
      region: "us-east-1",
    });
    expect(id).toBeTruthy();
    // Adoption re-applies the fresh signing key before enabling MAIL FROM.
    expect(calls).toEqual([
      "CreateEmailIdentityCommand",
      "PutEmailIdentityDkimSigningAttributesCommand",
      "PutEmailIdentityMailFromAttributesCommand",
    ]);

    const [row] = await db.select().from(schema.domains).where(eq(schema.domains.id, id));
    expect(row?.dkimSelector).toBe("millionsend");
    expect(row?.dkimPublicKey).toBeTruthy();
  });

  it("maps the losing insert of a concurrent double-submit to CONFLICT", async () => {
    const teamId = await createTeam(db);
    // Deterministic race: the "other" submit wins between this call's
    // pre-check select and its insert.
    const client: SesIdentityClient = {
      async send(command) {
        if (command.constructor.name === "CreateEmailIdentityCommand") {
          await db.insert(schema.domains).values({
            teamId,
            name: "example.com",
            region: "us-east-1",
            mailFromSubdomain: "send",
            dkimSelector: "millionsend",
            dkimPublicKey: "winner-public-key",
          });
        }
        return {};
      },
    };
    await expect(
      callerFor(teamId, {
        clientForRegion: () => client,
        resolveNs: async () => [],
      }).domains.create({ name: "example.com", region: "us-east-1" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

// Live DNS answers for a fully-published example.com/us-east-1 zone. spf=false
// drops the SPF TXT so only that required record reads Missing. The DKIM TXT
// value carries the domain's stored public key.
function publishedDns(dkimPublicKey: string, { spf = true }: { spf?: boolean } = {}) {
  return {
    resolveTxt: async (name: string) => {
      if (name === "millionsend._domainkey.example.com") {
        return [[`v=DKIM1; k=rsa; p=${dkimPublicKey}`]];
      }
      if (name === "send.example.com" && spf) return [["v=spf1 include:amazonses.com ~all"]];
      return [];
    },
    resolveMx: async (name: string) =>
      name === "send.example.com"
        ? [{ priority: 10, exchange: "feedback-smtp.us-east-1.amazonses.com" }]
        : [],
  };
}

async function seedAndPublicKey(teamId: string): Promise<string> {
  const caller = callerFor(teamId, fakeSes().deps);
  const { id } = await caller.domains.create({ name: "example.com", region: "us-east-1" });
  const [row] = await db.select().from(schema.domains).where(eq(schema.domains.id, id));
  return row?.dkimPublicKey ?? "";
}

describe("domains.verify", () => {
  it("flips to verified only when every required record is live-found AND SES-verified", async () => {
    const teamId = await createTeam(db);
    const dkimPublicKey = await seedAndPublicKey(teamId);
    const { deps } = fakeSes({
      dkimStatus: "SUCCESS",
      verifiedForSending: true,
      dns: publishedDns(dkimPublicKey),
    });
    const caller = callerFor(teamId, deps);
    const [seed] = await db.select().from(schema.domains).where(eq(schema.domains.teamId, teamId));

    const result = await caller.domains.verify({ id: seed?.id ?? "" });
    expect(result.status).toBe("verified");
    expect(result.dkimStatus).toBe("SUCCESS");

    const [row] = await db.select().from(schema.domains).where(eq(schema.domains.teamId, teamId));
    expect(row?.status).toBe("verified");
    expect(row?.verifiedAt).toBeInstanceOf(Date);
    expect(row?.lastCheckedAt).toBeInstanceOf(Date);
  });

  it("stays pending when SES verifies but the SPF TXT is live-MISSING, then verifies once it appears", async () => {
    const teamId = await createTeam(db);
    const dkimPublicKey = await seedAndPublicKey(teamId);
    const [seed] = await db.select().from(schema.domains).where(eq(schema.domains.teamId, teamId));

    // DKIM + MX live-found + SES success, but SPF TXT absent from the zone: SES
    // reads mail-from success, yet strict verification refuses to call this
    // verified — the send gate must stay closed.
    const pending = callerFor(
      teamId,
      fakeSes({
        dkimStatus: "SUCCESS",
        verifiedForSending: true,
        dns: publishedDns(dkimPublicKey, { spf: false }),
      }).deps,
    );
    expect((await pending.domains.verify({ id: seed?.id ?? "" })).status).toBe("pending");
    let [row] = await db.select().from(schema.domains).where(eq(schema.domains.teamId, teamId));
    expect(row?.status).toBe("pending");
    expect(row?.verifiedAt).toBeNull();

    // Publish the SPF TXT: now every required record passes both gates.
    const verified = callerFor(
      teamId,
      fakeSes({
        dkimStatus: "SUCCESS",
        verifiedForSending: true,
        dns: publishedDns(dkimPublicKey),
      }).deps,
    );
    expect((await verified.domains.verify({ id: seed?.id ?? "" })).status).toBe("verified");
    [row] = await db.select().from(schema.domains).where(eq(schema.domains.teamId, teamId));
    expect(row?.status).toBe("verified");
    expect(row?.verifiedAt).toBeInstanceOf(Date);
  });

  it("verifies with DMARC missing — the optional records never gate", async () => {
    const teamId = await createTeam(db);
    const dkimPublicKey = await seedAndPublicKey(teamId);
    // Set a tracking subdomain so the optional tracking CNAME is also in play;
    // publishedDns answers neither DMARC nor the CNAME, and both must be ignored.
    const [seed] = await db.select().from(schema.domains).where(eq(schema.domains.teamId, teamId));
    const caller = callerFor(
      teamId,
      fakeSes({
        dkimStatus: "SUCCESS",
        verifiedForSending: true,
        dns: publishedDns(dkimPublicKey),
      }).deps,
    );
    await caller.domains.updateConfiguration({ id: seed?.id ?? "", trackingSubdomain: "email" });

    expect((await caller.domains.verify({ id: seed?.id ?? "" })).status).toBe("verified");
  });

  it("verify clears the tracking subdomain's 72h clock once its CNAME resolves", async () => {
    const teamId = await createTeam(db);
    const dkimPublicKey = await seedAndPublicKey(teamId);
    const [seed] = await db.select().from(schema.domains).where(eq(schema.domains.teamId, teamId));
    const id = seed?.id ?? "";
    // The resolver answers the CNAME only once the test has read the expected
    // value off the records list, so the first verify sees it unresolved.
    let cnameValue = "";
    const caller = callerFor(
      teamId,
      fakeSes({
        dkimStatus: "SUCCESS",
        verifiedForSending: true,
        dns: {
          ...publishedDns(dkimPublicKey),
          resolveCname: async (name: string) =>
            name === "email.example.com" && cnameValue ? [cnameValue] : [],
        },
      }).deps,
    );
    await caller.domains.updateConfiguration({ id, trackingSubdomain: "email" });
    await caller.domains.verify({ id });
    let [row] = await db.select().from(schema.domains).where(eq(schema.domains.id, id));
    expect(row?.trackingSubdomainSetAt).toBeInstanceOf(Date);

    const { records } = await caller.domains.records({ id });
    cnameValue = records.find((r) => r.group === "tracking")?.value ?? "";
    expect(cnameValue).not.toBe("");
    const { liveDns } = await caller.domains.verify({ id });
    expect(liveDns.find((r) => r.type === "CNAME")?.status).toBe("found");
    [row] = await db.select().from(schema.domains).where(eq(schema.domains.id, id));
    expect(row?.trackingSubdomainSetAt).toBeNull();
  });

  it("stays pending while DKIM is still propagating", async () => {
    const teamId = await createTeam(db);
    const { deps } = fakeSes({ dkimStatus: "PENDING" });
    const caller = callerFor(teamId, deps);
    const { id } = await caller.domains.create({ name: "example.com", region: "us-east-1" });

    const result = await caller.domains.verify({ id });
    expect(result.status).toBe("pending");

    const [row] = await db.select().from(schema.domains).where(eq(schema.domains.id, id));
    expect(row?.status).toBe("pending");
    expect(row?.verifiedAt).toBeNull();
    // Every verify pass persists the DNS snapshot, even while still pending.
    expect(row?.dnsRecords?.length).toBeGreaterThan(0);
    expect(row?.dnsRecords?.every((r) => r.status === "missing")).toBe(true);
    expect(row?.dmarcPolicy).toBeNull();
    expect(row?.dmarcCheckedAt).not.toBeNull();
  });
});

describe("domains.verify live DNS", () => {
  async function verifiedCaller(dns: Partial<DnsResolver>) {
    const teamId = await createTeam(db);
    const { deps } = fakeSes({ dns });
    const caller = callerFor(teamId, deps);
    const { id } = await caller.domains.create({ name: "example.com", region: "us-east-1" });
    return { caller, id };
  }

  it("marks a present, matching record Found", async () => {
    const { caller, id } = await verifiedCaller({
      resolveTxt: async (name) =>
        name === "send.example.com" ? [["v=spf1 include:amazonses.com ~all"]] : [],
    });
    const { liveDns } = await caller.domains.verify({ id });
    const spf = liveDns.find((r) => r.type === "TXT" && r.name === "send.example.com");
    expect(spf?.status).toBe("found");
  });

  it("marks a removed record Missing when the name does not resolve", async () => {
    const { caller, id } = await verifiedCaller({
      resolveTxt: async () => {
        throw ENOTFOUND;
      },
    });
    const { liveDns } = await caller.domains.verify({ id });
    expect(liveDns.find((r) => r.name === "_dmarc.example.com")?.status).toBe("missing");
  });

  it("reads a subdomain covered by the apex DMARC as Found and names the inherited record", async () => {
    const teamId = await createTeam(db);
    const { deps } = fakeSes({
      dns: {
        resolveTxt: async (name) =>
          name === "_dmarc.example.com" ? [["v=DMARC1; p=quarantine;"]] : [],
      },
    });
    const caller = callerFor(teamId, deps);
    const { id } = await caller.domains.create({
      name: "updates.example.com",
      region: "us-east-1",
    });
    const { liveDns } = await caller.domains.verify({ id });
    expect(liveDns.find((r) => r.name === "_dmarc.updates.example.com")).toMatchObject({
      status: "found",
      inherited: { name: "_dmarc.example.com", policy: "quarantine" },
    });
    const [row] = await db.select().from(schema.domains).where(eq(schema.domains.id, id));
    expect(row?.dmarcPolicy).toBe("quarantine");
  });

  it("marks a present-but-wrong value Mismatch", async () => {
    const { caller, id } = await verifiedCaller({
      resolveTxt: async (name) =>
        name === "millionsend._domainkey.example.com" ? [["v=DKIM1; k=rsa; p=WRONGKEY"]] : [],
    });
    const { liveDns } = await caller.domains.verify({ id });
    expect(liveDns.find((r) => r.name === "millionsend._domainkey.example.com")?.status).toBe(
      "mismatch",
    );
  });

  it("never throws when DNS lookups fail with NXDOMAIN or timeout", async () => {
    const { caller, id } = await verifiedCaller({
      resolveTxt: async () => {
        throw ENOTFOUND;
      },
      resolveMx: async () => {
        throw new Error("query timed out");
      },
      resolveCname: async () => {
        throw ENOTFOUND;
      },
    });
    const result = await caller.domains.verify({ id });
    expect(result.liveDns.length).toBeGreaterThan(0);
    // NXDOMAIN is conclusive absence; the MX timeout is inconclusive, kept
    // distinct so a resolver blip never reads as a removed record.
    expect(result.liveDns.filter((r) => r.type !== "MX").every((r) => r.status === "missing")).toBe(
      true,
    );
    expect(result.liveDns.find((r) => r.type === "MX")?.status).toBe("unknown");
  });
});

describe("tenant isolation", () => {
  it("blocks cross-team get/records/verify/delete and scopes list", async () => {
    const teamA = await createTeam(db, "team-a");
    const teamB = await createTeam(db, "team-b");
    const { deps } = fakeSes();
    const { id } = await callerFor(teamA, deps).domains.create({
      name: "example.com",
      region: "us-east-1",
    });

    const strangers = callerFor(teamB, deps);
    await expect(strangers.domains.get({ id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(strangers.domains.records({ id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(strangers.domains.verify({ id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(strangers.domains.delete({ id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(strangers.domains.list()).resolves.toEqual([]);

    const owners = await callerFor(teamA, deps).domains.list();
    expect(owners).toHaveLength(1);
  });
});

describe("domains.records", () => {
  it("derives the DNS checklist, with the DKIM TXT built from the stored key", async () => {
    const teamId = await createTeam(db);
    const { deps } = fakeSes();
    const caller = callerFor(teamId, deps);
    const { id } = await caller.domains.create({ name: "example.com", region: "us-east-1" });
    const [row] = await db.select().from(schema.domains).where(eq(schema.domains.id, id));

    const { records, provider } = await caller.domains.records({ id });
    expect(provider).toBeNull();
    expect(records).toHaveLength(4);
    expect(records.filter((r) => r.group === "verification")).toEqual([
      {
        group: "verification",
        type: "TXT",
        name: "millionsend._domainkey.example.com",
        value: `"v=DKIM1; k=rsa; p=${row?.dkimPublicKey}"`,
        status: "pending",
      },
    ]);
    expect(records).toContainEqual({
      group: "sending",
      type: "MX",
      name: "send.example.com",
      value: "feedback-smtp.us-east-1.amazonses.com",
      priority: 10,
      status: "pending",
    });
    // DMARC is never checked by SES, so it carries no state.
    expect(records.find((r) => r.group === "dmarc")?.status).toBeNull();
  });

  it("marks DKIM rows verified once SES reports SUCCESS and detects the NS provider", async () => {
    const teamId = await createTeam(db);
    const { deps } = fakeSes({
      dkimStatus: "SUCCESS",
      verifiedForSending: true,
      nsHosts: ["a.sec.dns.br", "ns1.registro.br"],
    });
    const caller = callerFor(teamId, deps);
    const { id } = await caller.domains.create({
      name: "updates.example.com.br",
      region: "us-east-1",
    });

    const { records, provider } = await caller.domains.records({ id });
    expect(provider).toEqual({ name: "Registro.br", url: "https://registro.br/painel/" });
    for (const record of records.filter((r) => r.group !== "dmarc")) {
      expect(record.status).toBe("verified");
    }
  });
});

describe("domains.get", () => {
  it("returns a zero sent count for a fresh domain", async () => {
    const teamId = await createTeam(db);
    const caller = callerFor(teamId, fakeSes().deps);
    const { id } = await caller.domains.create({ name: "example.com", region: "us-east-1" });
    const domain = await caller.domains.get({ id });
    expect(domain.sentCount).toBe(0);
  });
});

describe("domains.delete", () => {
  it("deletes the SES identity and the row", async () => {
    const teamId = await createTeam(db);
    const { deps, calls } = fakeSes();
    const caller = callerFor(teamId, deps);
    const { id } = await caller.domains.create({ name: "example.com", region: "us-east-1" });

    await caller.domains.delete({ id });
    expect(calls.at(-1)).toMatchObject({
      name: "DeleteEmailIdentityCommand",
      input: { EmailIdentity: "example.com" },
    });
    const rows = await db.select().from(schema.domains).where(eq(schema.domains.id, id));
    expect(rows).toHaveLength(0);
  });

  it("fails the domain's queued emails in the delete and keeps an identity other rows share", async () => {
    const teamId = await createTeam(db, "team-a");
    const otherTeam = await createTeam(db, "team-b");
    const { deps, calls } = fakeSes();
    const caller = callerFor(teamId, deps);
    const { id } = await caller.domains.create({ name: "example.com", region: "us-east-1" });
    const [queued] = await db
      .insert(schema.emails)
      .values({
        teamId,
        domainId: id,
        from: "a@example.com",
        to: ["r@x.com"],
        subject: "s",
        scheduledAt: new Date(Date.now() + 60_000),
      })
      .returning({ id: schema.emails.id });
    // Self-host: another team registered the same identity in the same region.
    await db
      .insert(schema.domains)
      .values({ teamId: otherTeam, name: "example.com", region: "us-east-1" });

    await caller.domains.delete({ id });
    expect(calls.some((c) => c.name === "DeleteEmailIdentityCommand")).toBe(false);
    expect(await db.select().from(schema.domains).where(eq(schema.domains.id, id))).toHaveLength(0);
    const [email] = await db
      .select({ status: schema.emails.latestStatus })
      .from(schema.emails)
      .where(eq(schema.emails.id, queued?.id ?? ""));
    expect(email?.status).toBe("failed");
    const events = await db
      .select({ type: schema.emailEvents.type })
      .from(schema.emailEvents)
      .where(eq(schema.emailEvents.emailId, queued?.id ?? ""));
    expect(events).toEqual([{ type: "failed" }]);
  });

  it("revokes and unscopes domain-scoped keys so the restrict FK cannot block the delete", async () => {
    const teamId = await createTeam(db);
    const caller = callerFor(teamId, fakeSes().deps);
    const { id } = await caller.domains.create({ name: "example.com", region: "us-east-1" });
    const [key] = await db
      .insert(schema.apiKeys)
      .values({
        teamId,
        name: "scoped",
        tokenPrefix: "ms_live_scoped",
        keyHash: "hash-scoped",
        last4: "abcd",
        domainId: id,
      })
      .returning({ id: schema.apiKeys.id });

    await caller.domains.delete({ id });

    expect(await db.select().from(schema.domains).where(eq(schema.domains.id, id))).toHaveLength(0);
    const [row] = await db
      .select()
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.id, key?.id ?? ""));
    expect(row?.domainId).toBeNull();
    expect(row?.revokedAt).not.toBeNull();
  });
});

describe("domains.updateConfiguration", () => {
  it("persists toggles and the subdomain, and both tracking kinds default off", async () => {
    const teamId = await createTeam(db);
    const caller = callerFor(teamId, fakeSes().deps);
    const { id } = await caller.domains.create({ name: "example.com", region: "us-east-1" });

    const before = await caller.domains.get({ id });
    expect(before.openTracking).toBe(false);
    expect(before.clickTracking).toBe(false);
    expect(before.trackingSubdomain).toBeNull();
    expect(before.tlsMode).toBe("opportunistic");

    const result = await caller.domains.updateConfiguration({
      id,
      openTracking: true,
      clickTracking: false,
      trackingSubdomain: "email",
      tlsMode: "enforced",
    });
    expect(result).toEqual({
      openTracking: true,
      clickTracking: false,
      trackingSubdomain: "email",
      tlsMode: "enforced",
    });

    const after = await caller.domains.get({ id });
    expect(after.openTracking).toBe(true);
    expect(after.clickTracking).toBe(false);
    expect(after.trackingSubdomain).toBe("email");
    expect(after.tlsMode).toBe("enforced");
  });

  it("rejects an unknown tlsMode", async () => {
    const teamId = await createTeam(db);
    const caller = callerFor(teamId, fakeSes().deps);
    const { id } = await caller.domains.create({ name: "example.com", region: "us-east-1" });

    await expect(
      // @ts-expect-error — exercising the enum guard with an out-of-range value
      caller.domains.updateConfiguration({ id, tlsMode: "strict" }),
    ).rejects.toThrow();
    expect((await caller.domains.get({ id })).tlsMode).toBe("opportunistic");
  });

  it("clears the subdomain when passed an empty string", async () => {
    const teamId = await createTeam(db);
    const caller = callerFor(teamId, fakeSes().deps);
    const { id } = await caller.domains.create({ name: "example.com", region: "us-east-1" });
    await caller.domains.updateConfiguration({ id, trackingSubdomain: "email" });

    await caller.domains.updateConfiguration({ id, trackingSubdomain: "" });
    expect((await caller.domains.get({ id })).trackingSubdomain).toBeNull();
  });

  it("rejects a subdomain that is not a lowercase DNS label", async () => {
    const teamId = await createTeam(db);
    const caller = callerFor(teamId, fakeSes().deps);
    const { id } = await caller.domains.create({ name: "example.com", region: "us-east-1" });

    await expect(
      caller.domains.updateConfiguration({ id, trackingSubdomain: "Not A Label" }),
    ).rejects.toThrow();
    await expect(
      caller.domains.updateConfiguration({ id, trackingSubdomain: "a.b" }),
    ).rejects.toThrow();
  });

  it("is scoped to the caller's team", async () => {
    const teamA = await createTeam(db, "team-a");
    const teamB = await createTeam(db, "team-b");
    const { id } = await callerFor(teamA, fakeSes().deps).domains.create({
      name: "example.com",
      region: "us-east-1",
    });

    await expect(
      callerFor(teamB, fakeSes().deps).domains.updateConfiguration({ id, openTracking: true }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await callerFor(teamA, fakeSes().deps).domains.get({ id })).openTracking).toBe(false);
  });

  it("surfaces the branded tracking CNAME once a subdomain is set", async () => {
    const teamId = await createTeam(db);
    const caller = callerFor(teamId, fakeSes().deps);
    const { id } = await caller.domains.create({ name: "example.com", region: "us-east-1" });

    expect((await caller.domains.records({ id })).records.some((r) => r.group === "tracking")).toBe(
      false,
    );

    await caller.domains.updateConfiguration({ id, trackingSubdomain: "email" });
    const { records } = await caller.domains.records({ id });
    // App-layer tracking: the branded CNAME points at THIS app host (default
    // localhost:3000 when APP_BASE_URL is unset), not SES's awstrack.me.
    expect(records).toContainEqual({
      group: "tracking",
      type: "CNAME",
      name: "email.example.com",
      value: new URL(process.env.APP_BASE_URL ?? "http://localhost:3000").host,
      status: null,
    });
  });

  // "" rather than "false": under SKIP_ENV_VALIDATION the env proxy carries raw
  // strings, where "false" would be truthy.
  function cloudWithoutTrackingSubdomains() {
    vi.stubEnv("IS_CLOUD", "true");
    vi.stubEnv("ALLOW_TRACKING_SUBDOMAINS", "");
  }

  it("refuses to adopt a subdomain where the deployment cannot serve one", async () => {
    const teamId = await createTeam(db);
    const caller = callerFor(teamId, fakeSes().deps);
    const { id } = await caller.domains.create({ name: "gated.example.com", region: "us-east-1" });

    cloudWithoutTrackingSubdomains();
    await expect(
      caller.domains.updateConfiguration({ id, trackingSubdomain: "email" }),
    ).rejects.toThrow(/not available/i);
    const [row] = await db.select().from(schema.domains).where(eq(schema.domains.id, id));
    expect(row?.trackingSubdomain).toBeNull();
  });

  it("keeps clearing a stored subdomain possible after the deployment stops serving them", async () => {
    const teamId = await createTeam(db);
    const caller = callerFor(teamId, fakeSes().deps);
    const { id } = await caller.domains.create({
      name: "stranded.example.com",
      region: "us-east-1",
    });
    await caller.domains.updateConfiguration({ id, trackingSubdomain: "email" });

    cloudWithoutTrackingSubdomains();
    // The CNAME stops being advertised, but the value stays clearable.
    expect((await caller.domains.records({ id })).records.some((r) => r.group === "tracking")).toBe(
      false,
    );
    await caller.domains.updateConfiguration({ id, trackingSubdomain: "" });
    const [row] = await db.select().from(schema.domains).where(eq(schema.domains.id, id));
    expect(row?.trackingSubdomain).toBeNull();
  });

  it("refuses a tracking subdomain equal to the return-path (MAIL FROM) subdomain", async () => {
    const teamId = await createTeam(db);
    const caller = callerFor(teamId, fakeSes().deps);
    // create defaults the MAIL FROM subdomain to "send".
    const { id } = await caller.domains.create({ name: "clash.example.com", region: "us-east-1" });

    await expect(
      caller.domains.updateConfiguration({ id, trackingSubdomain: "send" }),
    ).rejects.toThrow(/return-path/i);
    const [row] = await db.select().from(schema.domains).where(eq(schema.domains.id, id));
    expect(row?.trackingSubdomain).toBeNull();

    // A different label is accepted.
    await caller.domains.updateConfiguration({ id, trackingSubdomain: "links" });
    const [ok] = await db.select().from(schema.domains).where(eq(schema.domains.id, id));
    expect(ok?.trackingSubdomain).toBe("links");
  });
});
