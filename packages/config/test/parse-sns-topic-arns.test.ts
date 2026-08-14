import { expect, it } from "vitest";
import { parseSnsTopicArns } from "../src/env.js";

const ARN = "arn:aws:sns:us-east-1:123456789012:millionsend-events";

it("parses comma-separated ARNs with whitespace tolerance", async () => {
  expect(parseSnsTopicArns(`${ARN}, ${ARN}2`)).toEqual([ARN, `${ARN}2`]);
  expect(parseSnsTopicArns(` ${ARN} `)).toEqual([ARN]);
});

it("degenerate inputs yield undefined, never a truthy empty allowlist", async () => {
  // [] would mount the SNS endpoint yet 403 every delivery — including the
  // SubscriptionConfirmation needed to ever receive events.
  expect(parseSnsTopicArns(undefined)).toBeUndefined();
  expect(parseSnsTopicArns("")).toBeUndefined();
  expect(parseSnsTopicArns(",")).toBeUndefined();
  expect(parseSnsTopicArns(" , , ")).toBeUndefined();
  expect(parseSnsTopicArns("   ")).toBeUndefined();
});
