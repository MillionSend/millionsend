import { describe, expect, it } from "vitest";
import type { DnsResolver } from "../src/dns-check.js";
import type { SesIdentityClient } from "../src/domain-identity.js";
import { computeDomainVerification, verificationDbPatch } from "../src/domain-verification.js";

const DOMAIN = {
  name: "d.com",
  region: "us-east-1",
  mailFromSubdomain: "send",
  dkimSelector: "sel",
  dkimPublicKey: "ABC",
  trackingSubdomain: null,
};

/** GetEmailIdentity-only fake; every other command is irrelevant to verification. */
function fakeSes(state: {
  dkimStatus?: string;
  mailFromStatus?: string;
  verifiedForSending?: boolean;
}): SesIdentityClient {
  return {
    async send(command) {
      if (command.constructor.name === "GetEmailIdentityCommand") {
        return {
          VerifiedForSendingStatus: state.verifiedForSending ?? false,
          DkimAttributes: { Status: state.dkimStatus ?? "PENDING" },
          MailFromAttributes: { MailFromDomainStatus: state.mailFromStatus ?? "PENDING" },
        };
      }
      return {};
    },
  };
}

/** Answers DKIM/MX/SPF as fully live by default; overrides null a record out. */
function fakeDns(
  overrides: { spf?: boolean; dkim?: boolean; mx?: boolean; dmarc?: string } = {},
): DnsResolver {
  const { spf = true, dkim = true, mx = true, dmarc } = overrides;
  return {
    resolveTxt: async (name) => {
      if (name === "sel._domainkey.d.com") return dkim ? [["v=DKIM1; k=rsa; p=ABC"]] : [];
      if (name === "send.d.com") return spf ? [["v=spf1 include:amazonses.com ~all"]] : [];
      if (name === "_dmarc.d.com" && dmarc) return [[dmarc]];
      return []; // _dmarc.d.com not published by default
    },
    resolveMx: async (name) =>
      name === "send.d.com" && mx
        ? [{ priority: 10, exchange: "feedback-smtp.us-east-1.amazonses.com" }]
        : [],
    resolveCname: async () => [],
  };
}

describe("computeDomainVerification", () => {
  it("DKIM+MX+SPF found and SES-verified promotes to verified (DMARC missing never gates)", async () => {
    const result = await computeDomainVerification(
      fakeSes({ dkimStatus: "SUCCESS", mailFromStatus: "SUCCESS", verifiedForSending: true }),
      fakeDns(),
      DOMAIN,
    );
    expect(result.status).toBe("verified");
    // DMARC row is present but unresolved, yet the domain is still verified.
    expect(result.liveDns.find((r) => r.name === "_dmarc.d.com")?.status).toBe("missing");
    // The persisted snapshot mirrors the live verdicts, keyed by group.
    expect(result.dnsRecords).toEqual([
      { group: "verification", name: "sel._domainkey.d.com", type: "TXT", status: "found" },
      { group: "sending", name: "send.d.com", type: "MX", status: "found" },
      { group: "sending", name: "send.d.com", type: "TXT", status: "found" },
      { group: "dmarc", name: "_dmarc.d.com", type: "TXT", status: "missing" },
    ]);
    expect(result.dmarc).toEqual({ status: "missing" });
  });

  it("any valid published DMARC counts: p=quarantine reads found and its policy is surfaced", async () => {
    const result = await computeDomainVerification(
      fakeSes({ dkimStatus: "SUCCESS", mailFromStatus: "SUCCESS", verifiedForSending: true }),
      fakeDns({ dmarc: "v=DMARC1; p=quarantine;" }),
      DOMAIN,
    );
    expect(result.status).toBe("verified");
    // The checklist row recommends p=none but must not read a stricter
    // published policy as a mismatch.
    expect(result.liveDns.find((r) => r.name === "_dmarc.d.com")?.status).toBe("found");
    expect(result.dmarc).toEqual({ status: "found", policy: "quarantine" });
  });

  it("SPF removed after verification demotes to pending even while SES caches SUCCESS", async () => {
    const result = await computeDomainVerification(
      fakeSes({ dkimStatus: "SUCCESS", mailFromStatus: "SUCCESS", verifiedForSending: true }),
      fakeDns({ spf: false }),
      DOMAIN,
    );
    expect(result.status).toBe("pending");
    expect(result.liveDns.find((r) => r.name === "send.d.com" && r.type === "TXT")?.status).toBe(
      "missing",
    );
  });

  it("never throws on NXDOMAIN/timeout — a dead resolver reads pending, not an error", async () => {
    const throwing: DnsResolver = {
      resolveTxt: async () => {
        throw Object.assign(new Error("nxdomain"), { code: "ENOTFOUND" });
      },
      resolveMx: async () => {
        throw new Error("timeout");
      },
      resolveCname: async () => {
        throw new Error("timeout");
      },
    };
    const result = await computeDomainVerification(
      fakeSes({ dkimStatus: "SUCCESS", mailFromStatus: "SUCCESS", verifiedForSending: true }),
      throwing,
      DOMAIN,
    );
    expect(result.status).toBe("pending");
    // NXDOMAIN is conclusive absence; a plain timeout is inconclusive.
    expect(
      result.liveDns.filter((r) => r.type === "TXT").every((r) => r.status === "missing"),
    ).toBe(true);
    expect(result.liveDns.find((r) => r.type === "MX")?.status).toBe("unknown");
    expect(result.dmarc).toEqual({ status: "missing" });
  });

  it("verificationDbPatch: an unknown DMARC lookup persists neither policy nor checkedAt", () => {
    const now = new Date();
    const dnsRecords = [
      { group: "dmarc", name: "_dmarc.d.com", type: "TXT", status: "unknown" as const },
    ];
    expect(verificationDbPatch({ dnsRecords, dmarc: { status: "unknown" } }, now)).toEqual({
      dnsRecords,
    });
    expect(
      verificationDbPatch({ dnsRecords, dmarc: { status: "found", policy: "reject" } }, now),
    ).toEqual({ dnsRecords, dmarcPolicy: "reject", dmarcCheckedAt: now });
    expect(verificationDbPatch({ dnsRecords, dmarc: { status: "missing" } }, now)).toEqual({
      dnsRecords,
      dmarcPolicy: null,
      dmarcCheckedAt: now,
    });
  });

  it("SES DKIM hard failure surfaces as failed regardless of live DNS", async () => {
    const result = await computeDomainVerification(
      fakeSes({ dkimStatus: "FAILED" }),
      fakeDns(),
      DOMAIN,
    );
    expect(result.status).toBe("failed");
  });
});
