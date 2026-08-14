import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import type { DkimVerificationStatus, SesIdentityClient } from "@millionsend/ses";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDomainsRouter, type DomainsSesDeps } from "@/server/routers/domains";
import { type Context, createCallerFactory, router } from "@/server/trpc";

const TOKENS = ["tok1aaa", "tok2bbb", "tok3ccc"];

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});

afterEach(async () => {
  await close();
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
      if (name === "CreateEmailIdentityCommand") {
        return { DkimAttributes: { Tokens: TOKENS } };
      }
      if (name === "GetEmailIdentityCommand") {
        return {
          VerifiedForSendingStatus: state.verifiedForSending ?? false,
          DkimAttributes: { Status: state.dkimStatus ?? "PENDING", Tokens: TOKENS },
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
  it("registers the SES identity and inserts a pending row with DKIM tokens", async () => {
    const teamId = await createTeam(db);
    const { deps, calls } = fakeSes();
    const { id } = await callerFor(teamId, deps).domains.create({
      name: "updates.example.com",
      region: "sa-east-1",
    });

    expect(calls.map((c) => c.name)).toEqual([
      "CreateEmailIdentityCommand",
      "PutEmailIdentityMailFromAttributesCommand",
    ]);
    expect(calls[1]?.input).toMatchObject({
      EmailIdentity: "updates.example.com",
      MailFromDomain: "send.updates.example.com",
    });

    const [row] = await db.select().from(schema.domains).where(eq(schema.domains.id, id));
    expect(row).toMatchObject({
      teamId,
      name: "updates.example.com",
      region: "sa-east-1",
      status: "pending",
      mailFromSubdomain: "send",
      dkimTokens: TOKENS,
    });
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
        if (name === "GetEmailIdentityCommand") {
          return { DkimAttributes: { Status: "PENDING", Tokens: TOKENS } };
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
    expect(calls).toContain("PutEmailIdentityMailFromAttributesCommand");

    const [row] = await db.select().from(schema.domains).where(eq(schema.domains.id, id));
    expect(row?.dkimTokens).toEqual(TOKENS);
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
          });
          return { DkimAttributes: { Tokens: TOKENS } };
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
  it("derives the DNS checklist with per-record check state from the live identity", async () => {
    const teamId = await createTeam(db);
    const { deps } = fakeSes();
    const caller = callerFor(teamId, deps);
    const { id } = await caller.domains.create({ name: "example.com", region: "eu-west-1" });

    const { records, provider } = await caller.domains.records({ id });
    expect(provider).toBeNull();
    expect(records).toHaveLength(6);
    expect(records.filter((r) => r.group === "verification")).toHaveLength(3);
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
