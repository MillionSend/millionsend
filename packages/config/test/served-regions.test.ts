import { expect, it } from "vitest";
import { type Env, servedRegions } from "../src/env.js";

const withEnv = (e: Partial<Record<"AWS_REGION" | "AWS_REGIONS", unknown>>) => e as unknown as Env;

it("lists AWS_REGIONS in order, the first being the default", () => {
  expect(servedRegions(withEnv({ AWS_REGIONS: ["sa-east-1", "us-east-1"] }))).toEqual([
    "sa-east-1",
    "us-east-1",
  ]);
  // Under SKIP_ENV_VALIDATION the proxy carries the raw string.
  expect(servedRegions(withEnv({ AWS_REGIONS: " sa-east-1 ,us-east-1, " }))).toEqual([
    "sa-east-1",
    "us-east-1",
  ]);
});

it("falls back to the one-region alias, then to the built-in default", () => {
  expect(servedRegions(withEnv({ AWS_REGION: "eu-west-1" }))).toEqual(["eu-west-1"]);
  expect(servedRegions(withEnv({ AWS_REGIONS: "", AWS_REGION: "eu-west-1" }))).toEqual([
    "eu-west-1",
  ]);
  expect(servedRegions(withEnv({}))).toEqual(["us-east-1"]);
});
