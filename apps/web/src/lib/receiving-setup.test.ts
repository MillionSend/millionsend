import { describe, expect, it } from "vitest";
import { lowestMxHost, receivingErrorKey, receivingStep } from "./receiving-setup";

describe("receivingStep", () => {
  it("reads every state of a picked domain", () => {
    const step = (
      verified: boolean,
      receiving: boolean,
      mx: Parameters<typeof receivingStep>[0]["mx"],
      acted = false,
    ) => receivingStep({ verified, receiving, mx, acted });
    // Not verified: nothing else matters, and no DNS check is needed.
    expect(step(false, false, undefined)).toBe("unverified");
    expect(step(false, true, "found")).toBe("unverified");
    // Off: turning it on is offered only once DNS shows no other mail server.
    expect(step(true, false, undefined)).toBe("checking");
    expect(step(true, false, "missing")).toBe("enable");
    expect(step(true, false, "found")).toBe("enable");
    expect(step(true, false, "mismatch")).toBe("elsewhere");
    expect(step(true, false, "unknown")).toBe("unknown");
    // On: the record still to add, or mail that still goes elsewhere.
    expect(step(true, true, "missing")).toBe("add_mx");
    expect(step(true, true, "mismatch")).toBe("elsewhere");
    // On and live, or not answering: silent unless set up in this dialog.
    expect(step(true, true, "found")).toBeNull();
    expect(step(true, true, "unknown")).toBeNull();
    expect(step(true, true, undefined)).toBeNull();
    expect(step(true, true, "found", true)).toBe("live");
    expect(step(true, true, "unknown", true)).toBe("unknown");
  });
});

describe("lowestMxHost", () => {
  it("names the host that gets the mail first", () => {
    expect(lowestMxHost("1 smtp.mail.example\n5 alt1.mail.example")).toBe("smtp.mail.example");
    expect(lowestMxHost(undefined)).toBeNull();
  });
});

describe("receivingErrorKey", () => {
  it("words each refusal of setReceiving", () => {
    expect(receivingErrorKey("FORBIDDEN")).toBe("detail.receiving.adminOnly");
    expect(receivingErrorKey("PRECONDITION_FAILED")).toBe("detail.receiving.errorNotVerified");
    expect(receivingErrorKey("CONFLICT")).toBe("detail.receiving.errorTaken");
    expect(receivingErrorKey("INTERNAL_SERVER_ERROR")).toBe("detail.receiving.error");
    expect(receivingErrorKey(undefined)).toBe("detail.receiving.error");
  });
});
