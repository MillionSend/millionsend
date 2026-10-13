import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyRecipientDomain,
  createTldExists,
  type UndeliverableReason,
  undeliverableRecipientMessage,
  undeliverableRecipients,
} from "../src/recipient-domains.js";
import { DAY_MS } from "../src/utc-day.js";

const SIMULATOR = "success@simulator.amazonses.com";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("classifyRecipientDomain", () => {
  it.each([
    ["printer.invalid", "reserved_name"],
    ["printer.test", "reserved_name"],
    ["printer.example", "reserved_name"],
    ["printer.localhost", "reserved_name"],
    ["printer.local", "reserved_name"],
    ["printer.onion", "reserved_name"],
    ["printer.alt", "reserved_name"],
    ["printer.internal", "reserved_name"],
    ["localhost", "reserved_name"],
    ["home.arpa", "reserved_name"],
    ["printer.home.arpa", "reserved_name"],
    ["example.com", "documentation_domain"],
    ["example.net", "documentation_domain"],
    ["example.org", "documentation_domain"],
    ["mail.example.com", "documentation_domain"],
    ["a.b.example.net", "documentation_domain"],
    ["host.123", "nonexistent_tld"],
    ["192.0.2.1", "nonexistent_tld"],
    ["gmail.con", "unknown_tld"],
    [`${"a".repeat(63)}.con`, "unknown_tld"],
    ["Printer.TEST.", "reserved_name"],
    ["HOME.ARPA.", "reserved_name"],
    ["Mail.Example.COM.", "documentation_domain"],
    ["HOST.123.", "nonexistent_tld"],
    ["GMAIL.CON.", "unknown_tld"],
  ])("%s → %s", (domain, verdict) => {
    expect(classifyRecipientDomain(domain)).toBe(verdict);
  });

  it.each([
    "uri.arpa",
    "in-addr.arpa",
    "notexample.com",
    "example.com.br",
    // Past 63 characters tldts can't parse the name, and wire validation owns syntax.
    `${"a".repeat(64)}.con`,
    "com",
    "cm",
    "om",
    "co",
    "zip",
    "com.br",
    "xn--p1ai",
    "рф",
    "Example.COM.BR.",
  ])("passes %s", (domain) => {
    expect(classifyRecipientDomain(domain)).toBeNull();
  });
});

describe("undeliverableRecipients", () => {
  beforeEach(() => {
    vi.stubEnv("RECIPIENT_DOMAIN_CHECK", "on");
  });

  it("refuses a TLD the root zone doesn't have", async () => {
    expect(
      await undeliverableRecipients(["x@gmail.con"], { tldExists: async () => false }),
    ).toEqual([{ index: 0, address: "x@gmail.con", reason: "nonexistent_tld" }]);
  });

  it.each<[string, (tld: string) => Promise<boolean>]>([
    ["finds it", async () => true],
    ["rejects", () => Promise.reject(new Error("queryNs ESERVFAIL con."))],
    [
      "throws",
      () => {
        throw new Error("resolver gone");
      },
    ],
  ])("passes an unknown TLD when its lookup %s", async (_, tldExists) => {
    expect(await undeliverableRecipients(["x@gmail.con"], { tldExists })).toEqual([]);
  });

  it("passes an unknown TLD whose lookup outlasts the 2 s deadline", async () => {
    vi.useFakeTimers();
    let settled = false;
    const hits = undeliverableRecipients(["x@gmail.con"], {
      tldExists: () => new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
    }).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(await hits).toEqual([]);
  });

  it("looks up each distinct unknown TLD once", async () => {
    const tldExists = vi.fn(async (tld: string) => tld !== "con");
    expect(
      await undeliverableRecipients(["a@gmail.con", "B@Mail.CON", "c@host.zz", "d@mail.host.zz"], {
        tldExists,
      }),
    ).toEqual([
      { index: 0, address: "a@gmail.con", reason: "nonexistent_tld" },
      { index: 1, address: "b@mail.con", reason: "nonexistent_tld" },
    ]);
    expect(tldExists.mock.calls).toEqual([["con"], ["zz"]]);
  });

  it("settles static verdicts without a lookup", async () => {
    const tldExists = vi.fn(async () => false);
    expect(
      await undeliverableRecipients(
        [SIMULATOR, "x@printer.local", "x@mail.example.com", "x@192.0.2.1"],
        { tldExists },
      ),
    ).toEqual([
      { index: 1, address: "x@printer.local", reason: "reserved_name" },
      { index: 2, address: "x@mail.example.com", reason: "documentation_domain" },
      { index: 3, address: "x@192.0.2.1", reason: "nonexistent_tld" },
    ]);
    expect(tldExists).not.toHaveBeenCalled();
  });

  it("looks up at most 10 unknown TLDs per call; the rest pass", async () => {
    const tldExists = vi.fn(async () => false);
    const hits = await undeliverableRecipients(
      [..."abcdefghijk"].map((c) => `x@host.zz${c}`),
      { tldExists },
    );
    expect(tldExists).toHaveBeenCalledTimes(10);
    expect(hits.map((hit) => hit.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("maps each hit back to its input index", async () => {
    expect(
      await undeliverableRecipients(
        [SIMULATOR, "x@gmail.con", SIMULATOR, "x@printer.local", "x@host.zz"],
        { tldExists: async (tld) => tld !== "con" },
      ),
    ).toEqual([
      { index: 1, address: "x@gmail.con", reason: "nonexistent_tld" },
      { index: 3, address: "x@printer.local", reason: "reserved_name" },
    ]);
  });

  it("refuses nothing with the switch off", async () => {
    vi.stubEnv("RECIPIENT_DOMAIN_CHECK", "off");
    const tldExists = vi.fn(async () => false);
    expect(
      await undeliverableRecipients(["x@printer.local", "x@gmail.con"], { tldExists }),
    ).toEqual([]);
    expect(tldExists).not.toHaveBeenCalled();
  });

  it("passes unparseable input and reads the addr-spec out of a display name", async () => {
    expect(
      await undeliverableRecipients(
        ["not an address", "x@printer.local, y@printer.local", "Ada <Ada@X.TEST>"],
        { tldExists: async () => false },
      ),
    ).toEqual([{ index: 2, address: "ada@x.test", reason: "reserved_name" }]);
  });
});

describe("undeliverableRecipientMessage", () => {
  it.each<[string, UndeliverableReason, string]>([
    [
      "x@printer.local",
      "reserved_name",
      "x@printer.local can never receive mail: .local is a reserved name that internet mail never reaches.",
    ],
    [
      "x@printer.home.arpa",
      "reserved_name",
      "x@printer.home.arpa can never receive mail: home.arpa is a reserved name that internet mail never reaches.",
    ],
    [
      "x@mail.example.com",
      "documentation_domain",
      "x@mail.example.com can never receive mail: example.com is reserved for documentation and accepts no mail.",
    ],
    [
      "x@gmail.con",
      "nonexistent_tld",
      "x@gmail.con can never receive mail: .con is not a top-level domain.",
    ],
  ])("explains %s", (address, reason, message) => {
    expect(undeliverableRecipientMessage({ address, reason })).toBe(message);
    expect(undeliverableRecipientMessage({ address, reason }, { forSend: true })).toBe(
      `${message} To test sending without emailing anyone, use success@simulator.amazonses.com.`,
    );
  });
});

describe("createTldExists", () => {
  const dnsError = (code: string) => Object.assign(new Error(`queryNs ${code} con.`), { code });
  const answer = ["a.nic.example."];

  it.each<[string, () => Promise<unknown>, boolean]>([
    ["NXDOMAIN as missing", () => Promise.reject(dnsError("ENOTFOUND")), false],
    ["an answer as present", async () => answer, true],
    ["NODATA as present", () => Promise.reject(dnsError("ENODATA")), true],
  ])("reads %s", async (_, outcome, exists) => {
    const resolveNs = vi.fn(outcome);
    expect(await createTldExists({ resolveNs })("con")).toBe(exists);
    expect(resolveNs).toHaveBeenCalledWith("con.");
  });

  it("answers a second call from the cache", async () => {
    const resolveNs = vi.fn(() => Promise.reject(dnsError("ENOTFOUND")));
    const exists = createTldExists({ resolveNs });
    expect(await exists("con")).toBe(false);
    expect(await exists("con")).toBe(false);
    expect(resolveNs).toHaveBeenCalledTimes(1);
  });

  it.each(["ESERVFAIL", "ETIMEOUT", "ECONNREFUSED"])(
    "rejects on %s and doesn't cache it",
    async (code) => {
      const resolveNs = vi
        .fn<() => Promise<unknown>>()
        .mockRejectedValueOnce(dnsError(code))
        .mockResolvedValueOnce(answer);
      const exists = createTldExists({ resolveNs });
      await expect(exists("con")).rejects.toMatchObject({ code });
      expect(await exists("con")).toBe(true);
      expect(resolveNs).toHaveBeenCalledTimes(2);
    },
  );

  it("over budget, fails a miss without a lookup or a cache entry, yet still answers from the cache", async () => {
    let spent = false;
    const overBudget = vi.fn(() => spent);
    const resolveNs = vi.fn((name: string) =>
      name === "con." ? Promise.reject(dnsError("ENOTFOUND")) : Promise.resolve(answer),
    );
    const exists = createTldExists({ resolveNs, overBudget });
    expect(await exists("con")).toBe(false);
    spent = true;
    await expect(exists("zz")).rejects.toThrow();
    expect(await exists("con")).toBe(false);
    expect(resolveNs).toHaveBeenCalledTimes(1);
    // Only misses spend the budget.
    expect(overBudget).toHaveBeenCalledTimes(2);
    spent = false;
    expect(await exists("zz")).toBe(true);
    expect(resolveNs).toHaveBeenCalledTimes(2);
  });

  it("looks up again once the day-long TTL runs out", async () => {
    let clock = 0;
    const resolveNs = vi.fn(() => Promise.reject(dnsError("ENOTFOUND")));
    const exists = createTldExists({ resolveNs, now: () => clock });
    await exists("con");
    clock = DAY_MS - 1;
    await exists("con");
    expect(resolveNs).toHaveBeenCalledTimes(1);
    clock = DAY_MS;
    await exists("con");
    expect(resolveNs).toHaveBeenCalledTimes(2);
  });
});
