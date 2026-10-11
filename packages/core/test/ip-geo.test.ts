import { gzipSync } from "node:zlib";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTestDb } from "@millionsend/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dbipUrl, lookupIpGeo, refreshIpGeoDatabases } from "../src/ip-geo.js";
import { writeMmdb } from "./fixtures/mmdb.js";

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(() => close());

const country = (code: string) =>
  gzipSync(
    writeMmdb("DBIP-Country-Lite", [
      ["203.0.113.0/24", { country: { iso_code: code } }],
      ["2001:db8::/32", { country: { iso_code: "BR" } }],
    ]),
  );
const asn = (org: string) =>
  gzipSync(
    writeMmdb("DBIP-ASN-Lite (compat=GeoLite2-ASN)", [
      ["203.0.113.0/24", { autonomous_system_number: 64500, autonomous_system_organization: org }],
      [
        "2001:db8::/32",
        { autonomous_system_number: 28573, autonomous_system_organization: "Claro" },
      ],
    ]),
  );

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

describe("refreshIpGeoDatabases", () => {
  it("stores this month's files and looks IPs up in them, IPv4 and IPv6", async () => {
    const dbip = fakeDbip({
      [dbipUrl("dbip-country-lite", "2026-10")]: country("FR"),
      [dbipUrl("dbip-asn-lite", "2026-10")]: asn("Example Net"),
    });
    expect(await refreshIpGeoDatabases(db, { download: dbip.download, now: OCT })).toEqual({
      dbip_country: "2026-10",
      dbip_asn: "2026-10",
    });
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
      [dbipUrl("dbip-country-lite", "2026-09")]: country("DE"),
      [dbipUrl("dbip-asn-lite", "2026-09")]: asn("Deutsche Telekom"),
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

  it("keeps the last good copy when a download fails or is not a database", async () => {
    await refreshIpGeoDatabases(db, {
      download: fakeDbip({
        [dbipUrl("dbip-country-lite", "2026-09")]: country("FR"),
        [dbipUrl("dbip-asn-lite", "2026-09")]: asn("Example Net"),
      }).download,
      now: OCT,
    });
    const broken = fakeDbip({
      [dbipUrl("dbip-country-lite", "2026-10")]: gzipSync(Buffer.from("<html>maintenance</html>")),
      [dbipUrl("dbip-asn-lite", "2026-10")]: Buffer.from("not gzip"),
    });
    expect(await refreshIpGeoDatabases(db, { download: broken.download, now: OCT })).toEqual({
      dbip_country: "2026-09",
      dbip_asn: "2026-09",
    });
    const rows = await db
      .select({ name: schema.referenceData.name, version: schema.referenceData.version })
      .from(schema.referenceData);
    expect(rows.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: "dbip_asn", version: "2026-09" },
      { name: "dbip_country", version: "2026-09" },
    ]);
    expect((await lookupIpGeo(db, ["203.0.113.9"])).get("203.0.113.9")?.org).toBe("Example Net");
  });

  it("answers nulls with no database stored", async () => {
    expect((await lookupIpGeo(db, ["203.0.113.9"])).get("203.0.113.9")).toEqual({
      country: null,
      asn: null,
      org: null,
    });
  });
});
