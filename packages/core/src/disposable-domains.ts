import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import { storeReferenceData } from "./reference-data.js";
import { getBytes } from "./ssrf.js";

/**
 * The disposable-email-domains list (public domain, CC0): one domain per
 * line, updated upstream almost daily. The app ships a copy; the worker
 * keeps a fresher one in reference_data.
 */
export const DISPOSABLE_LIST_URL =
  "https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/main/disposable_email_blocklist.conf";

const NAME = "disposable_domains";
/** Fewer than this is a broken download, not a list: the last good copy stays. */
const MIN_DOMAINS = 1000;
const MAX_LIST_BYTES = 8 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;
// Under a day, so a daily run never skips a day; a restart within it downloads nothing.
const FRESH_FOR_MS = 20 * 3600_000;
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** The list's lines that are domains, lowercased; comments, blanks and anything else are left out. */
export function parseDomainList(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim().toLowerCase())
    .filter((line) => DOMAIN.test(line));
}

/** True when the domain or any parent of it is listed: sub.mailinator.com counts as mailinator.com. */
export function isListedDomain(domain: string, list: ReadonlySet<string>): boolean {
  const labels = domain.trim().toLowerCase().replace(/\.$/, "").split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    if (list.has(labels.slice(i).join("."))) return true;
  }
  return false;
}

/**
 * Downloads the list unless the stored copy is under a day old. A download
 * that fails, or parses to too few domains, leaves the stored copy as it
 * was. Returns what happened.
 */
export async function refreshDisposableDomains(
  db: Db,
  deps: { download?: (url: string) => Promise<Buffer>; now?: Date } = {},
): Promise<"fresh" | "stored" | "kept"> {
  const now = deps.now ?? new Date();
  const r = schema.referenceData;
  const [stored] = await db.select({ fetchedAt: r.fetchedAt }).from(r).where(eq(r.name, NAME));
  if (stored && now.getTime() - stored.fetchedAt.getTime() < FRESH_FOR_MS) return "fresh";
  const download =
    deps.download ??
    ((url: string) => getBytes(url, { maxBytes: MAX_LIST_BYTES, timeoutMs: DOWNLOAD_TIMEOUT_MS }));
  try {
    const domains = parseDomainList((await download(DISPOSABLE_LIST_URL)).toString("utf8"));
    if (domains.length < MIN_DOMAINS) {
      throw new Error(`the list parsed to ${domains.length} domains`);
    }
    await storeReferenceData(db, {
      name: NAME,
      version: now.toISOString(),
      content: Buffer.from(domains.join("\n"), "utf8"),
      now,
    });
    return "stored";
  } catch (err) {
    console.warn("disposable domains: list not refreshed, keeping the last good copy", err);
    return "kept";
  }
}

// Per database handle, so tests on separate databases never share a list.
const storedLists = new WeakMap<Db, { version: string; domains: Set<string> }>();

/** The newest list: the worker's stored copy when there is one, else the copy the app ships. */
export async function disposableDomains(
  db: Db,
  shipped: ReadonlySet<string>,
): Promise<ReadonlySet<string>> {
  const r = schema.referenceData;
  const [row] = await db.select({ version: r.version }).from(r).where(eq(r.name, NAME));
  if (!row) return shipped;
  const cached = storedLists.get(db);
  if (cached?.version === row.version) return cached.domains;
  const [full] = await db.select({ content: r.content }).from(r).where(eq(r.name, NAME));
  // Buffer.from: some drivers hand bytea back as a plain Uint8Array.
  const domains = new Set(parseDomainList(Buffer.from(full?.content ?? []).toString("utf8")));
  storedLists.set(db, { version: row.version, domains });
  return domains;
}
