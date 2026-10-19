import { describe, expect, it } from "vitest";
import type { DnsResolver } from "../src/dns-check.js";
import { checkReceivingMx, receivingDnsRecord } from "../src/receiving-dns.js";

const MX_HOST = "mx.millionsend-dns.com";

function resolver(resolveMx: DnsResolver["resolveMx"]): DnsResolver {
  return { resolveTxt: async () => [], resolveCname: async () => [], resolveMx };
}

describe("receiving DNS record", () => {
  it("is an MX at the domain's own name, priority 10", () => {
    expect(receivingDnsRecord("inbound.acme.test", MX_HOST)).toEqual({
      type: "MX",
      name: "inbound.acme.test",
      value: MX_HOST,
      priority: 10,
    });
  });

  it("reads found only when our host is among the lowest-preference MX hosts", async () => {
    const at = (rows: { priority: number; exchange: string }[]) =>
      checkReceivingMx(
        "inbound.acme.test",
        MX_HOST,
        resolver(async () => rows),
      );
    expect(await at([{ priority: 10, exchange: "MX.millionsend-dns.com." }])).toEqual({
      status: "found",
    });
    // Any priority works while it is the lowest, ties included.
    expect(
      await at([
        { priority: 5, exchange: MX_HOST },
        { priority: 5, exchange: "backup.example.net" },
      ]),
    ).toEqual({ status: "found" });
    expect(
      await at([
        { priority: 20, exchange: MX_HOST },
        { priority: 10, exchange: "aspmx.l.google.com." },
      ]),
    ).toEqual({ status: "mismatch", found: "10 aspmx.l.google.com\n20 mx.millionsend-dns.com" });
    expect(await at([])).toEqual({ status: "missing" });
  });

  it("tells a conclusive absence from a lookup that failed", async () => {
    const failing = (code: string) =>
      checkReceivingMx(
        "inbound.acme.test",
        MX_HOST,
        resolver(async () => {
          throw Object.assign(new Error(code), { code });
        }),
      );
    expect(await failing("ENOTFOUND")).toEqual({ status: "missing" });
    expect(await failing("ESERVFAIL")).toEqual({ status: "unknown" });
  });
});
