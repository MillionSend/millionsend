import { readFileSync } from "node:fs";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CT_SPACING_MS,
  createDomainAgeResolver,
  DOMAIN_AGE_USER_AGENT,
  DomainAgeRetryableError,
  domainsAwaitingAge,
  markDomainAgeUnknown,
  parseRegistryDate,
  parseWhoisCreated,
  RDAP_BOOTSTRAP_URL,
  recordDomainAge,
} from "../src/domain-age.js";

// Replies recorded from the live registries on 2026-10-09 (RDAP contacts
// and bootstrap services outside these tests trimmed).
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/domain-age/${name}`, import.meta.url), "utf8");

type Route = { status?: number; body?: string; headers?: Record<string, string> } | "fail";

/** A recorded web: every URL the resolver may ask, and what it heard. */
function fakeWeb(routes: Record<string, Route>) {
  const calls: { url: string; userAgent: string | null }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, userAgent: new Headers(init?.headers).get("user-agent") });
    const route = routes[url];
    if (route === "fail" || route === undefined) throw new TypeError(`fetch failed: ${url}`);
    return new Response(route.body ?? "", {
      status: route.status ?? 200,
      headers: route.headers ?? {},
    });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

/** A recorded port 43: `server query` → reply. */
function fakeWhois(replies: Record<string, string>) {
  const asked: string[] = [];
  const whois = async (server: string, query: string) => {
    asked.push(`${server} ${query}`);
    const reply = replies[`${server} ${query}`];
    if (reply === undefined) throw new Error(`connect ECONNREFUSED ${server}`);
    return reply;
  };
  return { whois, asked };
}

const BOOTSTRAP: Route = { body: fixture("rdap-bootstrap.json") };
const IANA = {
  "whois.iana.org io": fixture("whois-iana-io.txt"),
  "whois.iana.org gg": fixture("whois-iana-gg.txt"),
  "whois.iana.org co": fixture("whois-iana-co.txt"),
  "whois.iana.org de": fixture("whois-iana-de.txt"),
};
const NOW = Date.parse("2026-10-09T16:00:00Z");

/** `routes` stays live: a test may change what a URL answers between lookups. */
function resolver(routes: Record<string, Route>, replies: Record<string, string> = IANA) {
  routes[RDAP_BOOTSTRAP_URL] ??= BOOTSTRAP;
  const web = fakeWeb(routes);
  const port43 = fakeWhois(replies);
  let clock = NOW;
  const slept: number[] = [];
  const r = createDomainAgeResolver({
    fetch: web.fetch,
    whois: port43.whois,
    now: () => clock,
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
  });
  return {
    r,
    web,
    port43,
    slept,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("RDAP", () => {
  it("reads the registration event from the registry the bootstrap names (.com)", async () => {
    const { r, web } = resolver({
      "https://rdap.verisign.com/com/v1/domain/example.com": {
        body: fixture("rdap-example.com.json"),
      },
    });
    expect(await r.lookup("send.example.com")).toEqual({
      domain: "example.com",
      registeredAt: new Date("1995-08-14T04:00:00Z"),
      source: "rdap",
    });
    expect(web.calls.every((c) => c.userAgent === DOMAIN_AGE_USER_AGENT)).toBe(true);
  });

  it("asks for the registrable name under a multi-part suffix (.com.br)", async () => {
    const { r, web } = resolver({
      "https://rdap.registro.br/domain/uol.com.br": { body: fixture("rdap-uol.com.br.json") },
    });
    expect(await r.lookup("news.uol.com.br")).toMatchObject({
      domain: "uol.com.br",
      registeredAt: new Date("1996-04-24T12:00:00Z"),
      source: "rdap",
    });
    expect(web.calls.map((c) => c.url)).toContain("https://rdap.registro.br/domain/uol.com.br");
  });

  it("keeps the bootstrap for a day, then refreshes it", async () => {
    const { r, web, advance } = resolver({
      "https://rdap.verisign.com/com/v1/domain/example.com": {
        body: fixture("rdap-example.com.json"),
      },
    });
    await r.lookup("example.com");
    await r.lookup("example.com");
    const boots = () => web.calls.filter((c) => c.url === RDAP_BOOTSTRAP_URL).length;
    expect(boots()).toBe(1);
    advance(24 * 3600_000);
    await r.lookup("example.com");
    expect(boots()).toBe(2);
  });
});

describe("WHOIS from the registry IANA refers to", () => {
  it(".io: the unofficial RDAP fails, the registry's own reply has the date", async () => {
    const { r, port43 } = resolver(
      { "https://rdap.identitydigital.services/rdap/domain/google.io": { status: 503 } },
      { ...IANA, "whois.nic.io google.io": fixture("whois-google.io.txt") },
    );
    const age = await r.lookup("mail.google.io");
    // IANA's own record says "created: 1997-09-16": the TLD's, never the domain's.
    expect(age).toEqual({
      domain: "google.io",
      registeredAt: new Date("2002-10-01T01:00:00Z"),
      source: "whois",
    });
    expect(port43.asked).toEqual(["whois.iana.org io", "whois.nic.io google.io"]);
  });

  it(".gg: no RDAP at all, and the ordinal date has no colon", async () => {
    const { r } = resolver({}, { ...IANA, "whois.gg google.gg": fixture("whois-google.gg.txt") });
    expect(await r.lookup("google.gg")).toMatchObject({
      registeredAt: new Date("2003-04-30T00:00:00Z"),
      source: "whois",
    });
  });

  it(".co: falls through the override to WHOIS", async () => {
    const { r } = resolver(
      { "https://rdap.registry.co/co/domain/google.co": "fail" },
      { ...IANA, "whois.registry.co google.co": fixture("whois-google.co.txt") },
    );
    expect(await r.lookup("google.co")).toMatchObject({
      registeredAt: new Date("2010-02-25T01:04:59Z"),
      source: "whois",
    });
  });

  it(".de: a reply with no date goes on to Certificate Transparency", async () => {
    const { r, web } = resolver(
      {
        "https://crt.sh/?q=google.de&output=json": {
          body: fixture("crt.sh-millionsend.com.json"),
        },
      },
      { ...IANA, "whois.denic.de google.de": fixture("whois-google.de.txt") },
    );
    expect(parseWhoisCreated(fixture("whois-google.de.txt"))).toBeNull();
    expect(await r.lookup("google.de")).toMatchObject({
      registeredAt: new Date("2021-10-28T14:42:19Z"),
      source: "ct",
    });
    expect(web.calls.at(-1)?.url).toBe("https://crt.sh/?q=google.de&output=json");
  });

  it(".de with no certificate either is unknown, not a retry", async () => {
    const { r } = resolver(
      { "https://crt.sh/?q=google.de&output=json": { body: "[]" } },
      { ...IANA, "whois.denic.de google.de": fixture("whois-google.de.txt") },
    );
    expect(await r.lookup("google.de")).toEqual({
      domain: "google.de",
      registeredAt: null,
      source: "unknown",
    });
  });
});

describe("Certificate Transparency", () => {
  it("takes the first certificate and spaces crt.sh requests", async () => {
    const ct = { body: fixture("crt.sh-millionsend.com.json") };
    const { r, slept } = resolver(
      {
        "https://crt.sh/?q=google.de&output=json": ct,
        "https://crt.sh/?q=heise.de&output=json": ct,
      },
      { ...IANA, "whois.denic.de google.de": "Domain: google.de\n" },
    );
    await r.lookup("google.de");
    // heise.de's WHOIS is down: still a date from CT, after the spacing.
    expect(await r.lookup("heise.de")).toMatchObject({ source: "ct" });
    expect(slept).toEqual([CT_SPACING_MS]);
  });
});

describe("failures", () => {
  it("throws a retryable error when every source failed", async () => {
    const { r } = resolver(
      {
        "https://rdap.verisign.com/com/v1/domain/example.com": { status: 502 },
        "https://crt.sh/?q=example.com&output=json": "fail",
      },
      {},
    );
    await expect(r.lookup("example.com")).rejects.toBeInstanceOf(DomainAgeRetryableError);
  });

  it("honours 429 and Retry-After: the host is left alone until then", async () => {
    const rdapUrl = "https://rdap.verisign.com/com/v1/domain/example.com";
    const routes: Record<string, Route> = {
      [rdapUrl]: { status: 429, headers: { "retry-after": "120" } },
      "https://crt.sh/?q=example.com&output=json": { status: 503 },
    };
    const { r, web, advance } = resolver(routes, {});
    await expect(r.lookup("example.com")).rejects.toBeInstanceOf(DomainAgeRetryableError);
    const asked = () => web.calls.filter((c) => c.url === rdapUrl).length;
    expect(asked()).toBe(1);
    advance(60_000);
    await expect(r.lookup("example.com")).rejects.toBeInstanceOf(DomainAgeRetryableError);
    expect(asked()).toBe(1);
    advance(61_000);
    routes[rdapUrl] = { body: fixture("rdap-example.com.json") };
    expect(await r.lookup("example.com")).toMatchObject({ source: "rdap" });
    expect(asked()).toBe(2);
  });

  it("has nothing to ask for a public suffix", async () => {
    const { r, web } = resolver({});
    expect(await r.lookup("com.br")).toEqual({
      domain: null,
      registeredAt: null,
      source: "unknown",
    });
    expect(web.calls).toHaveLength(0);
  });
});

describe("parseRegistryDate", () => {
  it("reads the shapes registries write, as UTC", () => {
    const cases: [string, string][] = [
      ["2026-10-09T09:18:07Z", "2026-10-09T09:18:07.000Z"],
      ["2026-10-06T13:46:51.742Z", "2026-10-06T13:46:51.000Z"],
      ["2013-03-08T19:41:10+0000", "2013-03-08T19:41:10.000Z"],
      ["2018-03-12T21:44:25+01:00", "2018-03-12T20:44:25.000Z"],
      ["2026-09-24", "2026-09-24T00:00:00.000Z"],
      ["2002.09.19 13:00:00", "2002-09-19T13:00:00.000Z"],
      ["2002-10-22 17:48:23 CLST", "2002-10-22T17:48:23.000Z"],
      ["09/01/2003 00:00:00", "2003-01-09T00:00:00.000Z"],
      ["30th April 2003 at 00:00:00.000", "2003-04-30T00:00:00.000Z"],
      ["13-Dec-1994", "1994-12-13T00:00:00.000Z"],
      ["Tue Dec 12 2000", "2000-12-12T00:00:00.000Z"],
      ["20030901", "2003-09-01T00:00:00.000Z"],
    ];
    for (const [raw, iso] of cases) expect(parseRegistryDate(raw)?.toISOString(), raw).toBe(iso);
    expect(parseRegistryDate("before 1996")).toBeNull();
    expect(parseRegistryDate("2003-02-30")).toBeNull();
  });
});

describe("recordDomainAge", () => {
  let db: Db;
  let close: () => Promise<void>;
  let domainId: string;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    const teamId = await createTeam(db, "age-team");
    const [domain] = await db
      .insert(schema.domains)
      .values({
        teamId,
        name: "send.example.com",
        region: "us-east-1",
        createdAt: new Date("2026-10-01T00:00:00Z"),
      })
      .returning({ id: schema.domains.id });
    if (!domain) throw new Error("domain insert failed");
    domainId = domain.id;
  });
  afterAll(() => close());

  const row = async () =>
    (
      await db
        .select({
          registeredAt: schema.domains.registeredAt,
          ageSource: schema.domains.ageSource,
          ageCheckedAt: schema.domains.ageCheckedAt,
        })
        .from(schema.domains)
        .where(eq(schema.domains.id, domainId))
    )[0];

  it("stores the date, its source and the check; a later dateless answer keeps it", async () => {
    const later = new Date("2026-10-09T12:00:00Z");
    expect(await domainsAwaitingAge(db, later)).toEqual([domainId]);
    const found = resolver({
      "https://rdap.verisign.com/com/v1/domain/example.com": {
        body: fixture("rdap-example.com.json"),
      },
    });
    const checkedAt = new Date("2026-10-09T13:00:00Z");
    await recordDomainAge(db, found.r, domainId, checkedAt);
    expect(await row()).toEqual({
      registeredAt: new Date("1995-08-14T04:00:00Z"),
      ageSource: "rdap",
      ageCheckedAt: checkedAt,
    });
    expect(await domainsAwaitingAge(db, later)).toEqual([]);

    await recordDomainAge(
      db,
      { lookup: async () => ({ domain: "example.com", registeredAt: null, source: "unknown" }) },
      domainId,
    );
    expect(await row()).toMatchObject({
      registeredAt: new Date("1995-08-14T04:00:00Z"),
      ageSource: "rdap",
    });
    await markDomainAgeUnknown(db, domainId);
    expect((await row())?.ageSource).toBe("rdap");
  });
});
