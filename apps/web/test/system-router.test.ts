import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import type { SesAccountClient } from "@millionsend/ses";
import { createTestDb } from "@millionsend/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCaller } from "@/server/routers";
import { createSystemRouter } from "@/server/routers/system";
import { type Context, createCallerFactory, router } from "@/server/trpc";

// awsReadiness never touches the db, so a bare ctx suffices — no test db.
function caller() {
  return createCaller({
    db: {} as Db,
    session: { user: { id: "u1", email: "u1@example.com", name: "u1" } },
    teamId: "team-1",
    role: "owner",
  });
}

// The dev machine may carry real AWS_* vars; pin every input each test.
// vi.stubEnv("", …) + emptyStringAsUndefined makes "unset" deterministic.
function stubAws(vars: Record<string, string>): void {
  for (const key of [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_DEFAULT_CHAIN",
    "AWS_REGION",
  ]) {
    vi.stubEnv(key, vars[key] ?? "");
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("system.awsReadiness", () => {
  it("reports configured with explicit keys, plus the region", async () => {
    stubAws({
      AWS_ACCESS_KEY_ID: "AKIAEXAMPLE",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_REGION: "sa-east-1",
    });
    expect(await caller().system.awsReadiness()).toEqual({
      credentialsConfigured: true,
      region: "sa-east-1",
    });
  });

  it("reports unconfigured when both keys are unset", async () => {
    stubAws({ AWS_REGION: "us-east-1" });
    expect(await caller().system.awsReadiness()).toMatchObject({
      credentialsConfigured: false,
    });
  });

  it("reports unconfigured when only one of the pair is set", async () => {
    stubAws({ AWS_ACCESS_KEY_ID: "AKIAEXAMPLE", AWS_REGION: "us-east-1" });
    expect((await caller().system.awsReadiness()).credentialsConfigured).toBe(false);
  });

  it("honors the explicit AWS_DEFAULT_CHAIN=true opt-in without keys", async () => {
    stubAws({ AWS_DEFAULT_CHAIN: "true", AWS_REGION: "us-east-1" });
    expect((await caller().system.awsReadiness()).credentialsConfigured).toBe(true);
  });

  it("rejects callers without a team context", async () => {
    const anonymous = createCaller({ db: {} as Db, session: null, teamId: null, role: null });
    await expect(anonymous.system.awsReadiness()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});

/** Caller over a system router with an injected fake SES account client. */
function sesCaller(client: SesAccountClient) {
  const factory = createCallerFactory(
    router({ system: createSystemRouter({ accountClient: () => client }) }),
  );
  return factory({
    db: {} as Db,
    session: { user: { id: "u1", email: "u1@example.com", name: "u1" } },
    teamId: "team-1",
    role: "owner",
  } as Context);
}

describe("system.sesAccount", () => {
  it("returns the mapped account overview on success", async () => {
    const client: SesAccountClient = {
      async send() {
        return {
          SendingEnabled: true,
          ProductionAccessEnabled: false,
          SendQuota: { Max24HourSend: 200, SentLast24Hours: 3, MaxSendRate: 1 },
        };
      },
    };
    expect(await sesCaller(client).system.sesAccount()).toEqual({
      ok: true,
      sendingEnabled: true,
      productionAccess: false,
      quota: { max24h: 200, sentLast24h: 3, maxSendRate: 1 },
    });
  });

  it("maps credential failures to a typed { ok: false, kind: 'credentials' }", async () => {
    const client: SesAccountClient = {
      async send() {
        throw new Error("The security token included in the request is invalid.");
      },
    };
    expect(await sesCaller(client).system.sesAccount()).toEqual({
      ok: false,
      kind: "credentials",
      message: "The security token included in the request is invalid.",
    });
  });

  it("maps other failures to kind 'unreachable' instead of throwing", async () => {
    const client: SesAccountClient = {
      async send() {
        throw new Error("getaddrinfo ENOTFOUND email.sa-east-1.amazonaws.com");
      },
    };
    expect(await sesCaller(client).system.sesAccount()).toMatchObject({
      ok: false,
      kind: "unreachable",
    });
  });
});

describe("system.instanceSettings", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeEach(async () => {
    ({ db, close } = await createTestDb());
    await db.insert(schema.user).values([
      { id: "u1", name: "u1", email: "u1@example.com", createdAt: new Date(0) },
      { id: "u2", name: "u2", email: "u2@example.com", createdAt: new Date(1) },
    ]);
  });
  afterEach(() => close());

  function dbCaller(role: "owner" | "admin" | "member", userId = "u1") {
    return createCaller({
      db,
      session: { user: { id: userId, email: `${userId}@example.com`, name: userId } },
      teamId: "team-1",
      role,
    });
  }

  it("resolves precedence db > env > built-in default, reporting the source", async () => {
    vi.stubEnv("SES_MAX_SEND_RATE", "");
    vi.stubEnv("EMAIL_RETENTION_DAYS", "");
    const owner = dbCaller("owner");
    expect(await owner.system.instanceSettings.get()).toMatchObject({
      sesMaxSendRate: { value: 14, source: "default" },
      emailRetentionDays: { value: 30, source: "default" },
    });

    vi.stubEnv("SES_MAX_SEND_RATE", "5");
    vi.stubEnv("EMAIL_RETENTION_DAYS", "60");
    expect(await owner.system.instanceSettings.get()).toMatchObject({
      sesMaxSendRate: { value: 5, source: "env" },
      emailRetentionDays: { value: 60, source: "env" },
    });

    await owner.system.instanceSettings.update({ sesMaxSendRate: 9, emailRetentionDays: 7 });
    expect(await owner.system.instanceSettings.get()).toMatchObject({
      sesMaxSendRate: { value: 9, source: "db" },
      emailRetentionDays: { value: 7, source: "db" },
    });
  });

  it("null clears an override back to env, field by field", async () => {
    vi.stubEnv("SES_MAX_SEND_RATE", "5");
    vi.stubEnv("EMAIL_RETENTION_DAYS", "");
    const owner = dbCaller("owner");
    await owner.system.instanceSettings.update({ sesMaxSendRate: 9, emailRetentionDays: 7 });
    await owner.system.instanceSettings.update({ sesMaxSendRate: null, emailRetentionDays: 7 });
    expect(await owner.system.instanceSettings.get()).toMatchObject({
      sesMaxSendRate: { value: 5, source: "env" },
      emailRetentionDays: { value: 7, source: "db" },
    });
  });

  it("rejects out-of-range values", async () => {
    const owner = dbCaller("owner");
    await expect(
      owner.system.instanceSettings.update({ sesMaxSendRate: 0, emailRetentionDays: 7 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      owner.system.instanceSettings.update({ sesMaxSendRate: 201, emailRetentionDays: 7 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      owner.system.instanceSettings.update({ sesMaxSendRate: 1, emailRetentionDays: 3651 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("members may read but never write; admins may write", async () => {
    const member = dbCaller("member");
    expect(await member.system.instanceSettings.get()).toMatchObject({ canEdit: false });
    await expect(
      member.system.instanceSettings.update({ sesMaxSendRate: 9, emailRetentionDays: 7 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    await dbCaller("admin").system.instanceSettings.update({
      sesMaxSendRate: 9,
      emailRetentionDays: 7,
    });
    expect(await member.system.instanceSettings.get()).toMatchObject({
      sesMaxSendRate: { value: 9, source: "db" },
    });
  });

  it("rejects a later team's owner because team ownership is not instance ownership", async () => {
    const otherOwner = dbCaller("owner", "u2");
    expect(await otherOwner.system.instanceSettings.get()).toMatchObject({ canEdit: false });
    await expect(
      otherOwner.system.instanceSettings.update({ sesMaxSendRate: 9, emailRetentionDays: 7 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("never permits tenant users to change instance settings in cloud mode", async () => {
    vi.stubEnv("IS_CLOUD", "true");
    const operator = dbCaller("owner");
    expect(await operator.system.instanceSettings.get()).toMatchObject({ canEdit: false });
    await expect(
      operator.system.instanceSettings.update({ sesMaxSendRate: 9, emailRetentionDays: 7 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("hides instance-wide facts from cloud tenants who are not the operator", async () => {
    vi.stubEnv("IS_CLOUD", "true");
    const tenant = dbCaller("owner", "u2");
    for (const read of [
      () => tenant.system.instanceSettings.get(),
      () => tenant.system.awsReadiness(),
      () => tenant.system.sesEnv(),
      () => tenant.system.sesAccount(),
    ]) {
      await expect(read()).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    // Tenant screens still learn what they need from the ungated facts.
    expect(await tenant.system.features()).toMatchObject({ trackingRequiresSubdomain: true });
    // The operator's own account keeps reading them.
    expect(await dbCaller("owner").system.awsReadiness()).toHaveProperty("credentialsConfigured");
  });
});

describe("system.sesEnv", () => {
  it("reports whether SNS topics and the configuration set are configured", async () => {
    vi.stubEnv("SNS_TOPIC_ARNS", "arn:aws:sns:us-east-1:123456789012:ms-events");
    vi.stubEnv("SES_CONFIGURATION_SET", "millionsend");
    expect(await caller().system.sesEnv()).toMatchObject({
      snsTopicsConfigured: true,
      configurationSetConfigured: true,
    });
  });

  it("reports unset SNS topics and configuration set", async () => {
    vi.stubEnv("SNS_TOPIC_ARNS", "");
    vi.stubEnv("SES_CONFIGURATION_SET", "");
    expect(await caller().system.sesEnv()).toMatchObject({
      snsTopicsConfigured: false,
      configurationSetConfigured: false,
    });
  });
});
