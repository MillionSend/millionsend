import { randomBytes } from "node:crypto";
import {
  DOMAIN_CREATE_LIMIT_PER_HOUR,
  EnvKeyring,
  forgetPhishingPrints,
  generateApiKey,
  hashApiKey,
  PLAN_DOMAIN_LIMIT,
  SUSPENSION_REASONS,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import type { DkimVerificationStatus, DnsResolver, SesIdentityClient } from "@millionsend/ses";
import { createTeam, createTestDb, createWebhookEndpoint } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type ApiDeps, createApi } from "../src/app.js";

// Inbox deletion is the inbox module's; here only that the domain delete asks for it.
const deleteInboxes = vi.hoisted(() => vi.fn());
vi.mock("@millionsend/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@millionsend/core")>()),
  deleteInboxes,
}));

let db: Db;
let close: () => Promise<void>;
let teamId: string;
let otherTeamId: string;
let fullKey: string;
let sendKey: string;
let otherTeamKey: string;

interface FakeSesState {
  dkimStatus?: DkimVerificationStatus;
  verifiedForSending?: boolean;
  createError?: Error;
  deleteError?: Error;
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
      if (name === "CreateEmailIdentityCommand" && state.createError) throw state.createError;
      if (name === "DeleteEmailIdentityCommand" && state.deleteError) throw state.deleteError;
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
        const arn = `arn:aws:ses:sa-east-1:123456789012:tenant/${tenantName}`;
        return name === "CreateTenantCommand" ? { TenantArn: arn } : { Tenant: { TenantArn: arn } };
      }
      return {};
    },
  };
  return { client, calls };
}

// Default resolver answers nothing (every record reads Missing) and touches
// no network; tests that verify override the methods they exercise.
function fakeDns(overrides: Partial<DnsResolver> = {}): DnsResolver {
  return {
    resolveTxt: overrides.resolveTxt ?? (async () => []),
    resolveMx: overrides.resolveMx ?? (async () => []),
    resolveCname: overrides.resolveCname ?? (async () => []),
  };
}

function makeApp(opts: {
  client: SesIdentityClient;
  dns?: DnsResolver;
  appBaseUrl?: string | undefined;
  trackingSubdomains?: boolean | undefined;
  isCloud?: boolean;
  authEmailFrom?: string;
  tenants?: { configurationSet?: string | undefined };
  regions?: string[];
  receiving?: ApiDeps["receiving"];
  sharedInboxDomain?: string;
  enqueueWebhookDeliveries?: ApiDeps["enqueueWebhookDeliveries"];
}) {
  const deps: ApiDeps = {
    db,
    keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
    isCloud: opts.isCloud ?? false,
    enqueueEmailSend: async () => {},
    appBaseUrl: opts.appBaseUrl,
    trackingSubdomains: opts.trackingSubdomains,
    receiving: opts.receiving,
    sharedInboxDomain: opts.sharedInboxDomain,
    enqueueWebhookDeliveries: opts.enqueueWebhookDeliveries,
    ses: {
      clientForRegion: () => opts.client,
      dns: opts.dns ?? fakeDns(),
      regions: opts.regions ?? ["sa-east-1"],
      authEmailFrom: opts.authEmailFrom,
      tenants: opts.tenants,
    },
  };
  return createApi(deps);
}

function call(
  app: ReturnType<typeof createApi>,
  token: string,
  method: string,
  path: string,
  body?: unknown,
) {
  return app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function insertKey(
  team: string,
  overrides: Partial<typeof schema.apiKeys.$inferInsert> = {},
) {
  const key = generateApiKey();
  await db.insert(schema.apiKeys).values({
    teamId: team,
    name: "k",
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
    ...overrides,
  });
  return key.token;
}

async function createDomain(
  app: ReturnType<typeof createApi>,
  name: string,
  extra: Record<string, unknown> = {},
) {
  const res = await call(app, fullKey, "POST", "/domains", { name, ...extra });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown> & { id: string };
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "domains-team");
  otherTeamId = await createTeam(db, "domains-other-team");
  fullKey = await insertKey(teamId);
  sendKey = await insertKey(teamId, { permission: "sending_access" });
  otherTeamKey = await insertKey(otherTeamId);
});
afterAll(() => close());

describe("POST /domains", () => {
  it("registers a BYODKIM SES identity and returns the DNS records", async () => {
    const { client, calls } = fakeSes();
    const app = makeApp({ client });
    const body = await createDomain(app, "updates.example.com", { region: "sa-east-1" });

    expect(calls.map((c) => c.name)).toEqual([
      "CreateEmailIdentityCommand",
      "PutEmailIdentityMailFromAttributesCommand",
    ]);
    expect(calls[1]?.input).toMatchObject({ MailFromDomain: "send.updates.example.com" });

    const [row] = await db
      .select()
      .from(schema.domains)
      .where(eq(schema.domains.id, body.id as string));
    expect(row).toMatchObject({
      teamId,
      name: "updates.example.com",
      region: "sa-east-1",
      status: "pending",
      dkimSelector: "millionsend",
    });

    expect(body).toMatchObject({
      name: "updates.example.com",
      status: "pending",
      region: "sa-east-1",
      // Both tracking kinds start off, as the Domains docs promise.
      open_tracking: false,
      click_tracking: false,
      tracking_subdomain: null,
      capabilities: { sending: "enabled", receiving: "disabled" },
    });
    expect(body.records).toContainEqual({
      record: "DKIM",
      name: "millionsend._domainkey.updates.example.com",
      type: "TXT",
      ttl: "Auto",
      status: "not_started",
      value: `"v=DKIM1; k=rsa; p=${row?.dkimPublicKey}"`,
    });
    expect(body.records).toContainEqual({
      record: "SPF",
      name: "send.updates.example.com",
      type: "MX",
      ttl: "Auto",
      status: "not_started",
      value: "feedback-smtp.sa-east-1.amazonses.com",
      priority: 10,
    });
    // The response never carries private-key material.
    expect(JSON.stringify(body)).not.toContain("PRIVATE");
  });

  it("defaults region to the deployment's SES region and echoes it", async () => {
    const app = makeApp(fakeSes());
    const body = await createDomain(app, "default-region.example.com");
    expect(body.region).toBe("sa-east-1");
  });

  it("accepts every served region and defaults to the first when several are served", async () => {
    const { client, calls } = fakeSes();
    const app = makeApp({ client, regions: ["sa-east-1", "us-east-1"] });
    const us = await createDomain(app, "us.example.com", { region: "us-east-1" });
    expect(us.region).toBe("us-east-1");
    const first = await createDomain(app, "first.example.com");
    expect(first.region).toBe("sa-east-1");
    expect(calls.filter((c) => c.name === "CreateEmailIdentityCommand")).toHaveLength(2);
    const unserved = await call(app, fullKey, "POST", "/domains", {
      name: "far.example.com",
      region: "eu-west-1",
    });
    expect(unserved.status).toBe(422);
  });

  it("applies optional tracking settings at creation and returns the Tracking CNAME", async () => {
    const app = makeApp({ ...fakeSes(), appBaseUrl: "https://app.example.dev" });
    const res = await call(app, fullKey, "POST", "/domains", {
      name: "tracked.example.com",
      click_tracking: true,
      tracking_subdomain: "links",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; records: unknown[] } & Record<string, unknown>;
    expect(body).toMatchObject({
      open_tracking: false,
      click_tracking: true,
      tracking_subdomain: "links",
    });
    // The CNAME rides the create response like DKIM does, not_started like them.
    expect(body.records).toContainEqual(
      expect.objectContaining({
        record: "Tracking",
        name: "links.tracked.example.com",
        value: "app.example.dev",
        status: "not_started",
      }),
    );
    const [row] = await db.select().from(schema.domains).where(eq(schema.domains.id, body.id));
    expect(row).toMatchObject({
      clickTracking: true,
      openTracking: false,
      trackingSubdomain: "links",
    });
    expect(row?.trackingSubdomainSetAt).toBeInstanceOf(Date);
  });

  it("with SES tenants on, creates the team's tenant and associates the identity and configuration set", async () => {
    const t = await (async () => {
      const id = await createTeam(db, "cloud-tenant-team");
      return { id, key: await insertKey(id) };
    })();
    const { client, calls } = fakeSes();
    const app = makeApp({ client, isCloud: true, tenants: { configurationSet: "millionsend" } });
    const created = await call(app, t.key, "POST", "/domains", { name: "tenant.example.com" });
    expect(created.status).toBe(200);
    const { id } = (await created.json()) as { id: string };

    expect(calls.map((c) => c.name)).toEqual([
      "CreateEmailIdentityCommand",
      "PutEmailIdentityMailFromAttributesCommand",
      "CreateTenantCommand",
      "CreateTenantResourceAssociationCommand",
      "CreateTenantResourceAssociationCommand",
    ]);
    expect(calls[2]?.input).toEqual({ TenantName: t.id });
    expect(calls.slice(3).map((c) => c.input.ResourceArn)).toEqual([
      "arn:aws:ses:sa-east-1:123456789012:identity/tenant.example.com",
      "arn:aws:ses:sa-east-1:123456789012:configuration-set/millionsend",
    ]);
    const [row] = await db.select().from(schema.domains).where(eq(schema.domains.id, id));
    expect(row?.sesTenantAssociatedAt).toBeInstanceOf(Date);
    expect(row?.sesTenantConfigSet).toBe("millionsend");
    const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, t.id));
    expect(team?.sesTenantName).toBe(t.id);

    // Deleting detaches the identity from the tenant before dropping it.
    calls.length = 0;
    expect((await call(app, t.key, "DELETE", `/domains/${id}`)).status).toBe(200);
    expect(calls.map((c) => c.name)).toEqual([
      "GetTenantCommand",
      "DeleteTenantResourceAssociationCommand",
      "DeleteEmailIdentityCommand",
    ]);
  });

  it("with SES tenants on, delete detaches an identity whose association never completed", async () => {
    const t = await (async () => {
      const id = await createTeam(db, "cloud-tenant-partial");
      return { id, key: await insertKey(id) };
    })();
    const { client, calls } = fakeSes();
    // Identity association succeeds, configuration-set association fails: the
    // identity is attached to the tenant while the row stays unmarked.
    const partial: SesIdentityClient = {
      async send(command) {
        const input = (command as unknown as { input: { ResourceArn?: string } }).input;
        if (
          command.constructor.name === "CreateTenantResourceAssociationCommand" &&
          input.ResourceArn?.includes(":configuration-set/")
        ) {
          throw Object.assign(new Error("no such set"), { name: "NotFoundException" });
        }
        return client.send(command);
      },
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const app = makeApp({
      client: partial,
      isCloud: true,
      tenants: { configurationSet: "millionsend" },
    });
    const created = await call(app, t.key, "POST", "/domains", { name: "partial.example.com" });
    expect(created.status).toBe(200);
    warn.mockRestore();
    const { id } = (await created.json()) as { id: string };
    const [row] = await db.select().from(schema.domains).where(eq(schema.domains.id, id));
    expect(row?.sesTenantAssociatedAt).toBeNull();

    // SES refuses to delete an attached identity, so the delete detaches first
    // even though nothing on the row says the identity is attached.
    calls.length = 0;
    expect((await call(app, t.key, "DELETE", `/domains/${id}`)).status).toBe(200);
    expect(calls.map((c) => c.name)).toEqual([
      "GetTenantCommand",
      "DeleteTenantResourceAssociationCommand",
      "DeleteEmailIdentityCommand",
    ]);
  });

  it("with SES tenants on, a failed association never fails the create and leaves the marker for the backfill", async () => {
    const t = await (async () => {
      const id = await createTeam(db, "cloud-tenant-fail");
      return { id, key: await insertKey(id) };
    })();
    const { client, calls } = fakeSes();
    const throwing: SesIdentityClient = {
      async send(command) {
        if (command.constructor.name === "CreateTenantCommand") {
          throw Object.assign(new Error("throttled"), { name: "TooManyRequestsException" });
        }
        return client.send(command);
      },
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const app = makeApp({ client: throwing, isCloud: true, tenants: {} });
    const created = await call(app, t.key, "POST", "/domains", { name: "later.example.com" });
    expect(created.status).toBe(200);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    const { id } = (await created.json()) as { id: string };
    const [row] = await db.select().from(schema.domains).where(eq(schema.domains.id, id));
    expect(row?.sesTenantAssociatedAt).toBeNull();
    expect(calls.filter((c) => c.name.includes("Tenant"))).toHaveLength(0);
  });

  it("cloud: refuses creating with tracking on and no subdomain before touching SES", async () => {
    const key = await insertKey(await createTeam(db, "cloud-create-tracking"));
    const { client, calls } = fakeSes();
    const app = makeApp({ client, isCloud: true, appBaseUrl: "https://app.example.dev" });
    const res = await call(app, key, "POST", "/domains", {
      name: "untracked.example.com",
      open_tracking: true,
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { message: string }).message).toContain("tracking_subdomain");
    expect(calls.filter((c) => c.name === "CreateEmailIdentityCommand")).toHaveLength(0);
    const rows = await db
      .select({ id: schema.domains.id })
      .from(schema.domains)
      .where(eq(schema.domains.name, "untracked.example.com"));
    expect(rows).toHaveLength(0);
  });

  it("422s a tracking subdomain equal to the return path on create", async () => {
    const app = makeApp({ ...fakeSes(), appBaseUrl: "https://app.example.dev" });
    const res = await call(app, fullKey, "POST", "/domains", {
      name: "collide.example.com",
      custom_return_path: "send",
      tracking_subdomain: "send",
    });
    expect(res.status).toBe(422);
  });

  it("rejects a region the deployment does not serve, an unknown region, and an uppercase name", async () => {
    const { client, calls } = fakeSes();
    const app = makeApp({ client });
    // A real SES region, just not this deployment's: refused by name before
    // any identity is created or DNS record handed out.
    const unserved = await call(app, fullKey, "POST", "/domains", {
      name: "r.example.com",
      region: "eu-west-1",
    });
    expect(unserved.status).toBe(422);
    expect(await unserved.json()).toMatchObject({
      name: "validation_error",
      message: expect.stringContaining("sa-east-1"),
    });
    expect(calls).toHaveLength(0);
    const badRegion = await call(app, fullKey, "POST", "/domains", {
      name: "r.example.com",
      region: "us-west-2",
    });
    expect(badRegion.status).toBe(422);
    const badName = await call(app, fullKey, "POST", "/domains", { name: "Upper.Example.com" });
    expect(badName.status).toBe(422);
  });

  it("409s a duplicate name within the team", async () => {
    const app = makeApp(fakeSes());
    await createDomain(app, "dupe.example.com");
    const res = await call(app, fullKey, "POST", "/domains", { name: "dupe.example.com" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ statusCode: 409, name: "conflict" });
  });
});

describe("POST /domains in cloud (shared AWS account)", () => {
  const ALREADY_EXISTS = Object.assign(new Error("exists"), { name: "AlreadyExistsException" });
  async function cloudTeam(slug: string) {
    const id = await createTeam(db, slug);
    return { id, key: await insertKey(id) };
  }

  it("in cloud, 409s a domain another team holds in another served region", async () => {
    const { client, calls } = fakeSes();
    const app = makeApp({ client, isCloud: true, regions: ["sa-east-1", "us-east-1"] });
    await db
      .insert(schema.domains)
      .values({ teamId: otherTeamId, name: "elsewhere.example.com", region: "sa-east-1" });
    const res = await call(app, fullKey, "POST", "/domains", {
      name: "elsewhere.example.com",
      region: "us-east-1",
    });
    expect(res.status).toBe(409);
    expect(calls.filter((c) => c.name === "CreateEmailIdentityCommand")).toHaveLength(0);
  });

  it("409s a domain another team holds in the same region and never re-keys it", async () => {
    const a = await cloudTeam("cloud-a");
    const b = await cloudTeam("cloud-b");
    const { client, calls } = fakeSes();
    const app = makeApp({ client, isCloud: true });
    const first = await call(app, a.key, "POST", "/domains", {
      name: "victim.example.com",
      region: "sa-east-1",
    });
    expect(first.status).toBe(200);
    const second = await call(app, b.key, "POST", "/domains", {
      name: "victim.example.com",
      region: "sa-east-1",
    });
    expect(second.status).toBe(409);
    expect(calls.filter((c) => c.name === "CreateEmailIdentityCommand")).toHaveLength(1);
  });

  it("409s instead of adopting an identity SES already holds", async () => {
    const t = await cloudTeam("cloud-c");
    const { client, calls } = fakeSes({ createError: ALREADY_EXISTS });
    const res = await call(makeApp({ client, isCloud: true }), t.key, "POST", "/domains", {
      name: "taken.example.com",
    });
    expect(res.status).toBe(409);
    expect(calls.map((c) => c.name)).toEqual(["CreateEmailIdentityCommand"]);
    expect(
      await db.select().from(schema.domains).where(eq(schema.domains.teamId, t.id)),
    ).toHaveLength(0);
  });

  it("still adopts an orphaned identity on self-host", async () => {
    const { client, calls } = fakeSes({ createError: ALREADY_EXISTS });
    const res = await call(makeApp({ client }), fullKey, "POST", "/domains", {
      name: "orphan.example.com",
    });
    expect(res.status).toBe(200);
    expect(calls.map((c) => c.name)).toContain("PutEmailIdentityDkimSigningAttributesCommand");
  });

  it("422s public mailbox providers everywhere and platform/system-mail domains in cloud", async () => {
    const authEmailFrom = "MillionSend <no-reply@mail.ms-ops.dev>";
    const cloud = makeApp({ ...fakeSes(), isCloud: true, authEmailFrom });
    for (const name of ["gmail.com", "millionsend.com", "mail.ms-ops.dev"]) {
      const res = await call(cloud, fullKey, "POST", "/domains", { name });
      expect(res.status, name).toBe(422);
    }
    const selfHost = makeApp({ ...fakeSes(), authEmailFrom });
    expect((await call(selfHost, fullKey, "POST", "/domains", { name: "gmail.com" })).status).toBe(
      422,
    );
    expect(
      (await call(selfHost, fullKey, "POST", "/domains", { name: "mail.ms-ops.dev" })).status,
    ).toBe(200);
  });

  it("caps domains per plan and rate-limits creation", async () => {
    const t = await cloudTeam("cloud-d");
    const app = makeApp({ ...fakeSes(), isCloud: true });
    const create = (i: number) =>
      call(app, t.key, "POST", "/domains", { name: `d${i}.example.com` });
    const freeLimit = PLAN_DOMAIN_LIMIT.free ?? 0;
    for (let i = 0; i < freeLimit; i++) expect((await create(i)).status).toBe(200);
    const capped = await create(freeLimit);
    expect(capped.status).toBe(403);
    expect(await capped.json()).toMatchObject({ name: "plan_limit_reached" });

    await db.update(schema.teams).set({ plan: "pro" }).where(eq(schema.teams.id, t.id));
    for (let i = freeLimit; i < DOMAIN_CREATE_LIMIT_PER_HOUR; i++) {
      expect((await create(i)).status).toBe(200);
    }
    const limited = await create(DOMAIN_CREATE_LIMIT_PER_HOUR);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ name: "rate_limit_exceeded" });
    // Each successful create runs a real RSA keygen; 11 of them overrun the
    // default 5s on loaded CI runners.
  }, 30_000);
});

describe("GET /domains", () => {
  it("lists only the caller team's domains in the list envelope", async () => {
    const app = makeApp(fakeSes());
    await createDomain(app, "list-a.example.com");
    const foreign = await call(app, otherTeamKey, "POST", "/domains", {
      name: "foreign.example.com",
    });
    expect(foreign.status).toBe(200);

    const res = await call(app, fullKey, "GET", "/domains");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      object: string;
      has_more: boolean;
      data: { name: string }[];
    };
    expect(body.object).toBe("list");
    expect(body.has_more).toBe(false);
    expect(body.data.some((d) => d.name === "list-a.example.com")).toBe(true);
    expect(body.data.some((d) => d.name === "foreign.example.com")).toBe(false);
  });
});

type WireRecord = {
  record: string;
  name: string;
  status: string;
  live?: string;
  detail?: string;
  inherited_from?: string;
  policy?: string;
};

/** A resolver publishing exactly the SES checklist for `domain`, plus any extra TXT answers. */
function dnsFor(domain: string, dkimPublicKey: string, txt: Record<string, string[]> = {}) {
  return fakeDns({
    resolveTxt: async (name: string) => {
      if (name in txt) return [txt[name] ?? []];
      if (name === `millionsend._domainkey.${domain}`)
        return [[`v=DKIM1; k=rsa; p=${dkimPublicKey}`]];
      if (name === `send.${domain}`) return [["v=spf1 include:amazonses.com ~all"]];
      return [];
    },
    resolveMx: async (name: string) =>
      name === `send.${domain}`
        ? [{ priority: 10, exchange: "feedback-smtp.sa-east-1.amazonses.com" }]
        : [],
  });
}

async function dkimKeyOf(id: string): Promise<string> {
  const [row] = await db.select().from(schema.domains).where(eq(schema.domains.id, id));
  return row?.dkimPublicKey ?? "";
}

describe("GET /domains/{id}", () => {
  async function getRecords(app: ReturnType<typeof createApi>, id: string) {
    const res = await call(app, fullKey, "GET", `/domains/${id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { object: string; status: string; records: WireRecord[] };
    expect(body.object).toBe("domain");
    return body;
  }

  it("combines SES with live DNS per record, the way the dashboard badge does", async () => {
    const { id } = await createDomain(makeApp(fakeSes()), "get.example.com");
    const app = makeApp({
      client: fakeSes({ dkimStatus: "SUCCESS", verifiedForSending: true }).client,
      dns: dnsFor("get.example.com", await dkimKeyOf(id)),
    });
    const { records, status } = await getRecords(app, id);
    // A read reports, never persists: the stored status stays pending.
    expect(status).toBe("pending");
    expect(records.find((r) => r.record === "DKIM")).toMatchObject({
      status: "verified",
      live: "found",
    });
    expect(records.filter((r) => r.record === "SPF").every((r) => r.status === "verified")).toBe(
      true,
    );
    expect(records.find((r) => r.record === "SPF")).not.toHaveProperty("detail");
    // No DMARC anywhere: recommended, so not_started rather than failed.
    expect(records.find((r) => r.record === "DMARC")).toEqual({
      record: "DMARC",
      name: "_dmarc.get.example.com",
      type: "TXT",
      ttl: "Auto",
      status: "not_started",
      value: '"v=DMARC1; p=none;"',
      live: "missing",
      detail:
        "No DMARC policy at this name or at _dmarc.example.com; recommended, not required for sending.",
    });
  });

  it("reads DMARC published only at the organizational domain as verified, naming the inherited record", async () => {
    const { id } = await createDomain(makeApp(fakeSes()), "sub.example.com");
    const app = makeApp({
      client: fakeSes({ dkimStatus: "SUCCESS", verifiedForSending: true }).client,
      dns: dnsFor("sub.example.com", await dkimKeyOf(id), {
        "_dmarc.example.com": ["v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com"],
      }),
    });
    const { records } = await getRecords(app, id);
    expect(records.find((r) => r.record === "DMARC")).toMatchObject({
      status: "verified",
      live: "found",
      inherited_from: "_dmarc.example.com",
      policy: "quarantine",
      detail:
        "No record at this name; receivers apply _dmarc.example.com (p=quarantine), which covers this subdomain.",
    });
  });

  it("an apex sender missing DMARC is told about its own name only", async () => {
    const { id } = await createDomain(makeApp(fakeSes()), "apex-example.com");
    const app = makeApp({
      client: fakeSes().client,
      dns: dnsFor("apex-example.com", await dkimKeyOf(id)),
    });
    const { records } = await getRecords(app, id);
    expect(records.find((r) => r.record === "DMARC")).toMatchObject({
      status: "not_started",
      live: "missing",
      detail: "No DMARC policy at this name; recommended, not required for sending.",
    });
  });

  it("a DKIM record found in DNS while SES is still pending reads pending and says so", async () => {
    const { id } = await createDomain(makeApp(fakeSes()), "waiting.example.com");
    const app = makeApp({
      client: fakeSes().client,
      dns: dnsFor("waiting.example.com", await dkimKeyOf(id)),
    });
    const { records } = await getRecords(app, id);
    expect(records.find((r) => r.record === "DKIM")).toMatchObject({
      status: "pending",
      live: "found",
      detail:
        "Record found in DNS; the provider has not confirmed it yet (usually minutes, up to 72 hours).",
    });
  });

  it("a wrong published value reads failed and carries what DNS answered", async () => {
    const { id } = await createDomain(makeApp(fakeSes()), "wrong.example.com");
    const app = makeApp({
      client: fakeSes({ dkimStatus: "SUCCESS", verifiedForSending: true }).client,
      dns: dnsFor("wrong.example.com", await dkimKeyOf(id), {
        "millionsend._domainkey.wrong.example.com": ["v=DKIM1; k=rsa; p=STALEKEY"],
      }),
    });
    const { records } = await getRecords(app, id);
    expect(records.find((r) => r.record === "DKIM")).toMatchObject({
      status: "failed",
      live: "mismatch",
      detail: "A different value is published: v=DKIM1; k=rsa; p=STALEKEY",
    });
    // A record nobody published: not_started, no live-found note.
    const missing = await getRecords(makeApp(fakeSes({ dkimStatus: "SUCCESS" })), id);
    expect(missing.records.find((r) => r.record === "DKIM")).toMatchObject({
      status: "not_started",
      live: "missing",
      detail: "No record at this name.",
    });
  });

  it("404s a foreign team's domain", async () => {
    const app = makeApp(fakeSes());
    const { id } = await createDomain(app, "isolated.example.com");
    const res = await call(app, otherTeamKey, "GET", `/domains/${id}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ statusCode: 404, name: "not_found" });
  });
});

describe("POST /domains/{id}/verify", () => {
  it("flips the stored status to verified when SES and live DNS both pass", async () => {
    const bootstrap = makeApp(fakeSes());
    const { id } = await createDomain(bootstrap, "verify.example.com");
    const [row] = await db.select().from(schema.domains).where(eq(schema.domains.id, id));
    const dkimPublicKey = row?.dkimPublicKey ?? "";

    const app = makeApp({
      client: fakeSes({ dkimStatus: "SUCCESS", verifiedForSending: true }).client,
      dns: fakeDns({
        resolveTxt: async (name: string) => {
          if (name === "millionsend._domainkey.verify.example.com") {
            return [[`v=DKIM1; k=rsa; p=${dkimPublicKey}`]];
          }
          if (name === "send.verify.example.com") return [["v=spf1 include:amazonses.com ~all"]];
          return [];
        },
        resolveMx: async (name: string) =>
          name === "send.verify.example.com"
            ? [{ priority: 10, exchange: "feedback-smtp.sa-east-1.amazonses.com" }]
            : [],
      }),
    });
    const res = await call(app, fullKey, "POST", `/domains/${id}/verify`);
    expect(res.status).toBe(200);
    // Full object with the freshly computed status — no get_domain round-trip.
    const verifyBody = (await res.json()) as Record<string, unknown>;
    expect(verifyBody).toMatchObject({ object: "domain", id, status: "verified" });
    expect(Array.isArray(verifyBody.records)).toBe(true);

    const [after] = await db.select().from(schema.domains).where(eq(schema.domains.id, id));
    expect(after?.status).toBe("verified");
    expect(after?.verifiedAt).toBeInstanceOf(Date);
    expect(after?.lastCheckedAt).toBeInstanceOf(Date);
  });

  it("clears the tracking subdomain's 72h clock once its CNAME resolves", async () => {
    const app = makeApp({
      ...fakeSes(),
      appBaseUrl: "https://app.example.dev",
      dns: fakeDns({
        resolveCname: async (name: string) =>
          name === "links.cname.example.com" ? ["app.example.dev"] : [],
      }),
    });
    const { id } = await createDomain(app, "cname.example.com");
    await call(app, fullKey, "PATCH", `/domains/${id}`, { tracking_subdomain: "links" });
    let [row] = await db.select().from(schema.domains).where(eq(schema.domains.id, id));
    expect(row?.trackingSubdomainSetAt).toBeInstanceOf(Date);

    const res = await call(app, fullKey, "POST", `/domains/${id}/verify`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { records: unknown[] }).records).toContainEqual(
      expect.objectContaining({
        record: "Tracking",
        name: "links.cname.example.com",
        status: "verified",
      }),
    );
    [row] = await db.select().from(schema.domains).where(eq(schema.domains.id, id));
    expect(row?.trackingSubdomainSetAt).toBeNull();
  });

  it("a plain GET that sees the CNAME resolve clears the clock too, so the row never reads verified while sends ship untracked", async () => {
    const app = makeApp({
      ...fakeSes(),
      appBaseUrl: "https://app.example.dev",
      dns: fakeDns({
        resolveCname: async (name: string) =>
          name === "links.readonly.example.com" ? ["app.example.dev"] : [],
      }),
    });
    const { id } = await createDomain(app, "readonly.example.com");
    await call(app, fullKey, "PATCH", `/domains/${id}`, { tracking_subdomain: "links" });
    const res = await call(app, fullKey, "GET", `/domains/${id}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { records: unknown[] }).records).toContainEqual(
      expect.objectContaining({ record: "Tracking", status: "verified" }),
    );
    const [row] = await db.select().from(schema.domains).where(eq(schema.domains.id, id));
    expect(row?.trackingSubdomainSetAt).toBeNull();
  });

  it("leaves the clock armed and the Tracking row pending while the CNAME does not resolve", async () => {
    const app = makeApp({
      ...fakeSes(),
      appBaseUrl: "https://app.example.dev",
      dns: fakeDns({ resolveCname: async () => ["elsewhere.example.net"] }),
    });
    const { id } = await createDomain(app, "unresolved.example.com");
    await call(app, fullKey, "PATCH", `/domains/${id}`, { tracking_subdomain: "links" });

    const res = await call(app, fullKey, "POST", `/domains/${id}/verify`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { records: unknown[] }).records).toContainEqual(
      expect.objectContaining({ record: "Tracking", status: "pending" }),
    );
    const [row] = await db.select().from(schema.domains).where(eq(schema.domains.id, id));
    expect(row?.trackingSubdomainSetAt).toBeInstanceOf(Date);
  });

  it("stays pending when a required record is live-missing despite SES success", async () => {
    const app = makeApp(fakeSes({ dkimStatus: "SUCCESS", verifiedForSending: true }));
    const { id } = await createDomain(app, "half.example.com");
    const res = await call(app, fullKey, "POST", `/domains/${id}/verify`);
    expect(res.status).toBe(200);
    const [after] = await db.select().from(schema.domains).where(eq(schema.domains.id, id));
    expect(after?.status).toBe("pending");
    expect(after?.verifiedAt).toBeNull();
  });
});

describe("PATCH /domains/{id}", () => {
  it("persists the tracking toggles and the branded subdomain", async () => {
    const app = makeApp({ ...fakeSes(), appBaseUrl: "https://app.example.dev" });
    const { id } = await createDomain(app, "patch.example.com");

    const res = await call(app, fullKey, "PATCH", `/domains/${id}`, {
      open_tracking: true,
      click_tracking: false,
      tracking_subdomain: "email",
    });
    expect(res.status).toBe(200);
    // Full object echoing the settings just changed.
    expect(await res.json()).toMatchObject({
      object: "domain",
      id,
      open_tracking: true,
      click_tracking: false,
      tracking_subdomain: "email",
    });

    const [row] = await db.select().from(schema.domains).where(eq(schema.domains.id, id));
    expect(row).toMatchObject({
      openTracking: true,
      clickTracking: false,
      trackingSubdomain: "email",
    });

    // The branded tracking CNAME now appears in the record list, pointed at
    // the app host.
    const get = await call(app, fullKey, "GET", `/domains/${id}`);
    const body = (await get.json()) as {
      records: { record: string; name: string; value: string }[];
    };
    expect(body.records).toContainEqual(
      expect.objectContaining({
        record: "Tracking",
        name: "email.patch.example.com",
        value: "app.example.dev",
      }),
    );

    // Empty string clears the subdomain.
    await call(app, fullKey, "PATCH", `/domains/${id}`, { tracking_subdomain: "" });
    const [cleared] = await db.select().from(schema.domains).where(eq(schema.domains.id, id));
    expect(cleared?.trackingSubdomain).toBeNull();
  });

  it("cloud: refuses to leave tracking on without a tracking subdomain", async () => {
    // A fresh team: the shared one already sits at its cloud plan cap.
    const t = { key: await insertKey(await createTeam(db, "cloud-tracking")) };
    const app = makeApp({ ...fakeSes(), isCloud: true, appBaseUrl: "https://app.example.dev" });
    const created = await call(app, t.key, "POST", "/domains", { name: "gated.example.com" });
    expect(created.status).toBe(200);
    const { id } = (await created.json()) as { id: string };

    const refused = await call(app, t.key, "PATCH", `/domains/${id}`, { click_tracking: true });
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { message: string }).message).toContain("tracking_subdomain");
    let [row] = await db.select().from(schema.domains).where(eq(schema.domains.id, id));
    expect(row?.clickTracking).toBe(false);

    // A subdomain in the same request is accepted, and the CNAME to add comes
    // back pending until it resolves.
    const ok = await call(app, t.key, "PATCH", `/domains/${id}`, {
      click_tracking: true,
      tracking_subdomain: "links",
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { records: unknown[] }).records).toContainEqual(
      expect.objectContaining({
        record: "Tracking",
        name: "links.gated.example.com",
        status: "pending",
      }),
    );

    // Removing the subdomain while tracking stays on is the same unserved state.
    const clearing = await call(app, t.key, "PATCH", `/domains/${id}`, { tracking_subdomain: "" });
    expect(clearing.status).toBe(422);
    [row] = await db.select().from(schema.domains).where(eq(schema.domains.id, id));
    expect(row?.trackingSubdomain).toBe("links");

    // Turning tracking off is always allowed, subdomain or not.
    const off = await call(app, t.key, "PATCH", `/domains/${id}`, {
      click_tracking: false,
      tracking_subdomain: "",
    });
    expect(off.status).toBe(200);
    [row] = await db.select().from(schema.domains).where(eq(schema.domains.id, id));
    expect(row).toMatchObject({ clickTracking: false, trackingSubdomain: null });
  });

  it("cloud without subdomain support: says tracking cannot be turned on at all", async () => {
    const t = { key: await insertKey(await createTeam(db, "cloud-nosub")) };
    const app = makeApp({
      ...fakeSes(),
      isCloud: true,
      appBaseUrl: "https://app.example.dev",
      trackingSubdomains: false,
    });
    const created = await call(app, t.key, "POST", "/domains", { name: "nosub.example.com" });
    expect(created.status).toBe(200);
    const { id } = (await created.json()) as { id: string };
    const res = await call(app, t.key, "PATCH", `/domains/${id}`, { open_tracking: true });
    expect(res.status).toBe(422);
    const { message } = (await res.json()) as { message: string };
    expect(message).toContain("cannot be turned on");
    expect(message).not.toContain("Pass tracking_subdomain");
  });

  it("self-host: tracking may turn on without a subdomain (the app host serves it)", async () => {
    const app = makeApp({ ...fakeSes(), appBaseUrl: "https://app.example.dev" });
    const { id } = await createDomain(app, "shared.example.com");
    const res = await call(app, fullKey, "PATCH", `/domains/${id}`, { click_tracking: true });
    expect(res.status).toBe(200);
  });

  it("422s adopting a tracking subdomain where the deployment cannot serve one", async () => {
    const gated = makeApp({
      ...fakeSes(),
      appBaseUrl: "https://app.example.dev",
      trackingSubdomains: false,
    });
    const { id } = await createDomain(gated, "gated.example.com");

    const adopt = await call(gated, fullKey, "PATCH", `/domains/${id}`, {
      tracking_subdomain: "email",
    });
    expect(adopt.status).toBe(422);
    expect(await adopt.json()).toMatchObject({
      statusCode: 422,
      name: "validation_error",
      message: expect.stringContaining("not available"),
    });
    const [row] = await db.select().from(schema.domains).where(eq(schema.domains.id, id));
    expect(row?.trackingSubdomain).toBeNull();
  });

  // Turning the flag off must not strand a subdomain adopted while it was on.
  it("still clears a stored tracking subdomain once the deployment stops serving them", async () => {
    const open = makeApp({ ...fakeSes(), appBaseUrl: "https://app.example.dev" });
    const { id } = await createDomain(open, "stranded.example.com");
    await call(open, fullKey, "PATCH", `/domains/${id}`, { tracking_subdomain: "email" });

    const gated = makeApp({
      ...fakeSes(),
      appBaseUrl: "https://app.example.dev",
      trackingSubdomains: false,
    });
    const cleared = await call(gated, fullKey, "PATCH", `/domains/${id}`, {
      tracking_subdomain: "",
    });
    expect(cleared.status).toBe(200);
    const [row] = await db.select().from(schema.domains).where(eq(schema.domains.id, id));
    expect(row?.trackingSubdomain).toBeNull();
  });

  it("422s a tracking subdomain equal to the return-path (MAIL FROM) subdomain", async () => {
    const app = makeApp({ ...fakeSes(), appBaseUrl: "https://app.example.dev" });
    // custom_return_path defaults to "send".
    const { id } = await createDomain(app, "clash.example.com");

    const res = await call(app, fullKey, "PATCH", `/domains/${id}`, { tracking_subdomain: "send" });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ statusCode: 422, name: "validation_error" });
    const [row] = await db.select().from(schema.domains).where(eq(schema.domains.id, id));
    expect(row?.trackingSubdomain).toBeNull();
  });

  it("omits the tracking CNAME from the checklist where subdomains are not served", async () => {
    const open = makeApp({ ...fakeSes(), appBaseUrl: "https://app.example.dev" });
    const { id } = await createDomain(open, "hidden.example.com");
    await call(open, fullKey, "PATCH", `/domains/${id}`, { tracking_subdomain: "email" });

    const gated = makeApp({
      ...fakeSes(),
      appBaseUrl: "https://app.example.dev",
      trackingSubdomains: false,
    });
    const res = await call(gated, fullKey, "GET", `/domains/${id}`);
    const body = (await res.json()) as { records: { record: string }[] };
    expect(body.records.some((r) => r.record === "Tracking")).toBe(false);
  });

  it("422s enabling tracking when APP_BASE_URL is loopback or unset", async () => {
    const loopback = makeApp({ ...fakeSes(), appBaseUrl: "http://localhost:3000" });
    const { id } = await createDomain(loopback, "loop.example.com");

    const enable = await call(loopback, fullKey, "PATCH", `/domains/${id}`, {
      open_tracking: true,
    });
    expect(enable.status).toBe(422);
    expect(await enable.json()).toMatchObject({
      statusCode: 422,
      name: "validation_error",
      message: expect.stringContaining("loopback"),
    });

    const unset = makeApp({ ...fakeSes(), appBaseUrl: undefined });
    const subdomain = await call(unset, fullKey, "PATCH", `/domains/${id}`, {
      tracking_subdomain: "email",
    });
    expect(subdomain.status).toBe(422);
    expect(await subdomain.json()).toMatchObject({
      message: expect.stringContaining("APP_BASE_URL"),
    });

    // Disabling is always possible — it needs no reachable host.
    const disable = await call(loopback, fullKey, "PATCH", `/domains/${id}`, {
      open_tracking: false,
      click_tracking: false,
    });
    expect(disable.status).toBe(200);
  });

  it("422s tls, disabling sending, and receiving on an instance that receives no mail", async () => {
    const app = makeApp({ ...fakeSes(), appBaseUrl: "https://app.example.dev" });
    const { id } = await createDomain(app, "tls.example.com");

    const tls = await call(app, fullKey, "PATCH", `/domains/${id}`, { tls: "enforced" });
    expect(tls.status).toBe(422);
    expect(await tls.json()).toMatchObject({ message: expect.stringContaining("tls") });

    const sendingOff = await call(app, fullKey, "PATCH", `/domains/${id}`, {
      capabilities: { sending: "disabled" },
    });
    expect(sendingOff.status).toBe(422);
    expect(await sendingOff.json()).toMatchObject({
      message: expect.stringContaining("receive-only domains are not supported"),
    });

    const receivingOn = await call(app, fullKey, "PATCH", `/domains/${id}`, {
      capabilities: { receiving: "enabled" },
    });
    expect(receivingOn.status).toBe(422);
    expect(await receivingOn.json()).toMatchObject({
      message: expect.stringContaining("RECEIVING_MX_HOST"),
    });

    // What is already true is not an error.
    const unchanged = await call(app, fullKey, "PATCH", `/domains/${id}`, {
      capabilities: { sending: "enabled", receiving: "disabled" },
    });
    expect(unchanged.status).toBe(200);
    expect(await unchanged.json()).toMatchObject({
      capabilities: { sending: "enabled", receiving: "disabled" },
    });
  });
});

describe("DELETE /domains/{id}", () => {
  it("deletes the SES identity, revokes scoped keys, and removes the row", async () => {
    const { client, calls } = fakeSes();
    const app = makeApp({ client });
    const { id } = await createDomain(app, "delete.example.com");
    await db.update(schema.domains).set({ status: "verified" }).where(eq(schema.domains.id, id));
    const scopedToken = await insertKey(teamId, { domainId: id });

    const res = await call(app, fullKey, "DELETE", `/domains/${id}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ object: "domain", id, deleted: true });

    expect(calls.at(-1)).toMatchObject({
      name: "DeleteEmailIdentityCommand",
      input: { EmailIdentity: "delete.example.com" },
    });
    expect(await db.select().from(schema.domains).where(eq(schema.domains.id, id))).toHaveLength(0);
    const [key] = await db
      .select()
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.keyHash, hashApiKey(scopedToken)));
    expect(key?.revokedAt).not.toBeNull();
    expect(key?.domainId).toBeNull();
  });

  it("fails the domain's queued emails in the delete and keeps an identity other rows share", async () => {
    const { client, calls } = fakeSes();
    const app = makeApp({ client });
    const { id } = await createDomain(app, "cascade.example.com");
    const base = {
      teamId,
      domainId: id,
      from: "a@cascade.example.com",
      to: ["r@x.com"],
      subject: "s",
    };
    const [queued, sent] = await db
      .insert(schema.emails)
      .values([
        { ...base, latestStatus: "queued", scheduledAt: new Date(Date.now() + 60_000) },
        { ...base, latestStatus: "delivered", sentAt: new Date() },
      ])
      .returning({ id: schema.emails.id });
    // Self-host: another team registered the same identity in the same region.
    await db
      .insert(schema.domains)
      .values({ teamId: otherTeamId, name: "cascade.example.com", region: "sa-east-1" });

    const res = await call(app, fullKey, "DELETE", `/domains/${id}`);
    expect(res.status).toBe(200);
    expect(calls.some((c) => c.name === "DeleteEmailIdentityCommand")).toBe(false);
    expect(await db.select().from(schema.domains).where(eq(schema.domains.id, id))).toHaveLength(0);

    const status = async (emailId: string | undefined) =>
      (
        await db
          .select({ s: schema.emails.latestStatus })
          .from(schema.emails)
          .where(eq(schema.emails.id, emailId ?? ""))
      )[0]?.s;
    expect(await status(queued?.id)).toBe("failed");
    expect(await status(sent?.id)).toBe("delivered");
    const events = await db
      .select({ type: schema.emailEvents.type })
      .from(schema.emailEvents)
      .where(eq(schema.emailEvents.emailId, queued?.id ?? ""));
    expect(events).toEqual([{ type: "failed" }]);
  });

  it("fires email.failed for the emails the delete fails, handed to the queue after it commits", async () => {
    const endpointId = await createWebhookEndpoint(db, teamId, ["email.failed"]);
    const domainLeft: boolean[] = [];
    const enqueued: string[] = [];
    const app = makeApp({
      client: fakeSes().client,
      enqueueWebhookDeliveries: async (rows) => {
        enqueued.push(...rows.map((r) => r.id));
        const rowsLeft = await db
          .select({ id: schema.domains.id })
          .from(schema.domains)
          .where(eq(schema.domains.name, "hooks.example.com"));
        domainLeft.push(rowsLeft.length > 0);
      },
    });
    const { id } = await createDomain(app, "hooks.example.com");
    const [queued] = await db
      .insert(schema.emails)
      .values({ teamId, domainId: id, from: "a@hooks.example.com", to: ["r@x.com"], subject: "s" })
      .returning({ id: schema.emails.id });

    expect((await call(app, fullKey, "DELETE", `/domains/${id}`)).status).toBe(200);

    const deliveries = await db
      .select()
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.endpointId, endpointId));
    expect(deliveries.map((d) => d.emailId)).toEqual([queued?.id]);
    expect(deliveries[0]?.payload).toMatchObject({
      type: "email.failed",
      data: { email_id: queued?.id, failed: { reason: "domain_deleted" } },
    });
    expect(enqueued).toEqual([deliveries[0]?.id]);
    expect(domainLeft).toEqual([false]);
  });

  it("tolerates an identity already gone from SES", async () => {
    const app = makeApp(
      fakeSes({
        deleteError: Object.assign(new Error("gone"), { name: "NotFoundException" }),
      }),
    );
    const { id } = await createDomain(app, "gone.example.com");
    const res = await call(app, fullKey, "DELETE", `/domains/${id}`);
    expect(res.status).toBe(200);
    expect(await db.select().from(schema.domains).where(eq(schema.domains.id, id))).toHaveLength(0);
  });

  it.each(SUSPENSION_REASONS)(
    "403s a team suspended for %s before SES is touched; the key still authenticates",
    async (reason) => {
      const { client, calls } = fakeSes();
      const app = makeApp({ client });
      const { id } = await createDomain(app, `held-${reason.replace("_", "-")}.example.com`);
      const suspend = (on: boolean) =>
        db
          .update(schema.teams)
          .set(
            on
              ? { suspendedAt: new Date(), suspensionReason: reason }
              : { suspendedAt: null, suspensionReason: null },
          )
          .where(eq(schema.teams.id, teamId));
      await suspend(true);
      const before = calls.length;
      try {
        const res = await call(app, fullKey, "DELETE", `/domains/${id}`);
        expect(res.status).toBe(403);
        const body = await res.json();
        if (["phishing", "review"].includes(reason)) {
          // Neither the error's name nor its message tells the team it is suspended.
          expect(body).toEqual({
            statusCode: 403,
            name: "forbidden",
            message:
              "This isn't available for this team right now. Contact support if you need help.",
          });
        } else {
          expect(body).toMatchObject({ statusCode: 403, name: "team_suspended" });
        }
        expect(calls.length).toBe(before);
        expect(
          await db.select().from(schema.domains).where(eq(schema.domains.id, id)),
        ).toHaveLength(1);
      } finally {
        await suspend(false);
      }
      expect((await call(app, fullKey, "DELETE", `/domains/${id}`)).status).toBe(200);
    },
  );

  it("404s a foreign team's domain without touching SES", async () => {
    const { client, calls } = fakeSes();
    const app = makeApp({ client });
    const { id } = await createDomain(app, "keep.example.com");
    const before = calls.length;
    const res = await call(app, otherTeamKey, "DELETE", `/domains/${id}`);
    expect(res.status).toBe(404);
    expect(calls.length).toBe(before);
    expect(await db.select().from(schema.domains).where(eq(schema.domains.id, id))).toHaveLength(1);
  });
});

describe("capabilities.receiving", () => {
  const receiving = { mxHost: "mx.millionsend.test", ingestSecret: "s".repeat(32) };
  const verify = (id: string) =>
    db.update(schema.domains).set({ status: "verified" }).where(eq(schema.domains.id, id));
  const receivingRecord = (body: { records: { record: string }[] }) =>
    body.records.find((r) => r.record === "Receiving");

  it("is refused on create, before SES is touched: a new domain is not verified yet", async () => {
    const { client, calls } = fakeSes();
    const app = makeApp({ client, receiving });
    const res = await call(app, fullKey, "POST", "/domains", {
      name: "inbound-create.example.com",
      capabilities: { receiving: "enabled" },
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ message: expect.stringContaining("verified") });
    expect(calls).toEqual([]);
  });

  it("switches on for a verified domain and adds the Receiving MX, checked live", async () => {
    const name = "inbound.example.com";
    let mx: { priority: number; exchange: string }[] = [];
    const app = makeApp({
      ...fakeSes(),
      receiving,
      dns: fakeDns({ resolveMx: async (host) => (host === name ? mx : []) }),
    });
    const { id } = await createDomain(app, name);

    const unverified = await call(app, fullKey, "PATCH", `/domains/${id}`, {
      capabilities: { receiving: "enabled" },
    });
    expect(unverified.status).toBe(422);
    expect(await unverified.json()).toMatchObject({
      message: expect.stringContaining("only on a verified domain"),
    });

    await verify(id);
    const enabled = await call(app, fullKey, "PATCH", `/domains/${id}`, {
      capabilities: { receiving: "enabled" },
    });
    expect(enabled.status).toBe(200);
    const body = (await enabled.json()) as { capabilities: unknown; records: { record: string }[] };
    expect(body.capabilities).toEqual({ sending: "enabled", receiving: "enabled" });
    expect(receivingRecord(body)).toEqual({
      record: "Receiving",
      name,
      type: "MX",
      ttl: "Auto",
      status: "not_started",
      value: "mx.millionsend.test",
      priority: 10,
      live: "missing",
      detail: "No MX record at this name.",
    });

    // Another MX ahead of ours means mail never reaches it.
    mx = [
      { priority: 5, exchange: "aspmx.l.google.com" },
      { priority: 10, exchange: "mx.millionsend.test" },
    ];
    const shadowed = (await (await call(app, fullKey, "GET", `/domains/${id}`)).json()) as {
      records: { record: string }[];
    };
    expect(receivingRecord(shadowed)).toMatchObject({
      status: "failed",
      live: "mismatch",
      detail: expect.stringContaining("5 aspmx.l.google.com, 10 mx.millionsend.test"),
    });

    mx = [{ priority: 10, exchange: "MX.millionsend.test." }];
    const live = (await (await call(app, fullKey, "POST", `/domains/${id}/verify`)).json()) as {
      records: { record: string }[];
    };
    expect(receivingRecord(live)).toMatchObject({ status: "verified", live: "found" });

    const list = (await (await call(app, fullKey, "GET", "/domains?limit=100")).json()) as {
      data: { id: string; capabilities: unknown }[];
    };
    expect(list.data.find((d) => d.id === id)?.capabilities).toEqual({
      sending: "enabled",
      receiving: "enabled",
    });

    const disabled = await call(app, fullKey, "PATCH", `/domains/${id}`, {
      capabilities: { receiving: "disabled" },
    });
    const off = (await disabled.json()) as { capabilities: unknown; records: { record: string }[] };
    expect(off.capabilities).toEqual({ sending: "enabled", receiving: "disabled" });
    expect(receivingRecord(off)).toBeUndefined();
    const [row] = await db
      .select({ on: schema.domains.receivingEnabled, at: schema.domains.receivingEnabledAt })
      .from(schema.domains)
      .where(eq(schema.domains.id, id));
    expect(row).toEqual({ on: false, at: null });

    // A repeat of the current state changes nothing, so it audits nothing.
    await call(app, fullKey, "PATCH", `/domains/${id}`, {
      capabilities: { receiving: "disabled" },
    });
    const audit = await db
      .select({ action: schema.auditLog.action, data: schema.auditLog.data })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.target, `domain:${id}`))
      .orderBy(schema.auditLog.createdAt);
    expect(audit.filter((a) => a.action.startsWith("domain.receiving_"))).toEqual([
      { action: "domain.receiving_enabled", data: { name } },
      { action: "domain.receiving_disabled", data: { name } },
    ]);
  });

  it("409s a name another team already receives, and a refusal applies nothing else", async () => {
    const name = "shared-inbound.example.com";
    const app = makeApp({ ...fakeSes(), receiving, appBaseUrl: "https://app.example.dev" });
    await db.insert(schema.domains).values({
      teamId: otherTeamId,
      name,
      region: "sa-east-1",
      status: "verified",
      receivingEnabled: true,
    });
    const { id } = await createDomain(app, name);
    await verify(id);
    const res = await call(app, fullKey, "PATCH", `/domains/${id}`, {
      open_tracking: true,
      capabilities: { receiving: "enabled" },
    });
    expect(res.status).toBe(409);
    const [row] = await db.select().from(schema.domains).where(eq(schema.domains.id, id));
    expect(row).toMatchObject({ receivingEnabled: false, openTracking: false });
  });

  it("reads disabled, with no Receiving record, on an instance that stopped receiving", async () => {
    const name = "was-inbound.example.com";
    const app = makeApp({ ...fakeSes(), receiving });
    const { id } = await createDomain(app, name);
    await verify(id);
    await call(app, fullKey, "PATCH", `/domains/${id}`, { capabilities: { receiving: "enabled" } });

    const off = makeApp(fakeSes());
    const body = (await (await call(off, fullKey, "GET", `/domains/${id}`)).json()) as {
      capabilities: unknown;
      records: { record: string }[];
    };
    expect(body.capabilities).toEqual({ sending: "enabled", receiving: "disabled" });
    expect(receivingRecord(body)).toBeUndefined();
    // Turning it off is always allowed.
    const disable = await call(off, fullKey, "PATCH", `/domains/${id}`, {
      capabilities: { receiving: "disabled" },
    });
    expect(disable.status).toBe(200);
  });
});

describe("permission confinement", () => {
  it("403s a sending_access key on every /domains route", async () => {
    const app = makeApp(fakeSes());
    const { id } = await createDomain(app, "confined.example.com");
    for (const [method, path] of [
      ["GET", "/domains"],
      ["POST", "/domains"],
      ["GET", `/domains/${id}`],
      ["POST", `/domains/${id}/verify`],
      ["PATCH", `/domains/${id}`],
      ["DELETE", `/domains/${id}`],
    ] as const) {
      const res = await call(app, sendKey, method, path, method === "GET" ? undefined : {});
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(await res.json()).toMatchObject({ name: "restricted_api_key" });
    }
  });

  it("omitting the ses dep leaves the /domains surface unregistered (404)", async () => {
    const bare = createApi({
      db,
      keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
      isCloud: false,
      enqueueEmailSend: async () => {},
    });
    const res = await call(bare, fullKey, "GET", "/domains");
    expect(res.status).toBe(404);
  });
});

describe("POST /domains and teams suspended for phishing", () => {
  it("records, without holding, a new team whose added domain is a return's", async () => {
    const phisher = await createTeam(db, "facture-vexto");
    await db
      .update(schema.teams)
      .set({ suspendedAt: new Date(), suspensionReason: "phishing" })
      .where(eq(schema.teams.id, phisher));
    await db.insert(schema.campaignFingerprints).values({
      teamId: phisher,
      teamName: "facture-vexto",
      kind: "sending_domain",
      value: "vexto-cadeaux.example",
    });
    forgetPhishingPrints(db);
    const team = await createTeam(db, "newcomer-api");
    const token = await insertKey(team);
    const res = await call(makeApp({ client: fakeSes().client }), token, "POST", "/domains", {
      name: "cadeaux-vexto.example",
    });
    expect(res.status).toBe(200);
    const [row] = await db
      .select({ reason: schema.teams.suspensionReason })
      .from(schema.teams)
      .where(eq(schema.teams.id, team));
    expect(row).toEqual({ reason: null });
    const links = await db
      .select({ held: schema.teamLinks.held, trigger: schema.teamLinks.trigger })
      .from(schema.teamLinks)
      .where(eq(schema.teamLinks.teamId, team));
    expect(links).toEqual([{ held: false, trigger: "domain" }]);
  });
});

describe("receiving_catch_all", () => {
  const receiving = { mxHost: "mx.millionsend.test", ingestSecret: "s".repeat(32) };
  const receivingDomain = async (app: ReturnType<typeof createApi>, name: string) => {
    const { id } = await createDomain(app, name);
    await db
      .update(schema.domains)
      .set({ status: "verified", receivingEnabled: true })
      .where(eq(schema.domains.id, id));
    return id;
  };
  const setPlan = (plan: "free" | "pro") =>
    db.update(schema.teams).set({ plan }).where(eq(schema.teams.id, teamId));

  it("needs a paid plan on the cloud to turn on, and receiving enabled (S30)", async () => {
    // Domains are added on a self-host app: the cloud's domain cap is not under test here.
    const local = makeApp({ ...fakeSes(), receiving });
    const app = makeApp({ ...fakeSes(), receiving, isCloud: true });
    const id = await receivingDomain(local, "catchall.example.com");
    await setPlan("free");
    const free = await call(app, fullKey, "PATCH", `/domains/${id}`, { receiving_catch_all: true });
    expect(free.status).toBe(403);
    expect(await free.json()).toMatchObject({
      name: "plan_limit_reached",
      message: "Catch-all receiving needs a paid plan",
    });
    await setPlan("pro");
    const on = await call(app, fullKey, "PATCH", `/domains/${id}`, { receiving_catch_all: true });
    expect(on.status).toBe(200);
    expect(await on.json()).toMatchObject({ receiving_catch_all: true });
    // A stored true outlives a downgrade.
    await setPlan("free");
    const again = await call(app, fullKey, "PATCH", `/domains/${id}`, {
      receiving_catch_all: true,
    });
    expect(again.status).toBe(200);
    const off = await call(app, fullKey, "PATCH", `/domains/${id}`, { receiving_catch_all: false });
    expect(await off.json()).toMatchObject({ receiving_catch_all: false });
    const audit = await db
      .select({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.target, `domain:${id}`));
    expect(audit.map((a) => a.action).filter((a) => a.startsWith("domain.catch_all"))).toEqual([
      "domain.catch_all_enabled",
      "domain.catch_all_disabled",
    ]);
    const sending = await createDomain(local, "sending-only.example.com");
    await setPlan("pro");
    const refused = await call(app, fullKey, "PATCH", `/domains/${sending.id}`, {
      receiving_catch_all: true,
    });
    expect(refused.status).toBe(422);
    await setPlan("free");
  });

  it("deletes the domain's inboxes with it, their scoped keys revoked first", async () => {
    deleteInboxes.mockImplementation(
      async (database: Db, _deps: unknown, p: { inboxIds: string[] }) => {
        for (const inboxId of p.inboxIds) {
          await database
            .update(schema.apiKeys)
            .set({ revokedAt: new Date(), inboxId: null })
            .where(eq(schema.apiKeys.inboxId, inboxId));
          await database.delete(schema.inboxes).where(eq(schema.inboxes.id, inboxId));
        }
        return p.inboxIds.length;
      },
    );
    const app = makeApp({ ...fakeSes(), receiving });
    const id = await receivingDomain(app, "inboxes-gone.example.com");
    const [inbox] = await db
      .insert(schema.inboxes)
      .values({
        teamId,
        kind: "agent",
        emailAddress: "bot@inboxes-gone.example.com",
        localPart: "bot",
        domainId: id,
        name: "Bot",
        safety: {
          accept_from: "verified",
          allowlist: [],
          owner_addresses: [],
          screening: true,
          extract_codes: true,
          send_policy: "reply_only",
          require_approval: false,
          private_codes: true,
          send_cap: 200,
          forward_to: [],
        },
      })
      .returning({ id: schema.inboxes.id });
    const key = generateApiKey();
    await db.insert(schema.apiKeys).values({
      teamId,
      name: "inbox",
      tokenPrefix: key.tokenPrefix,
      keyHash: key.keyHash,
      last4: key.last4,
      inboxId: inbox?.id ?? null,
    });
    const res = await call(app, fullKey, "DELETE", `/domains/${id}`);
    expect(res.status).toBe(200);
    expect(deleteInboxes).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ receivingEnabled: true }),
      expect.objectContaining({ teamId, inboxIds: [inbox?.id], reason: "domain_deleted" }),
    );
    const [revoked] = await db
      .select()
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.keyHash, key.keyHash));
    expect(revoked).toMatchObject({ inboxId: null });
    expect(revoked?.revokedAt).not.toBeNull();
  });
});

describe("the team's subdomain of the shared domain", () => {
  const SHARED = "agents.example.test";
  // Pinned created_at, so own domains list in a known order.
  const day = (n: number) => new Date(Date.UTC(2026, 0, n));
  type Team = Awaited<ReturnType<typeof sharedTeam>>;
  type WireRow = { id: string; shared: boolean } & Record<string, unknown>;

  /** A team with its subdomain label, a full-access key and `own` verified domains, oldest first. */
  async function sharedTeam(slug: string, own: number, plan: "free" | "pro" = "pro") {
    const id = await createTeam(db, slug, { sharedInboxDomain: SHARED });
    await db.update(schema.teams).set({ plan }).where(eq(schema.teams.id, id));
    const domains = [];
    for (let n = 1; n <= own; n++) {
      const [row] = await db
        .insert(schema.domains)
        .values({
          teamId: id,
          name: `d${n}.${slug}.example.com`,
          region: "sa-east-1",
          status: "verified",
          createdAt: day(n),
        })
        .returning({ id: schema.domains.id });
      domains.push(row?.id as string);
    }
    const [label] = await db
      .select()
      .from(schema.sharedInboxDomains)
      .where(eq(schema.sharedInboxDomains.teamId, id));
    return {
      id,
      key: await insertKey(id),
      own: domains,
      sharedId: label?.id as string,
      sharedName: label?.name as string,
    };
  }

  const sharedApp = (extra: { isCloud?: boolean } = {}) =>
    makeApp({ ...fakeSes(), ...extra, sharedInboxDomain: SHARED });
  async function list(app: ReturnType<typeof createApi>, team: Team, query = "") {
    const res = await call(app, team.key, "GET", `/domains${query}`);
    expect(res.status, query).toBe(200);
    return (await res.json()) as { data: WireRow[]; has_more: boolean };
  }
  const page = async (app: ReturnType<typeof createApi>, team: Team, query = "") => {
    const body = await list(app, team, query);
    return { ids: body.data.map((row) => row.id), more: body.has_more };
  };

  let t: Team;
  beforeAll(async () => {
    t = await sharedTeam("shared-rows", 3);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is the last row, read-only and verified, after the team's own rows with shared: false", async () => {
    const body = await list(sharedApp(), t);
    const [d1, d2, d3] = t.own;
    expect(body.data.map((row) => row.id)).toEqual([d3, d2, d1, t.sharedId]);
    expect(body.has_more).toBe(false);
    for (const row of body.data.slice(0, 3)) {
      expect(row.shared).toBe(false);
      expect(row).not.toHaveProperty("sending_mode");
    }
    expect(body.data[3]).toEqual({
      id: t.sharedId,
      name: "shared-rows.agents.example.test",
      status: "verified",
      created_at: expect.any(String),
      region: "sa-east-1",
      open_tracking: false,
      click_tracking: false,
      tracking_subdomain: null,
      capabilities: { sending: "enabled", receiving: "enabled" },
      receiving_catch_all: false,
      shared: true,
      sending_mode: "reply_only",
      sending_mode_reason: "instance",
    });
  });

  it("carries the team's sending mode, and reads sending disabled while the instance pauses it", async () => {
    const shared = async (app: ReturnType<typeof createApi>, team = t) =>
      (await list(app, team)).data.at(-1);
    vi.stubEnv("SHARED_INBOX_OPEN", "true");
    vi.stubEnv("ABUSE_JUDGE", "typesafe");
    expect(await shared(sharedApp())).toMatchObject({
      sending_mode: "open",
      sending_mode_reason: null,
      capabilities: { sending: "enabled", receiving: "enabled" },
    });
    const free = await sharedTeam("shared-mode-free", 0, "free");
    expect(await shared(sharedApp({ isCloud: true }), free)).toMatchObject({
      sending_mode: "reply_only",
      sending_mode_reason: "plan",
      capabilities: { sending: "enabled" },
    });
    vi.stubEnv("SHARED_INBOX_SEND", "false");
    expect(await shared(sharedApp())).toMatchObject({
      sending_mode: "receive_only",
      sending_mode_reason: "instance",
      capabilities: { sending: "disabled", receiving: "enabled" },
    });
  });

  describe("paging", () => {
    it("lists own domains first, newest first, then the shared row", async () => {
      const [d1, d2, d3] = t.own;
      const app = sharedApp();
      expect(await page(app, t, "?limit=2")).toEqual({ ids: [d3, d2], more: true });
      expect(await page(app, t, `?limit=2&after=${d2}`)).toEqual({
        ids: [d1, t.sharedId],
        more: false,
      });
    });

    it("answers has_more when own domains fill the page, and the next page holds only the shared row", async () => {
      const [d1, d2, d3] = t.own;
      const app = sharedApp();
      expect(await page(app, t, "?limit=3")).toEqual({ ids: [d3, d2, d1], more: true });
      expect(await page(app, t, `?limit=3&after=${d1}`)).toEqual({
        ids: [t.sharedId],
        more: false,
      });
    });

    it("answers an empty page after the shared id, in either case", async () => {
      for (const id of [t.sharedId, t.sharedId.toUpperCase()]) {
        expect(await page(sharedApp(), t, `?after=${id}`)).toEqual({ ids: [], more: false });
      }
    });

    it("gives the oldest own domains before the shared id, with has_more while newer ones remain", async () => {
      const [d1, d2, d3] = t.own;
      const app = sharedApp();
      expect(await page(app, t, `?limit=2&before=${t.sharedId}`)).toEqual({
        ids: [d2, d1],
        more: true,
      });
      expect(await page(app, t, `?before=${t.sharedId.toUpperCase()}`)).toEqual({
        ids: [d3, d2, d1],
        more: false,
      });
    });

    it("never includes the shared row before an own id", async () => {
      const [d1, d2, d3] = t.own;
      const app = sharedApp();
      expect(await page(app, t, `?before=${d1}`)).toEqual({ ids: [d3, d2], more: false });
      expect(await page(app, t, `?limit=1&before=${d3}`)).toEqual({ ids: [], more: false });
    });

    it("lets the catch-up (before= the first id of page 1) see a domain added later, also with no own domains", async () => {
      const app = sharedApp();
      for (const own of [2, 0]) {
        const team = await sharedTeam(`shared-catch-up-${own}`, own);
        const [first] = (await page(app, team)).ids;
        expect(first).toBe(own > 0 ? team.own.at(-1) : team.sharedId);
        const [added] = await db
          .insert(schema.domains)
          .values({
            teamId: team.id,
            name: `added.shared-catch-up-${own}.example.com`,
            region: "sa-east-1",
            createdAt: day(10),
          })
          .returning({ id: schema.domains.id });
        expect(await page(app, team, `?before=${first}`)).toEqual({
          ids: [added?.id],
          more: false,
        });
      }
    });
  });

  it("reads by id, in either case, with no records and no SES call", async () => {
    const { client, calls } = fakeSes();
    const app = makeApp({ client, sharedInboxDomain: SHARED });
    for (const id of [t.sharedId, t.sharedId.toUpperCase()]) {
      const res = await call(app, t.key, "GET", `/domains/${id}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        object: "domain",
        id: t.sharedId,
        name: t.sharedName,
        status: "verified",
        shared: true,
        sending_mode: "reply_only",
        records: [],
      });
    }
    expect(calls).toEqual([]);
  });

  it("refuses PATCH, verify and DELETE with 403, in either case, before any other check or SES call", async () => {
    const { client, calls } = fakeSes();
    const app = makeApp({ client, sharedInboxDomain: SHARED });
    for (const id of [t.sharedId, t.sharedId.toUpperCase()]) {
      for (const [method, path, body] of [
        // tls answers 422 on an own domain: the 403 comes first.
        ["PATCH", `/domains/${id}`, { tls: "enforced" }],
        ["PATCH", `/domains/${id}`, { open_tracking: true }],
        ["POST", `/domains/${id}/verify`],
        ["DELETE", `/domains/${id}`],
      ] as [string, string, unknown?][]) {
        const res = await call(app, t.key, method, path, body);
        expect(res.status, `${method} ${path}`).toBe(403);
        expect(await res.json()).toEqual({
          statusCode: 403,
          name: "forbidden",
          message: `${t.sharedName} is your team's subdomain of the shared domain: it can't be changed or deleted`,
        });
      }
    }
    expect(calls).toEqual([]);
    expect((await list(app, t)).data.at(-1)?.id).toBe(t.sharedId);
  });

  it("is no API key scope: POST /api-keys domain_id takes the team's own domains only", async () => {
    const res = await call(sharedApp(), t.key, "POST", "/api-keys", {
      name: "scoped",
      domain_id: t.sharedId,
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      statusCode: 422,
      name: "validation_error",
      message:
        "domain_id must be a verified domain of this team: a GET /domains row with shared: false",
    });
  });

  it("is left out without a shared inbox domain: every row has shared: false", async () => {
    const app = makeApp(fakeSes());
    const body = await list(app, t);
    expect(body.data.map((row) => row.id)).toEqual([...t.own].reverse());
    for (const row of body.data) {
      expect(row.shared).toBe(false);
      expect(row).not.toHaveProperty("sending_mode");
    }
    expect((await call(app, t.key, "GET", `/domains/${t.sharedId}`)).status).toBe(404);
  });

  it("leaves the plan's domain limit to own domains: a Free team with two may add a third", async () => {
    expect(PLAN_DOMAIN_LIMIT.free).toBe(3);
    const free = await sharedTeam("shared-limit", 2, "free");
    const res = await call(sharedApp({ isCloud: true }), free.key, "POST", "/domains", {
      name: "third.shared-limit.example.com",
    });
    expect(res.status).toBe(200);
  });

  it("documents shared and the sending mode fields, generated without a shared domain", async () => {
    const doc = (await (await makeApp(fakeSes()).request("/openapi.json")).json()) as {
      components: {
        schemas: Record<
          string,
          {
            properties: Record<string, unknown> & {
              data?: { items: { properties: Record<string, unknown> } };
            };
          }
        >;
      };
    };
    const { GetDomainResponse, ListDomainsResponse } = doc.components.schemas;
    for (const properties of [
      GetDomainResponse?.properties,
      ListDomainsResponse?.properties.data?.items.properties,
    ]) {
      expect(Object.keys(properties ?? {})).toEqual(
        expect.arrayContaining(["shared", "sending_mode", "sending_mode_reason"]),
      );
    }
  });
});
