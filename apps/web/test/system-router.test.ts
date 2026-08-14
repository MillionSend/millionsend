import type { Db } from "@millionsend/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCaller } from "@/server/routers";

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
