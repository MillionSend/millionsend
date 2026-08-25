import { expect, it } from "vitest";
import { assertEnvConsistency, type Env } from "../src/env.js";

// Only the fields the cross-field rules read; the zod schema is not under test.
function fakeEnv(overrides: Record<string, string | boolean>): Env {
  return { IS_CLOUD: false, MASTER_ENCRYPTION_KEY: "key", ...overrides } as unknown as Env;
}

const CREDENTIALS = {
  S3_ENDPOINT: "https://acc.r2.cloudflarestorage.com",
  S3_ACCESS_KEY_ID: "key",
  S3_SECRET_ACCESS_KEY: "secret",
} as const;

it("accepts no S3 config at all, and each feature fully configured", () => {
  expect(() => assertEnvConsistency(fakeEnv({}))).not.toThrow();
  expect(() => assertEnvConsistency(fakeEnv(CREDENTIALS))).not.toThrow();
  expect(() =>
    assertEnvConsistency(
      fakeEnv({
        ...CREDENTIALS,
        S3_STORAGE_BUCKET: "uploads",
        S3_STORAGE_PUBLIC_URL: "https://cdn.example.com",
        S3_BACKUP_BUCKET: "backups",
        S3_BACKUP_PREFIX: "dumps",
        BACKUP_CRON: "0 3 * * *",
        BACKUP_RETENTION_DAYS: "14",
      }),
    ),
  ).not.toThrow();
});

it("rejects a partial credential set, naming the missing variables", () => {
  expect(() => assertEnvConsistency(fakeEnv({ S3_ENDPOINT: CREDENTIALS.S3_ENDPOINT }))).toThrow(
    "S3 credentials must be set together; missing: S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY",
  );
});

it("rejects a bucket without the credential set", () => {
  expect(() =>
    assertEnvConsistency(
      fakeEnv({ S3_STORAGE_BUCKET: "uploads", S3_STORAGE_PUBLIC_URL: "https://cdn.example.com" }),
    ),
  ).toThrow("S3_STORAGE_BUCKET requires the S3 credentials");
  expect(() => assertEnvConsistency(fakeEnv({ S3_BACKUP_BUCKET: "backups" }))).toThrow(
    "S3_BACKUP_BUCKET requires the S3 credentials",
  );
});

it("rejects a storage bucket and public URL set without each other", () => {
  expect(() =>
    assertEnvConsistency(fakeEnv({ ...CREDENTIALS, S3_STORAGE_BUCKET: "uploads" })),
  ).toThrow("S3_STORAGE_BUCKET and S3_STORAGE_PUBLIC_URL must be set together");
  expect(() =>
    assertEnvConsistency(
      fakeEnv({ ...CREDENTIALS, S3_STORAGE_PUBLIC_URL: "https://cdn.example.com" }),
    ),
  ).toThrow("S3_STORAGE_BUCKET and S3_STORAGE_PUBLIC_URL must be set together");
});

it("rejects backup tuning without S3_BACKUP_BUCKET", () => {
  expect(() => assertEnvConsistency(fakeEnv({ BACKUP_CRON: "0 3 * * *" }))).toThrow(
    "BACKUP_CRON requires S3_BACKUP_BUCKET",
  );
  expect(() => assertEnvConsistency(fakeEnv({ S3_BACKUP_PREFIX: "dumps" }))).toThrow(
    "S3_BACKUP_PREFIX requires S3_BACKUP_BUCKET",
  );
  expect(() => assertEnvConsistency(fakeEnv({ BACKUP_RETENTION_DAYS: "14" }))).toThrow(
    "BACKUP_RETENTION_DAYS requires S3_BACKUP_BUCKET",
  );
});

it("rejects an AUTH_EMAIL_FROM that does not parse, accepts both valid forms", () => {
  expect(() => assertEnvConsistency(fakeEnv({ AUTH_EMAIL_FROM: "not-an-email" }))).toThrow(
    "AUTH_EMAIL_FROM",
  );
  expect(() =>
    assertEnvConsistency(fakeEnv({ AUTH_EMAIL_FROM: "no-reply@mail.example.com" })),
  ).not.toThrow();
  expect(() =>
    assertEnvConsistency(fakeEnv({ AUTH_EMAIL_FROM: "MillionSend <no-reply@mail.example.com>" })),
  ).not.toThrow();
});
