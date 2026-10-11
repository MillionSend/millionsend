import { expect, it } from "vitest";
import { assertEnvConsistency, type Env, receivingEnabled, receivingMxHost } from "../src/env.js";

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
