import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, inArray } from "drizzle-orm";
import { sha256Hex } from "./hash.js";
import { parseMailbox } from "./sender-address.js";

/**
 * Reduce an RFC 5322 recipient to its bare addr-spec: `Bob <bob@x.com>` and
 * `bob@x.com` must hash identically, or a display-name send would slip past
 * a suppression recorded from SES's bare-address bounce report. Strict
 * single-mailbox parsing first; the last-angle-addr fallback only serves rows
 * stored before every accept surface enforced that parser.
 */
export function extractAddrSpec(recipient: string): string {
  const parsed = parseMailbox(recipient);
  if (parsed) return parsed.address;
  const angle = /<([^<>]+)>\s*$/.exec(recipient.trim());
  return (angle?.[1] ?? recipient).trim();
}

/**
 * Canonical identity form of an addr-spec: NFKC (fullwidth/compatibility
 * lookalikes collapse), lowercase, trailing root dot dropped. Plus-tags are
 * kept — `bob+1@x.com` is a distinct mailbox to the receiving MTA.
 */
export function normalizeAddress(address: string): string {
  return address.normalize("NFKC").toLowerCase().replace(/\.$/, "");
}

/**
 * Normalization before hashing: addr-spec + normalizeAddress. The hash — not
 * the address — is the stable identity, because erasure nulls the address
 * column while the suppression must keep working.
 */
export function hashRecipient(email: string): string {
  return sha256Hex(normalizeAddress(extractAddrSpec(email)));
}

/**
 * Hash form written before normalizeAddress existed (trim + lowercase only).
 * Lookups check it alongside the current hash so existing suppressions keep
 * matching; nothing writes it anymore.
 */
function legacyHashRecipient(email: string): string {
  return sha256Hex(extractAddrSpec(email).toLowerCase());
}

/** Returns the subset of `recipients` that are suppressed for this team. */
export async function findSuppressed(
  db: Db,
  teamId: string,
  recipients: readonly string[],
): Promise<Set<string>> {
  if (recipients.length === 0) return new Set();
  const t = schema.suppressions;
  const hashesByRecipient = new Map(
    recipients.map((r) => [r, [...new Set([hashRecipient(r), legacyHashRecipient(r)])]]),
  );
  const rows = await db
    .select({ emailHash: t.emailHash })
    .from(t)
    .where(and(eq(t.teamId, teamId), inArray(t.emailHash, [...hashesByRecipient.values()].flat())));
  const suppressedHashes = new Set(rows.map((r) => r.emailHash));
  const suppressed = new Set<string>();
  for (const [recipient, hashes] of hashesByRecipient) {
    if (hashes.some((h) => suppressedHashes.has(h))) suppressed.add(recipient);
  }
  return suppressed;
}

/**
 * Drops the retained one-click opt-out for an address. Only an explicit
 * re-subscribe by the tenant (contact update with unsubscribed=false) calls
 * this; creating or importing the same address again never does, so the
 * opt-out keeps blocking until someone consciously clears it.
 */
export async function clearUnsubscribeSuppression(
  db: Db,
  teamId: string,
  email: string,
): Promise<void> {
  const t = schema.suppressions;
  await db
    .delete(t)
    .where(
      and(
        eq(t.teamId, teamId),
        eq(t.reason, "one_click_unsubscribe"),
        inArray(t.emailHash, [...new Set([hashRecipient(email), legacyHashRecipient(email)])]),
      ),
    );
}
