import { describe, expect, it } from "vitest";
import {
  checkDnsRecords,
  checkDnsRecordsDetailed,
  type DnsResolver,
  parseMxData,
  parseTxtData,
  resolvePublicFirst,
} from "../src/dns-check.js";

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

  it("never throws: a timeout reads unknown (inconclusive), NXDOMAIN reads missing", async () => {
    const throwing: DnsResolver = {
      resolveTxt: async () => {
        throw new Error("timeout");
      },
      resolveMx: async () => {
        throw Object.assign(new Error("nxdomain"), { code: "ENOTFOUND" });
      },
      resolveCname: async () => {
        throw Object.assign(new Error("nodata"), { code: "ENODATA" });
      },
    };
    const out = await checkDnsRecords(
      [
        { type: "TXT", name: "a", value: '"x"' },
        { type: "MX", name: "b", value: "m" },
        { type: "CNAME", name: "c", value: "t" },
      ],
      throwing,
    );
    expect(out).toEqual(["unknown", "missing", "missing"]);
  });

  it("a mismatch carries what the name answered instead", async () => {
    const resolver: DnsResolver = {
      resolveTxt: async () => [["v=spf1 include:other ~all"], ["v=DKIM1; k=rsa; ", "p=OLD"]],
      resolveMx: async () => [{ priority: 20, exchange: "mx.other.example." }],
      resolveCname: async () => ["elsewhere.example."],
    };
    const [txt, mx, cname] = await checkDnsRecordsDetailed(
      [
        { type: "TXT", name: "a", value: '"v=DKIM1; k=rsa; p=NEW"' },
        { type: "MX", name: "b", value: "feedback-smtp.us-east-1.amazonses.com", priority: 10 },
        { type: "CNAME", name: "c", value: "app.example.com" },
      ],
      resolver,
    );
    expect(txt).toEqual({
      status: "mismatch",
      found: "v=spf1 include:other ~all\nv=DKIM1; k=rsa; p=OLD",
    });
    expect(mx).toEqual({ status: "mismatch", found: "20 mx.other.example" });
    expect(cname).toEqual({ status: "mismatch", found: "elsewhere.example" });
    // A hit never carries an answer list.
    expect(
      await checkDnsRecordsDetailed(
        [{ type: "CNAME", name: "c", value: "elsewhere.example" }],
        resolver,
      ),
    ).toEqual([{ status: "found" }]);
  });

  it("reads an unanswered name as missing", async () => {
    const [status] = await checkDnsRecords([{ type: "TXT", name: "a", value: '"x"' }], empty);
    expect(status).toBe("missing");
  });
});

describe("resolvePublicFirst", () => {
  it("falls back to the system resolver only on inconclusive public failures", async () => {
    const timeout = () => Promise.reject(Object.assign(new Error("timeout"), { code: "ETIMEOUT" }));
    const nxdomain = () =>
      Promise.reject(Object.assign(new Error("nxdomain"), { code: "ENOTFOUND" }));
    const system = async () => ["from-system"];

    expect(await resolvePublicFirst(async () => ["from-public"], system)).toEqual(["from-public"]);
    expect(await resolvePublicFirst(timeout, system)).toEqual(["from-system"]);
    // A conclusive "no such record" from the public resolver is the answer.
    await expect(resolvePublicFirst(nxdomain, system)).rejects.toMatchObject({ code: "ENOTFOUND" });
  });
});

describe("DoH answer parsing", () => {
  it("rejoins split TXT strings, unescapes quotes, and reads MX priority/exchange", () => {
    expect(parseTxtData('"v=DKIM1; k=rsa; " "p=MIIB"')).toEqual(["v=DKIM1; k=rsa; ", "p=MIIB"]);
    expect(parseTxtData('"a \\"quoted\\" bit"')).toEqual(['a "quoted" bit']);
    expect(parseTxtData("bare")).toEqual(["bare"]);
    expect(parseMxData("10 feedback-smtp.sa-east-1.amazonses.com.")).toEqual({
      priority: 10,
      exchange: "feedback-smtp.sa-east-1.amazonses.com",
    });
  });
});

describe("a proxied CNAME", () => {
  const nodata = () => Promise.reject(Object.assign(new Error("ENODATA"), { code: "ENODATA" }));
  it("reads as a mismatch naming the addresses when the resolver can look them up", async () => {
    const resolver: DnsResolver = {
      resolveTxt: async () => [],
      resolveMx: async () => [],
      resolveCname: nodata,
      resolveA: async () => ["104.21.55.1", "172.67.140.2"],
    };
    const [check] = await checkDnsRecordsDetailed(
      [{ type: "CNAME", name: "links.news.example.com", value: "t.example-dns.com" }],
      resolver,
    );
    expect(check).toEqual({ status: "mismatch", found: "104.21.55.1\n172.67.140.2" });
  });
  it("stays missing for a resolver without address lookups, and when no address exists either", async () => {
    const bare: DnsResolver = {
      resolveTxt: async () => [],
      resolveMx: async () => [],
      resolveCname: nodata,
    };
    expect(await checkDnsRecords([{ type: "CNAME", name: "c", value: "t" }], bare)).toEqual([
      "missing",
    ]);
    const empty: DnsResolver = { ...bare, resolveA: nodata };
    expect(await checkDnsRecords([{ type: "CNAME", name: "c", value: "t" }], empty)).toEqual([
      "missing",
    ]);
  });
});
