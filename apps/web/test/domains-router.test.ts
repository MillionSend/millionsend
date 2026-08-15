import { createPublicKey } from "node:crypto";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import type { DkimVerificationStatus, SesIdentityClient } from "@millionsend/ses";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDomainsRouter, type DomainsSesDeps } from "@/server/routers/domains";
import { type Context, createCallerFactory, router } from "@/server/trpc";

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});

afterEach(async () => {
  await close();
  vi.restoreAllMocks();
});

interface FakeSesState {
  dkimStatus?: DkimVerificationStatus;
  verifiedForSending?: boolean;
  nsHosts?: string[];
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
      return {};
    },
  };
  const deps: DomainsSesDeps = {
    clientForRegion: () => client,
    resolveNs: async () => state.nsHosts ?? [],
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

function callerFor(teamId: string, deps: DomainsSesDeps) {
  const factory = createCallerFactory(router({ domains: createDomainsRouter(deps) }));
  const ctx: Context = {
    db,
    session: { user: { id: "u1", email: "u1@example.com", name: "u1" } },
    teamId,
    role: "owner",
  };
  return factory(ctx);
}

describe("domains.create", () => {
  it("uploads a BYODKIM key to SES and stores only the selector and public half", async () => {
    const teamId = await createTeam(db);
    const { deps, calls } = fakeSes();
    const consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method),
    );
    const { id } = await callerFor(teamId, deps).domains.create({
      name: "updates.example.com",
      region: "sa-east-1",
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
      region: "sa-east-1",
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

describe("domains.verify", () => {
  it("flips status to verified and stamps verifiedAt when SES reports SUCCESS", async () => {
    const teamId = await createTeam(db);
    const { deps } = fakeSes({ dkimStatus: "SUCCESS", verifiedForSending: true });
    const caller = callerFor(teamId, deps);
    const { id } = await caller.domains.create({ name: "example.com", region: "us-east-1" });

    const result = await caller.domains.verify({ id });
    expect(result.status).toBe("verified");
    expect(result.dkimStatus).toBe("SUCCESS");

    const [row] = await db.select().from(schema.domains).where(eq(schema.domains.id, id));
    expect(row?.status).toBe("verified");
    expect(row?.verifiedAt).toBeInstanceOf(Date);
    expect(row?.lastCheckedAt).toBeInstanceOf(Date);
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
    const { id } = await caller.domains.create({ name: "example.com", region: "eu-west-1" });
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
      value: "feedback-smtp.eu-west-1.amazonses.com",
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
      region: "sa-east-1",
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
});

describe("domains.updateConfiguration", () => {
  it("persists toggles and the subdomain, and defaults are open=off click=on", async () => {
    const teamId = await createTeam(db);
    const caller = callerFor(teamId, fakeSes().deps);
    const { id } = await caller.domains.create({ name: "example.com", region: "us-east-1" });

    const before = await caller.domains.get({ id });
    expect(before.openTracking).toBe(false);
    expect(before.clickTracking).toBe(true);
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
    const { id } = await caller.domains.create({ name: "example.com", region: "eu-west-1" });

    expect((await caller.domains.records({ id })).records.some((r) => r.group === "tracking")).toBe(
      false,
    );

    await caller.domains.updateConfiguration({ id, trackingSubdomain: "email" });
    const { records } = await caller.domains.records({ id });
    expect(records).toContainEqual({
      group: "tracking",
      type: "CNAME",
      name: "email.example.com",
      value: "r.eu-west-1.awstrack.me",
      status: null,
    });
  });
});
