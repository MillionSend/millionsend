import { gzipSync } from "node:zlib";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { Reader } from "mmdb-lib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dbipUrl, lookupIpGeo, refreshIpGeoDatabases, sharedEgressIps } from "../src/ip-geo.js";
import { storeReferenceData } from "../src/reference-data.js";
import { writeMmdb } from "./fixtures/mmdb.js";

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(() => close());

const countryDb = (code: string) =>
  writeMmdb("DBIP-Country-Lite", [
    ["1.1.1.0/24", { country: { iso_code: "AU" } }],
    ["203.0.113.0/24", { country: { iso_code: code } }],
    ["2001:db8::/32", { country: { iso_code: "BR" } }],
  ]);
const asnDb = (org: string) =>
  writeMmdb("DBIP-ASN-Lite (compat=GeoLite2-ASN)", [
    [
      "1.1.1.0/24",
      { autonomous_system_number: 13335, autonomous_system_organization: "Cloudflare" },
    ],
    ["203.0.113.0/24", { autonomous_system_number: 64500, autonomous_system_organization: org }],
    ["2001:db8::/32", { autonomous_system_number: 28573, autonomous_system_organization: "Claro" }],
  ]);

/** DB-IP as a map of published URLs; anything else answers 404, as a missing month does. */
function fakeDbip(files: Record<string, Buffer>) {
  const asked: string[] = [];
  return {
    asked,
    download: async (url: string) => {
      asked.push(url);
      const file = files[url];
      if (!file) throw new Error(`${url} answered 404`);
      return file;
    },
  };
}

const OCT = new Date("2026-10-11T05:10:00Z");
const october = (country: Buffer, asn: Buffer) =>
  fakeDbip({
    [dbipUrl("dbip-country-lite", "2026-10")]: gzipSync(country),
    [dbipUrl("dbip-asn-lite", "2026-10")]: gzipSync(asn),
  });

async function storedContent(name: string) {
  const [row] = await db
    .select({ version: schema.referenceData.version, content: schema.referenceData.content })
    .from(schema.referenceData)
    .where(eq(schema.referenceData.name, name));
  return row ?? null;
}

describe("refreshIpGeoDatabases", () => {
  it("stores this month's files unpacked and looks IPs up in them, IPv4 and IPv6", async () => {
    const dbip = october(countryDb("NL"), asnDb("Example Net"));
    expect(await refreshIpGeoDatabases(db, { download: dbip.download, now: OCT })).toEqual({
      dbip_country: "2026-10",
      dbip_asn: "2026-10",
    });
    // Unpacked in the worker: the web never gunzips a stored file.
    expect(
      Buffer.from((await storedContent("dbip_asn"))?.content ?? []).equals(asnDb("Example Net")),
    ).toBe(true);
    const geo = await lookupIpGeo(db, ["203.0.113.9", "2001:db8::7", "198.51.100.1", "nonsense"]);
    expect(Object.fromEntries(geo)).toEqual({
      "203.0.113.9": { country: "NL", asn: 64500, org: "Example Net" },
      "2001:db8::7": { country: "BR", asn: 28573, org: "Claro" },
      "198.51.100.1": { country: null, asn: null, org: null },
    });

    // Already at this month: nothing is downloaded again.
    dbip.asked.length = 0;
    await refreshIpGeoDatabases(db, { download: dbip.download, now: OCT });
    expect(dbip.asked).toEqual([]);
  });

  it("falls back to last month's files before this month's are published", async () => {
    const dbip = fakeDbip({
      [dbipUrl("dbip-country-lite", "2026-09")]: gzipSync(countryDb("DE")),
      [dbipUrl("dbip-asn-lite", "2026-09")]: gzipSync(asnDb("Deutsche Telekom")),
    });
    expect(await refreshIpGeoDatabases(db, { download: dbip.download, now: OCT })).toEqual({
      dbip_country: "2026-09",
      dbip_asn: "2026-09",
    });
    expect((await lookupIpGeo(db, ["203.0.113.9"])).get("203.0.113.9")).toEqual({
      country: "DE",
      asn: 64500,
      org: "Deutsche Telekom",
    });
  });

  it("keeps the last good copy when a download fails, is not a database, or is the wrong one", async () => {
    await refreshIpGeoDatabases(db, {
      download: fakeDbip({
        [dbipUrl("dbip-country-lite", "2026-09")]: gzipSync(countryDb("NL")),
        [dbipUrl("dbip-asn-lite", "2026-09")]: gzipSync(asnDb("Example Net")),
      }).download,
      now: OCT,
    });
    const bad = [
      // Not gzip, and gzip that holds no database.
      october(Buffer.from("<html>maintenance</html>"), Buffer.from("x")),
      fakeDbip({
        [dbipUrl("dbip-country-lite", "2026-10")]: gzipSync(
          Buffer.from("<html>maintenance</html>"),
        ),
        [dbipUrl("dbip-asn-lite", "2026-10")]: Buffer.from("not gzip"),
      }),
      // Each file in the other's place.
      october(asnDb("Example Net"), countryDb("NL")),
      // The right type, but it knows none of the public resolvers.
      october(
        writeMmdb("DBIP-Country-Lite", [["203.0.113.0/24", { country: { iso_code: "NL" } }]]),
        writeMmdb("DBIP-ASN-Lite", [
          ["203.0.113.0/24", { autonomous_system_number: 1, autonomous_system_organization: "X" }],
        ]),
      ),
    ];
    for (const dbip of bad) {
      expect(await refreshIpGeoDatabases(db, { download: dbip.download, now: OCT })).toEqual({
        dbip_country: "2026-09",
        dbip_asn: "2026-09",
      });
    }
    expect((await lookupIpGeo(db, ["203.0.113.9"])).get("203.0.113.9")?.org).toBe("Example Net");
  });

  it("answers nulls with no database stored, or one that breaks on a lookup", async () => {
    expect((await lookupIpGeo(db, ["203.0.113.9"])).get("203.0.113.9")).toEqual({
      country: null,
      asn: null,
      org: null,
    });
    // The one record's first byte names a type that does not exist.
    const broken = writeMmdb("DBIP-ASN-Lite", [
      ["203.0.113.0/24", { autonomous_system_number: 64500, autonomous_system_organization: "X" }],
    ]);
    broken[new Reader(broken).metadata.searchTreeSize + 16] = 0;
    expect(() => new Reader(broken).get("203.0.113.9")).toThrow();
    await storeReferenceData(db, { name: "dbip_asn", version: "2026-10", content: broken });
    await storeReferenceData(db, {
      name: "dbip_country",
      version: "2026-10",
      content: Buffer.from("garbage"),
    });
    expect((await lookupIpGeo(db, ["203.0.113.9"])).get("203.0.113.9")).toEqual({
      country: null,
      asn: null,
      org: null,
    });
  });
});

describe("sharedEgressIps", () => {
  it("names the IPs on networks shared by crowds, by the stored ASN database", async () => {
    expect(await sharedEgressIps(db, ["1.1.1.1", "203.0.113.9"])).toEqual(new Set());
    await refreshIpGeoDatabases(db, {
      download: october(countryDb("NL"), asnDb("Example Net")).download,
      now: OCT,
    });
    expect(await sharedEgressIps(db, ["1.1.1.1", "203.0.113.9", "2001:db8::7"])).toEqual(
      new Set(["1.1.1.1", "2001:db8::7"]),
    );
  });
});
