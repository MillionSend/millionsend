import type { Db } from "@millionsend/db";
import type { SesAccountClient } from "@millionsend/ses";
import { afterEach, describe, expect, it, vi } from "vitest";
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
