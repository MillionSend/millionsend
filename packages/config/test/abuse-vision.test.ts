import { expect, it } from "vitest";
import { ABUSE_VISION_MODEL, abuseVisionConfig, type Env } from "../src/env.js";

function fakeEnv(overrides: Record<string, string | boolean | number>): Env {
  return { IS_CLOUD: false, MASTER_ENCRYPTION_KEY: "key", ...overrides } as unknown as Env;
}

it("is off by default", () => {
  expect(abuseVisionConfig(fakeEnv({}))).toBeNull();
  expect(abuseVisionConfig(fakeEnv({ ABUSE_VISION: "off" }))).toBeNull();
});

it("reads Bedrock's region and the worker's AWS keys, with one fixed model", () => {
  expect(abuseVisionConfig(fakeEnv({ ABUSE_VISION: "bedrock" }))).toEqual({
    region: "us-east-1",
    accessKeyId: undefined,
    secretAccessKey: undefined,
  });
  expect(
    abuseVisionConfig(
      fakeEnv({
        ABUSE_VISION: "bedrock",
        ABUSE_VISION_REGION: "us-west-2",
        AWS_ACCESS_KEY_ID: "AKIA",
        AWS_SECRET_ACCESS_KEY: "secret",
      }),
    ),
  ).toEqual({ region: "us-west-2", accessKeyId: "AKIA", secretAccessKey: "secret" });
  expect(ABUSE_VISION_MODEL).toBe("anthropic.claude-haiku-5-5");
});
