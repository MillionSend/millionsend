import { describe, expect, it } from "vitest";
import { combineRecordStatus, sesGateFromRecordStatus } from "@/lib/dns-record-status";

describe("combineRecordStatus", () => {
  it("returns checking while our live lookup hasn't run", () => {
    expect(combineRecordStatus({ live: undefined, sesGate: undefined })).toBe("checking");
    expect(combineRecordStatus({ live: undefined, sesGate: "verified" })).toBe("checking");
    expect(combineRecordStatus({ live: undefined, sesGate: "pending" })).toBe("checking");
  });

  it("our DNS is the primary gate — missing/mismatch win regardless of AWS", () => {
    for (const sesGate of ["verified", "pending", undefined] as const) {
      expect(combineRecordStatus({ live: "missing", sesGate })).toBe("missing");
      expect(combineRecordStatus({ live: "mismatch", sesGate })).toBe("mismatch");
    }
  });

  it("found + no AWS gate (DMARC/tracking) is verified on our lookup alone", () => {
    expect(combineRecordStatus({ live: "found", sesGate: undefined })).toBe("verified");
  });

  it("found but AWS still pending is not verified — passing our test alone isn't enough", () => {
    expect(combineRecordStatus({ live: "found", sesGate: "pending" })).toBe("pending");
  });

  it("found and AWS verified is verified (both gates passed)", () => {
    expect(combineRecordStatus({ live: "found", sesGate: "verified" })).toBe("verified");
  });
});

describe("sesGateFromRecordStatus", () => {
  it("maps a row's SES status to its gate; null means no AWS gate", () => {
    expect(sesGateFromRecordStatus("verified")).toBe("verified");
    expect(sesGateFromRecordStatus("pending")).toBe("pending");
    // A FAILED SES row is not a pass, so it gates like pending.
    expect(sesGateFromRecordStatus("failed")).toBe("pending");
    expect(sesGateFromRecordStatus(null)).toBeUndefined();
  });

  it("composes with combineRecordStatus for a full row verdict", () => {
    // DMARC row (status null) present in our DNS → verified without AWS.
    expect(combineRecordStatus({ live: "found", sesGate: sesGateFromRecordStatus(null) })).toBe(
      "verified",
    );
    // DKIM row present but SES still pending → pending, not a stale green.
    expect(
      combineRecordStatus({ live: "found", sesGate: sesGateFromRecordStatus("pending") }),
    ).toBe("pending");
    // A since-removed record whose SES cache still says verified → missing.
    expect(
      combineRecordStatus({ live: "missing", sesGate: sesGateFromRecordStatus("verified") }),
    ).toBe("missing");
  });
});
