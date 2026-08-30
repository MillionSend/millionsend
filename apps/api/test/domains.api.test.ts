import { randomBytes } from "node:crypto";
import { EnvKeyring, generateApiKey, hashApiKey } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import type { DkimVerificationStatus, DnsResolver, SesIdentityClient } from "@millionsend/ses";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ApiDeps, createApi } from "../src/app.js";

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
}) {
  const deps: ApiDeps = {
    db,
    keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
    isCloud: false,
    enqueueEmailSend: async () => {},
    appBaseUrl: opts.appBaseUrl,
    trackingSubdomains: opts.trackingSubdomains,
    ses: {
      clientForRegion: () => opts.client,
      dns: opts.dns ?? fakeDns(),
      defaultRegion: "sa-east-1",
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
    const body = await createDomain(app, "updates.example.com", { region: "eu-west-1" });

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
      region: "eu-west-1",
      status: "pending",
      dkimSelector: "millionsend",
    });

    expect(body).toMatchObject({
      name: "updates.example.com",
      status: "pending",
      region: "eu-west-1",
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
      value: "feedback-smtp.eu-west-1.amazonses.com",
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

  it("rejects an unsupported region and an uppercase name", async () => {
    const app = makeApp(fakeSes());
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

describe("GET /domains/{id}", () => {
  it("returns records with SES-derived statuses", async () => {
    const app = makeApp(fakeSes({ dkimStatus: "SUCCESS", verifiedForSending: true }));
    const { id } = await createDomain(app, "get.example.com");
    const res = await call(app, fullKey, "GET", `/domains/${id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      object: string;
      records: { record: string; status: string }[];
    };
    expect(body.object).toBe("domain");
    expect(body.records.find((r) => r.record === "DKIM")?.status).toBe("verified");
    expect(
      body.records.filter((r) => r.record === "SPF").every((r) => r.status === "verified"),
    ).toBe(true);
    // SES never checks DMARC.
    expect(body.records.find((r) => r.record === "DMARC")?.status).toBe("not_started");
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

  it("422s tls and capabilities as unsupported", async () => {
    const app = makeApp({ ...fakeSes(), appBaseUrl: "https://app.example.dev" });
    const { id } = await createDomain(app, "tls.example.com");

    const tls = await call(app, fullKey, "PATCH", `/domains/${id}`, { tls: "enforced" });
    expect(tls.status).toBe(422);
    expect(await tls.json()).toMatchObject({ message: expect.stringContaining("tls") });

    const capabilities = await call(app, fullKey, "PATCH", `/domains/${id}`, {
      capabilities: { sending: "enabled" },
    });
    expect(capabilities.status).toBe(422);
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
