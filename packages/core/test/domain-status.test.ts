import { describe, expect, it } from "vitest";
import {
  combineRecordStatus,
  recordCheck,
  sesGateFromRecordStatus,
  strictDomainStatus,
} from "../src/domain-status.js";

describe("combineRecordStatus", () => {
  it("falls back to AWS's status before our live lookup returns (no checking state)", () => {
    expect(combineRecordStatus({ live: undefined, sesGate: "verified" })).toBe("verified");
    expect(combineRecordStatus({ live: undefined, sesGate: "pending" })).toBe("pending");
    expect(combineRecordStatus({ live: undefined, sesGate: undefined })).toBe("pending");
  });

  it("our DNS is the primary gate — missing/mismatch win regardless of AWS", () => {
    for (const sesGate of ["verified", "pending", undefined] as const) {
      expect(combineRecordStatus({ live: "missing", sesGate })).toBe("missing");
      expect(combineRecordStatus({ live: "mismatch", sesGate })).toBe("mismatch");
    }
  });

  it("an inconclusive lookup (unknown) folds like missing — conservative-closed for sending", () => {
    // SERVFAIL/lame delegation must not hide behind SES's cached SUCCESS.
    for (const sesGate of ["verified", "pending", undefined] as const) {
      expect(combineRecordStatus({ live: "unknown", sesGate })).toBe("missing");
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
    expect(combineRecordStatus({ live: "found", sesGate: sesGateFromRecordStatus(null) })).toBe(
      "verified",
    );
    expect(
      combineRecordStatus({ live: "found", sesGate: sesGateFromRecordStatus("pending") }),
    ).toBe("pending");
    expect(
      combineRecordStatus({ live: "missing", sesGate: sesGateFromRecordStatus("verified") }),
    ).toBe("missing");
  });
});

describe("recordCheck", () => {
  it("maps SES SUCCESS/FAILED/other to verified/failed/pending", () => {
    expect(recordCheck("SUCCESS")).toBe("verified");
    expect(recordCheck("FAILED")).toBe("failed");
    expect(recordCheck("PENDING")).toBe("pending");
    expect(recordCheck("TEMPORARY_FAILURE")).toBe("pending");
    expect(recordCheck("NOT_STARTED")).toBe("pending");
  });
});

describe("strictDomainStatus", () => {
  const found = { live: "found" } as const;

  it("verified only when every required record passes both gates", () => {
    expect(
      strictDomainStatus("SUCCESS", [
        { status: "verified", ...found },
        { status: "verified", ...found },
      ]),
    ).toBe("verified");
  });

  it("a live-missing required record keeps the domain pending even when SES says success", () => {
    // The revocation case: SPF removed after verification, SES still cached SUCCESS.
    expect(
      strictDomainStatus("SUCCESS", [
        { status: "verified", live: "found" },
        { status: "verified", live: "missing" },
      ]),
    ).toBe("pending");
  });

  it("a required record still pending at SES keeps the domain pending", () => {
    expect(strictDomainStatus("SUCCESS", [{ status: "pending", live: "found" }])).toBe("pending");
  });

  it("a dropped zone (all lookups unknown) demotes despite SES's cached SUCCESS", () => {
    expect(
      strictDomainStatus("SUCCESS", [
        { status: "verified", live: "unknown" },
        { status: "verified", live: "unknown" },
      ]),
    ).toBe("pending");
  });

  it("optional (null-status) records never gate", () => {
    expect(
      strictDomainStatus("SUCCESS", [
        { status: "verified", live: "found" },
        { status: null, live: "missing" },
      ]),
    ).toBe("verified");
  });

  it("DKIM hard/temporary failures short-circuit before the all-records check", () => {
    expect(strictDomainStatus("FAILED", [{ status: "verified", ...found }])).toBe("failed");
    expect(strictDomainStatus("TEMPORARY_FAILURE", [{ status: "verified", ...found }])).toBe(
      "temporary_failure",
    );
  });
});
