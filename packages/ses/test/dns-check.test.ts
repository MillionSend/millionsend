import { describe, expect, it } from "vitest";
import { checkDnsRecords, type DnsResolver } from "../src/dns-check.js";

const empty: DnsResolver = {
  resolveTxt: async () => [],
  resolveMx: async () => [],
  resolveCname: async () => [],
};

describe("checkDnsRecords", () => {
  it("classifies present/matching, present/wrong, and absent per type", async () => {
    const resolver: DnsResolver = {
      // DKIM TXT is chunked on the wire and stored quoted: still Found.
      resolveTxt: async (name) =>
        name === "sel._domainkey.d.com"
          ? [["v=DKIM1; k=rsa; ", "p=ABC"]]
          : name === "send.d.com"
            ? [["v=spf1 include:other ~all"]]
            : [],
      resolveMx: async (name) =>
        name === "send.d.com"
          ? [{ priority: 10, exchange: "feedback-smtp.us-east-1.amazonses.com." }]
          : [],
      resolveCname: async () => {
        throw Object.assign(new Error("nxdomain"), { code: "ENOTFOUND" });
      },
    };

    const [dkim, mx, spf, cname] = await checkDnsRecords(
      [
        { type: "TXT", name: "sel._domainkey.d.com", value: '"v=DKIM1; k=rsa; p=ABC"' },
        {
          type: "MX",
          name: "send.d.com",
          value: "feedback-smtp.us-east-1.amazonses.com",
          priority: 10,
        },
        { type: "TXT", name: "send.d.com", value: '"v=spf1 include:amazonses.com ~all"' },
        { type: "CNAME", name: "track.d.com", value: "app.example.com" },
      ],
      resolver,
    );

    expect(dkim).toBe("found"); // rejoined chunks + trailing-dot/quote-normalized match
    expect(mx).toBe("found"); // exchange + priority match
    expect(spf).toBe("mismatch"); // name answers TXT, but not our SPF value
    expect(cname).toBe("missing"); // NXDOMAIN never throws, reads missing
  });

  it("never throws and reads everything missing when the resolver rejects", async () => {
    const throwing: DnsResolver = {
      resolveTxt: async () => {
        throw new Error("timeout");
      },
      resolveMx: async () => {
        throw new Error("timeout");
      },
      resolveCname: async () => {
        throw new Error("timeout");
      },
    };
    const out = await checkDnsRecords(
      [
        { type: "TXT", name: "a", value: '"x"' },
        { type: "MX", name: "b", value: "m" },
      ],
      throwing,
    );
    expect(out).toEqual(["missing", "missing"]);
  });

  it("reads an unanswered name as missing", async () => {
    const [status] = await checkDnsRecords([{ type: "TXT", name: "a", value: '"x"' }], empty);
    expect(status).toBe("missing");
  });
});
