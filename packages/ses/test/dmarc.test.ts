import { describe, expect, it } from "vitest";
import { lookupDmarc, parseDmarcRecord } from "../src/dmarc.js";
import type { DnsResolver } from "../src/dns-check.js";

describe("parseDmarcRecord", () => {
  it("extracts each policy value", () => {
    expect(parseDmarcRecord("v=DMARC1; p=none;")).toEqual({ policy: "none" });
    expect(parseDmarcRecord("v=DMARC1; p=quarantine")).toEqual({ policy: "quarantine" });
    expect(parseDmarcRecord("v=DMARC1; p=reject; rua=mailto:a@b.c")).toEqual({
      policy: "reject",
    });
  });

  it("is case-insensitive and whitespace-tolerant", () => {
    expect(parseDmarcRecord("V=dmarc1 ; P = Quarantine ;")).toEqual({ policy: "quarantine" });
    expect(parseDmarcRecord("  v = DMARC1;p=none")).toEqual({ policy: "none" });
  });

  it("requires v=DMARC1 first", () => {
    expect(parseDmarcRecord("p=none; v=DMARC1")).toBeNull();
    expect(parseDmarcRecord("v=spf1 include:x ~all")).toBeNull();
    expect(parseDmarcRecord("junk")).toBeNull();
    expect(parseDmarcRecord("")).toBeNull();
  });

  it("rejects unknown or absent p values", () => {
    expect(parseDmarcRecord("v=DMARC1; p=nonsense")).toBeNull();
    expect(parseDmarcRecord("v=DMARC1; rua=mailto:a@b.c")).toBeNull();
  });
});

const ENOTFOUND = Object.assign(new Error("queryTxt ENOTFOUND"), { code: "ENOTFOUND" });

function txtResolver(answers: Record<string, string[][] | Error>): DnsResolver {
  return {
    resolveTxt: async (name) => {
      const answer = answers[name];
      if (answer === undefined) throw ENOTFOUND;
      if (answer instanceof Error) throw answer;
      return answer;
    },
    resolveMx: async () => [],
    resolveCname: async () => [],
  };
}

describe("lookupDmarc", () => {
  it("finds the record at the send domain", async () => {
    const resolver = txtResolver({ "_dmarc.mail.d.com": [["v=DMARC1; p=reject"]] });
    expect(await lookupDmarc("mail.d.com", "d.com", resolver)).toEqual({
      status: "found",
      policy: "reject",
    });
  });

  it("joins multi-chunk TXT answers and picks the first valid record", async () => {
    const resolver = txtResolver({
      "_dmarc.d.com": [["some-verification-token"], ["v=DMARC1; ", "p=quarantine;"]],
    });
    expect(await lookupDmarc("d.com", "d.com", resolver)).toEqual({
      status: "found",
      policy: "quarantine",
    });
  });

  it("falls back to the org domain on NXDOMAIN at the subdomain", async () => {
    const resolver = txtResolver({ "_dmarc.d.com": [["v=DMARC1; p=none;"]] });
    expect(await lookupDmarc("mail.d.com", "d.com", resolver)).toEqual({
      status: "found",
      policy: "none",
    });
  });

  it("reads missing when neither level publishes a valid record", async () => {
    const resolver = txtResolver({ "_dmarc.d.com": [["not-dmarc"]] });
    expect(await lookupDmarc("mail.d.com", "d.com", resolver)).toEqual({ status: "missing" });
  });

  it("reads missing at the apex without querying a fallback", async () => {
    let queries = 0;
    const resolver: DnsResolver = {
      resolveTxt: async () => {
        queries += 1;
        return [];
      },
      resolveMx: async () => [],
      resolveCname: async () => [],
    };
    expect(await lookupDmarc("d.com", "d.com", resolver)).toEqual({ status: "missing" });
    expect(queries).toBe(1);
  });

  it("a timeout or SERVFAIL reads unknown, never missing, and skips the fallback", async () => {
    const resolver = txtResolver({
      "_dmarc.mail.d.com": new Error("dns timeout"),
      // A valid org record must NOT rescue an inconclusive subdomain lookup.
      "_dmarc.d.com": [["v=DMARC1; p=none;"]],
    });
    expect(await lookupDmarc("mail.d.com", "d.com", resolver)).toEqual({ status: "unknown" });
  });
});
