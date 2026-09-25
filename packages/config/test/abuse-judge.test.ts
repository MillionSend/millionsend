import { expect, it } from "vitest";
import { abuseJudgeConfig, assertEnvConsistency, type Env } from "../src/env.js";

function fakeEnv(overrides: Record<string, string | boolean | number>): Env {
  return { IS_CLOUD: false, MASTER_ENCRYPTION_KEY: "key", ...overrides } as unknown as Env;
}

it("is off by default and needs nothing else then", () => {
  expect(abuseJudgeConfig(fakeEnv({}))).toBeNull();
  expect(abuseJudgeConfig(fakeEnv({ ABUSE_JUDGE: "off" }))).toBeNull();
  expect(() => assertEnvConsistency(fakeEnv({ ABUSE_JUDGE: "off" }))).not.toThrow();
});

it("requires an API key when TypeSafe is on, not a model id", () => {
  expect(() => assertEnvConsistency(fakeEnv({ ABUSE_JUDGE: "typesafe" }))).toThrow(
    "ABUSE_JUDGE=typesafe requires ABUSE_JUDGE_API_KEY",
  );
  expect(() =>
    assertEnvConsistency(fakeEnv({ ABUSE_JUDGE: "typesafe", ABUSE_JUDGE_API_KEY: "k" })),
  ).not.toThrow();
});

it("reads the judge's settings with their defaults, validated or raw", () => {
  expect(
    abuseJudgeConfig(
      fakeEnv({
        ABUSE_JUDGE: "typesafe",
        ABUSE_JUDGE_API_KEY: "k",
        ABUSE_JUDGE_TIMEOUT_MS: "5000",
      }),
    ),
  ).toEqual({
    provider: "typesafe",
    model: "jev-1.13.0",
    baseUrl: "https://api.typesafe.ai",
    apiKey: "k",
    timeoutMs: 5000,
  });
  expect(
    abuseJudgeConfig(
      fakeEnv({
        ABUSE_JUDGE: "typesafe",
        ABUSE_JUDGE_MODEL: "jev-preview",
        ABUSE_JUDGE_API_KEY: "k",
        ABUSE_JUDGE_BASE_URL: "https://typesafe.example.com",
      }),
    ),
  ).toMatchObject({
    provider: "typesafe",
    model: "jev-preview",
    baseUrl: "https://typesafe.example.com",
    timeoutMs: 20_000,
  });
});
