import { describe, expect, it } from "vitest";
import { reservedSenderRefusal } from "../src/onboarding-sender.js";

describe("reservedSenderRefusal", () => {
  const platform = "MillionSend <hello@ms.example>";
  it("refuses the shared sender in any letter case or display name, and nothing else", () => {
    for (const from of [
      platform,
      "hello@ms.example",
      "HELLO@MS.Example",
      "Security <hello@ms.example>",
    ]) {
      expect(reservedSenderRefusal(from, platform)).toEqual({
        name: "reserved_sender",
        message:
          "hello@ms.example is reserved for MillionSend's own onboarding email. Add and verify a domain to send your own emails: https://docs.millionsend.com/concepts/domains",
      });
    }
    for (const from of [
      "news@ms.example",
      "hello+1@ms.example",
      "hello@acme.dev",
      "not an address",
    ]) {
      expect(reservedSenderRefusal(from, platform)).toBeNull();
    }
    // An instance that configures no shared sender reserves nothing.
    expect(reservedSenderRefusal("hello@ms.example", undefined)).toBeNull();
    expect(reservedSenderRefusal("hello@ms.example", "")).toBeNull();
  });
});
