import { isIP } from "node:net";
import { gunzipSync } from "node:zlib";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { inArray } from "drizzle-orm";
import { type AsnResponse, type CountryResponse, Reader } from "mmdb-lib";
import { storeReferenceData } from "./reference-data.js";
import { getBytes } from "./ssrf.js";

/**
 * DB-IP's free "Lite" databases, under CC BY 4.0: wherever their data is
 * shown, DB-IP is credited. Both are published monthly as gzipped MaxMind DB
 * files that need no account.
 */
export const IP_GEO_FILES = {
  dbip_country: "dbip-country-lite",
  dbip_asn: "dbip-asn-lite",
} as const;

type IpGeoName = keyof typeof IP_GEO_FILES;
const NAMES = Object.keys(IP_GEO_FILES) as IpGeoName[];

const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const MAX_DATABASE_BYTES = 256 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** A month's file: https://download.db-ip.com/free/dbip-asn-lite-2026-10.mmdb.gz */
export function dbipUrl(file: string, month: string): string {
  return `https://download.db-ip.com/free/${file}-${month}.mmdb.gz`;
}

const monthOf = (date: Date): string => date.toISOString().slice(0, 7);

function open<T extends CountryResponse | AsnResponse>(gzipped: Buffer): Reader<T> {
  return new Reader<T>(gunzipSync(gzipped, { maxOutputLength: MAX_DATABASE_BYTES }));
}

/**
 * Brings each database to the newest month DB-IP has published: this
 * month's file, else last month's, since the new one appears some time
 * after the month starts. A copy already at that month is left alone, and a
 * download that fails or does not open as a database leaves the stored copy
 * as it was. Returns the month each database now holds, or null for none.
 */
export async function refreshIpGeoDatabases(
  db: Db,
  deps: { download?: (url: string) => Promise<Buffer>; now?: Date } = {},
): Promise<Record<IpGeoName, string | null>> {
  const download =
    deps.download ??
    ((url: string) =>
      getBytes(url, { maxBytes: MAX_DOWNLOAD_BYTES, timeoutMs: DOWNLOAD_TIMEOUT_MS }));
  const now = deps.now ?? new Date();
  const months = [
    monthOf(now),
    monthOf(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))),
  ];
  const r = schema.referenceData;
  const stored = new Map(
    (
      await db.select({ name: r.name, version: r.version }).from(r).where(inArray(r.name, NAMES))
    ).map((row) => [row.name, row.version]),
  );
  const held = {} as Record<IpGeoName, string | null>;
  for (const name of NAMES) {
    held[name] = stored.get(name) ?? null;
    for (const month of months) {
      if (held[name] === month) break;
      const url = dbipUrl(IP_GEO_FILES[name], month);
      try {
        const gzipped = await download(url);
        open(gzipped);
        await storeReferenceData(db, { name, version: month, content: gzipped, now });
        held[name] = month;
        break;
      } catch (err) {
        console.warn(`ip-geo: ${url} not stored, keeping ${held[name] ?? "nothing"}`, err);
      }
    }
  }
  return held;
}

export interface IpGeo {
  /** ISO 3166 alpha-2. */
  country: string | null;
  asn: number | null;
  org: string | null;
}

interface Readers {
  versions: string;
  country: Reader<CountryResponse> | null;
  asn: Reader<AsnResponse> | null;
}

// Per database handle, so tests on separate databases never share a reader.
const readers = new WeakMap<Db, Readers>();

/** The stored databases, opened once per stored version. */
async function storedReaders(db: Db): Promise<Readers> {
  const r = schema.referenceData;
  const versions = (
    await db.select({ name: r.name, version: r.version }).from(r).where(inArray(r.name, NAMES))
  )
    .map((row) => `${row.name}:${row.version}`)
    .sort()
    .join(",");
  const cached = readers.get(db);
  if (cached?.versions === versions) return cached;
  const rows = await db
    .select({ name: r.name, content: r.content })
    .from(r)
    .where(inArray(r.name, NAMES));
  const content = (name: IpGeoName) => rows.find((row) => row.name === name)?.content;
  const country = content("dbip_country");
  const asn = content("dbip_asn");
  const opened: Readers = {
    versions,
    country: country ? open<CountryResponse>(country) : null,
    asn: asn ? open<AsnResponse>(asn) : null,
  };
  readers.set(db, opened);
  return opened;
}

/**
 * Network and country of each IP, read from the local copies alone: no IP
 * leaves the instance. An IP neither database knows maps to nulls; one that
 * is not an address is left out.
 */
export async function lookupIpGeo(db: Db, ips: readonly string[]): Promise<Map<string, IpGeo>> {
  const out = new Map<string, IpGeo>();
  const valid = [...new Set(ips)].filter((ip) => isIP(ip) !== 0);
  if (valid.length === 0) return out;
  const { country, asn } = await storedReaders(db);
  for (const ip of valid) {
    const place = country?.get(ip);
    const network = asn?.get(ip);
    out.set(ip, {
      country: place?.country?.iso_code ?? place?.registered_country?.iso_code ?? null,
      asn: network?.autonomous_system_number ?? null,
      org: network?.autonomous_system_organization ?? null,
    });
  }
  return out;
}
