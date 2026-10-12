import { isIP } from "node:net";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { inArray } from "drizzle-orm";
import { type AsnResponse, type CountryResponse, Reader } from "mmdb-lib";
import { errorSummary } from "./error-summary.js";
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
/** Decoded records each open database keeps, so a crafted file cannot make every lookup re-walk it. */
const READER_CACHE_ENTRIES = 5000;

/**
 * Networks whose addresses many unrelated people share at once, so one IP
 * there says nothing about who used it: Cloudflare (AS13335, its WARP VPN
 * and an iCloud Private Relay egress), the other two Private Relay egress
 * operators, Akamai (AS36183) and Fastly (AS54113), and the big Brazilian
 * carriers behind carrier-grade NAT: Vivo (AS26599), Claro (AS28573) and
 * TIM (AS26615).
 */
export const SHARED_EGRESS_ASNS: ReadonlySet<number> = new Set([
  13335, 36183, 54113, 26599, 28573, 26615,
]);

/** Public resolvers every real database places: a file that knows none of them is not one. */
const SAMPLE_IPS = ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111", "2001:4860:4860::8888"];

/** What each file must call itself, and what a known address must look like in it. */
const EXPECTED: Record<IpGeoName, { type: RegExp; knows: (record: unknown) => boolean }> = {
  dbip_country: {
    type: /country/i,
    knows: (record) => typeof (record as CountryResponse | null)?.country?.iso_code === "string",
  },
  dbip_asn: {
    type: /asn/i,
    knows: (record) => typeof (record as AsnResponse | null)?.autonomous_system_number === "number",
  },
};

const gunzipAsync = promisify(gunzip);

/** A FIFO-bounded cache in the shape mmdb-lib asks for. */
function boundedCache(): {
  get(key: string | number): unknown;
  set(key: string | number, value: unknown): void;
} {
  const entries = new Map<string | number, unknown>();
  return {
    get: (key) => entries.get(key),
    set: (key, value) => {
      if (entries.size >= READER_CACHE_ENTRIES) {
        const oldest = entries.keys().next();
        if (!oldest.done) entries.delete(oldest.value);
      }
      entries.set(key, value);
    },
  };
}

function open<T extends CountryResponse | AsnResponse>(bytes: Buffer): Reader<T> {
  return new Reader<T>(bytes, { cache: boundedCache() });
}

/** A download as it will be stored: unpacked, and opened and asked about known addresses first. */
async function unpacked(name: IpGeoName, gzipped: Buffer): Promise<Buffer> {
  const bytes = await gunzipAsync(gzipped, { maxOutputLength: MAX_DATABASE_BYTES });
  const reader = open(bytes);
  const expected = EXPECTED[name];
  if (!expected.type.test(reader.metadata.databaseType ?? "")) {
    throw new Error(`not a ${name} database: ${String(reader.metadata.databaseType).slice(0, 60)}`);
  }
  if (!SAMPLE_IPS.some((ip) => expected.knows(reader.get(ip)))) {
    throw new Error(`${name} knows none of the sample addresses`);
  }
  return bytes;
}

/** A month's file: https://download.db-ip.com/free/dbip-asn-lite-2026-10.mmdb.gz */
export function dbipUrl(file: string, month: string): string {
  return `https://download.db-ip.com/free/${file}-${month}.mmdb.gz`;
}

const monthOf = (date: Date): string => date.toISOString().slice(0, 7);

/**
 * Brings each database to the newest month DB-IP has published: this
 * month's file, else last month's, since the new one appears some time
 * after the month starts. A copy already at that month is left alone. The
 * download is unpacked here, in the worker, and stored only once it opens
 * as the database it should be and places known addresses; anything else
 * leaves the stored copy as it was. Returns the month each database now
 * holds, or null for none.
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
        const bytes = await unpacked(name, await download(url));
        await storeReferenceData(db, { name, version: month, content: bytes, now });
        held[name] = month;
        break;
      } catch (err) {
        console.warn(
          `ip-geo: ${url} not stored, keeping ${held[name] ?? "nothing"}: ${errorSummary(err)}`,
        );
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

/** A stored database opened as stored, or null when it does not open. */
function opened<T extends CountryResponse | AsnResponse>(
  name: IpGeoName,
  content: Uint8Array | undefined,
): Reader<T> | null {
  if (!content) return null;
  try {
    return open<T>(Buffer.from(content));
  } catch (err) {
    console.warn(`ip-geo: stored ${name} does not open: ${errorSummary(err)}`);
    return null;
  }
}

/** The stored databases, opened once per stored version; nothing is unpacked here. */
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
  const fresh: Readers = {
    versions,
    country: opened<CountryResponse>("dbip_country", content("dbip_country")),
    asn: opened<AsnResponse>("dbip_asn", content("dbip_asn")),
  };
  readers.set(db, fresh);
  return fresh;
}

/** One lookup that a damaged database turns into "unknown" instead of an error. */
function lookup<T extends CountryResponse | AsnResponse>(
  reader: Reader<T> | null,
  ip: string,
): T | null {
  if (!reader) return null;
  try {
    return reader.get(ip);
  } catch {
    return null;
  }
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
    const place = lookup(country, ip);
    const network = lookup(asn, ip);
    // Typed by the file, not by mmdb-lib: a record may hold anything.
    const code = place?.country?.iso_code ?? place?.registered_country?.iso_code;
    const number = network?.autonomous_system_number;
    const org = network?.autonomous_system_organization;
    out.set(ip, {
      country: typeof code === "string" ? code : null,
      asn: typeof number === "number" ? number : null,
      org: typeof org === "string" ? org : null,
    });
  }
  return out;
}

/** The IPs that sit on a shared egress network (SHARED_EGRESS_ASNS); none without a stored ASN database. */
export async function sharedEgressIps(db: Db, ips: readonly string[]): Promise<Set<string>> {
  const geo = await lookupIpGeo(db, ips);
  return new Set(
    [...geo].flatMap(([ip, { asn }]) => (asn !== null && SHARED_EGRESS_ASNS.has(asn) ? [ip] : [])),
  );
}
