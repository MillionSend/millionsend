import { randomBytes } from "node:crypto";
import { CompositeKeyring, EnvKeyring } from "@millionsend/core";
import { expect, it } from "vitest";
import { createKeyringFromEnv } from "../src/kms.js";

const KEK = randomBytes(32).toString("base64");
const BASE = { AWS_REGION: "us-east-1" };

it("self-host uses the env KEK", () => {
  expect(
    createKeyringFromEnv({ ...BASE, IS_CLOUD: false, MASTER_ENCRYPTION_KEY: KEK }),
  ).toBeInstanceOf(EnvKeyring);
});

it("cloud still needs the env KEK: it is the token-derivation root", () => {
  expect(() => createKeyringFromEnv({ ...BASE, IS_CLOUD: true, KMS_KEY_ID: "kms-key" })).toThrow(
    /MASTER_ENCRYPTION_KEY is required/,
  );
});

it("cloud wraps with KMS behind the composite so env-sealed rows stay readable", () => {
  expect(
    createKeyringFromEnv({
      ...BASE,
      IS_CLOUD: true,
      KMS_KEY_ID: "kms-key",
      MASTER_ENCRYPTION_KEY: KEK,
    }),
  ).toBeInstanceOf(CompositeKeyring);
});

it("cloud without KMS_KEY_ID falls back to the env KEK (SKIP_ENV_VALIDATION test envs)", () => {
  expect(
    createKeyringFromEnv({ ...BASE, IS_CLOUD: true, MASTER_ENCRYPTION_KEY: KEK }),
  ).toBeInstanceOf(EnvKeyring);
});

it("throws without any key source", () => {
  expect(() => createKeyringFromEnv({ ...BASE, IS_CLOUD: false })).toThrow(
    /MASTER_ENCRYPTION_KEY is required/,
  );
});
