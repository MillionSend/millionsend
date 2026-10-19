import { describe, expect, it } from "vitest";
import {
  assertEnvConsistency,
  clamavHost,
  type Env,
  receivingEnabled,
  receivingMxHost,
  sharedInboxDomain,
} from "../src/env.js";

function fakeEnv(overrides: Record<string, string | boolean>): Env {
  return { IS_CLOUD: false, MASTER_ENCRYPTION_KEY: "key", ...overrides } as unknown as Env;
}

const SECRET = "0123456789abcdef0123456789abcdef";

it("receiving exists only when RECEIVING_MX_HOST is set", () => {
  expect(receivingEnabled(fakeEnv({}))).toBe(false);
  expect(receivingMxHost(fakeEnv({}))).toBeUndefined();
  // Under SKIP_ENV_VALIDATION an empty value arrives as "".
  expect(receivingEnabled(fakeEnv({ RECEIVING_MX_HOST: "" }))).toBe(false);
  const on = fakeEnv({ RECEIVING_MX_HOST: "mx.millionsend-dns.com", MX_INGEST_SECRET: SECRET });
  expect(receivingEnabled(on)).toBe(true);
  expect(receivingMxHost(on)).toBe("mx.millionsend-dns.com");
});

it("boots with receiving fully configured or not at all", () => {
  expect(() => assertEnvConsistency(fakeEnv({}))).not.toThrow();
  expect(() =>
    assertEnvConsistency(
      fakeEnv({ RECEIVING_MX_HOST: "mx.millionsend-dns.com", MX_INGEST_SECRET: SECRET }),
    ),
  ).not.toThrow();
});

it("rejects a partial receiving configuration either way round", () => {
  expect(() =>
    assertEnvConsistency(fakeEnv({ RECEIVING_MX_HOST: "mx.millionsend-dns.com" })),
  ).toThrow("RECEIVING_MX_HOST and MX_INGEST_SECRET must be set together");
  expect(() => assertEnvConsistency(fakeEnv({ MX_INGEST_SECRET: SECRET }))).toThrow(
    "RECEIVING_MX_HOST and MX_INGEST_SECRET must be set together",
  );
});

it("rejects an ingest secret under 32 characters and an MX host that is not a hostname", () => {
  expect(() =>
    assertEnvConsistency(
      fakeEnv({ RECEIVING_MX_HOST: "mx.millionsend-dns.com", MX_INGEST_SECRET: SECRET.slice(1) }),
    ),
  ).toThrow("MX_INGEST_SECRET must be at least 32 characters");
  for (const host of ["https://mx.example.com", "MX.example.com", "mx", "mx.example.com."]) {
    expect(() =>
      assertEnvConsistency(fakeEnv({ RECEIVING_MX_HOST: host, MX_INGEST_SECRET: SECRET })),
    ).toThrow("RECEIVING_MX_HOST must be a lowercase hostname");
  }
});

describe("the shared inbox domain", () => {
  const receiving = { RECEIVING_MX_HOST: "mx.millionsend-dns.com", MX_INGEST_SECRET: SECRET };
  const cloud = {
    IS_CLOUD: true,
    KMS_KEY_ID: "key",
    STRIPE_SECRET_KEY: "sk",
    STRIPE_WEBHOOK_SECRET: "whsec",
    APP_BASE_URL: "https://app.example.com",
  };

  it("is read only when set, like the clamd host", () => {
    expect(sharedInboxDomain(fakeEnv({}))).toBeUndefined();
    expect(sharedInboxDomain(fakeEnv({ SHARED_INBOX_DOMAIN: "" }))).toBeUndefined();
    expect(sharedInboxDomain(fakeEnv({ SHARED_INBOX_DOMAIN: "agents.example.com" }))).toBe(
      "agents.example.com",
    );
    expect(clamavHost(fakeEnv({}))).toBeUndefined();
    expect(clamavHost(fakeEnv({ CLAMAV_HOST: "clamav:3310" }))).toBe("clamav:3310");
  });

  it("boots with receiving and its own registrable domain", () => {
    const ok = fakeEnv({ ...receiving, SHARED_INBOX_DOMAIN: "agents.example.com" });
    expect(() => assertEnvConsistency(ok)).not.toThrow();
    expect(() =>
      assertEnvConsistency(fakeEnv({ ...receiving, ...cloud, SHARED_INBOX_DOMAIN: "x.dev" })),
    ).not.toThrow();
  });

  it("refuses to boot without receiving, as a non-hostname, or under the platform's domains on cloud", () => {
    expect(() =>
      assertEnvConsistency(fakeEnv({ SHARED_INBOX_DOMAIN: "agents.example.com" })),
    ).toThrow("SHARED_INBOX_DOMAIN requires RECEIVING_MX_HOST");
    for (const domain of ["Agents.example.com", "https://agents.example.com", "agents"]) {
      expect(() =>
        assertEnvConsistency(fakeEnv({ ...receiving, SHARED_INBOX_DOMAIN: domain })),
      ).toThrow("SHARED_INBOX_DOMAIN must be a lowercase hostname");
    }
    for (const domain of [
      "millionsend.com",
      "agents.millionsend.com",
      "millionsend-dns.com",
      "a.millionsend-dns.com",
    ]) {
      expect(() =>
        assertEnvConsistency(fakeEnv({ ...receiving, ...cloud, SHARED_INBOX_DOMAIN: domain })),
      ).toThrow("must be its own registrable domain");
    }
    // A self-host operator may run it anywhere it owns.
    expect(() =>
      assertEnvConsistency(
        fakeEnv({ ...receiving, SHARED_INBOX_DOMAIN: "agents.millionsend.com" }),
      ),
    ).not.toThrow();
  });
});
