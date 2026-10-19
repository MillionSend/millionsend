import { expect, it } from "vitest";
import {
  abuseVisionConfig,
  abuseVisionProfile,
  assertEnvConsistency,
  type Env,
} from "../src/env.js";

function fakeEnv(overrides: Record<string, string | boolean | number>): Env {
  return { IS_CLOUD: false, MASTER_ENCRYPTION_KEY: "key", ...overrides } as unknown as Env;
}

it("is off by default", () => {
  expect(abuseVisionConfig(fakeEnv({}))).toBeNull();
  expect(abuseVisionConfig(fakeEnv({ ABUSE_VISION: "off" }))).toBeNull();
});

it("reads Bedrock's region, its geographic profile and the worker's AWS keys", () => {
  expect(abuseVisionConfig(fakeEnv({ ABUSE_VISION: "bedrock" }))).toEqual({
    region: "us-east-1",
    model: "us.anthropic.claude-haiku-5-5",
    accessKeyId: undefined,
    secretAccessKey: undefined,
  });
  expect(
    abuseVisionConfig(
      fakeEnv({
        ABUSE_VISION: "bedrock",
        ABUSE_VISION_REGION: "eu-west-3",
        AWS_ACCESS_KEY_ID: "AKIA",
        AWS_SECRET_ACCESS_KEY: "secret",
      }),
    ),
  ).toEqual({
    region: "eu-west-3",
    model: "eu.anthropic.claude-haiku-5-5",
    accessKeyId: "AKIA",
    secretAccessKey: "secret",
  });
});

// The whole table, so a region moved, added or sent to another profile fails here.
const GEOGRAPHIES = {
  us: ["us-east-1", "us-east-2", "us-west-1", "us-west-2", "ca-central-1", "ca-west-1"],
  eu: [
    "eu-central-1",
    "eu-central-2",
    "eu-north-1",
    "eu-south-1",
    "eu-south-2",
    "eu-west-1",
    "eu-west-2",
    "eu-west-3",
  ],
  au: ["ap-southeast-2", "ap-southeast-4"],
  jp: ["ap-northeast-1", "ap-northeast-3"],
};

it("calls Haiku 5.5 through the region's geography, never the global profile", () => {
  for (const [geo, regions] of Object.entries(GEOGRAPHIES)) {
    for (const region of regions) {
      expect(abuseVisionProfile(region)).toBe(`${geo}.anthropic.claude-haiku-5-5`);
    }
  }
  for (const region of ["sa-east-1", "ap-south-1", "us-gov-west-1"]) {
    expect(abuseVisionProfile(region)).toBeNull();
  }
});

it("refuses the boot for a region with no geographic profile, only while reading is on", () => {
  const outside = fakeEnv({ ABUSE_VISION: "bedrock", ABUSE_VISION_REGION: "sa-east-1" });
  const refusal = new Error(
    "ABUSE_VISION_REGION=sa-east-1 has no geographic inference profile for Claude Haiku 5.5 " +
      `that image reading can use; use one of ${Object.values(GEOGRAPHIES).flat().join(", ")}`,
  );
  expect(() => abuseVisionConfig(outside)).toThrow(refusal);
  expect(() => assertEnvConsistency(outside)).toThrow(refusal);
  expect(() => assertEnvConsistency(fakeEnv({ ABUSE_VISION_REGION: "sa-east-1" }))).not.toThrow();
});
