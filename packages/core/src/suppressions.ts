import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, inArray, ne } from "drizzle-orm";
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

/** Every hash form a stored suppression for `email` may carry (current first). */
export function suppressionHashesFor(email: string): string[] {
  return [...new Set([hashRecipient(email), legacyHashRecipient(email)])];
}

/**
 * Wire vocabulary for a suppression's reason: `bounce`, `complaint` and
 * `manual` match Resend's origin enum; `unsubscribe` is a documented superset
 * value (the retained RFC 8058 one-click opt-out) Resend has no equivalent for.
 */
export const SUPPRESSION_ORIGIN_BY_REASON = {
  hard_bounce: "bounce",
  complaint: "complaint",
  manual: "manual",
  one_click_unsubscribe: "unsubscribe",
} as const;

export type SuppressionReason = keyof typeof SUPPRESSION_ORIGIN_BY_REASON;
export type SuppressionOrigin = (typeof SUPPRESSION_ORIGIN_BY_REASON)[SuppressionReason];

/**
 * Returns the subset of `recipients` that are suppressed for this team.
 *
 * `transactional` marks a send with no topic and no broadcast. A recipient's
 * own unsubscribe (the retained one-click opt-out) covers marketing mail
 * only, the way Resend's `unsubscribed` means "from all Broadcasts", so those
 * rows do not block it: password resets and receipts still arrive. Bounces,
 * complaints and manual blocks apply to every send.
 */
export async function findSuppressed(
  db: Db,
  teamId: string,
  recipients: readonly string[],
  opts: { transactional?: boolean } = {},
): Promise<Set<string>> {
  if (recipients.length === 0) return new Set();
  const t = schema.suppressions;
  const hashesByRecipient = new Map(recipients.map((r) => [r, suppressionHashesFor(r)]));
  const rows = await db
    .select({ emailHash: t.emailHash })
    .from(t)
    .where(
      and(
        eq(t.teamId, teamId),
        inArray(t.emailHash, [...hashesByRecipient.values()].flat()),
        opts.transactional ? ne(t.reason, "one_click_unsubscribe") : undefined,
      ),
    );
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
): Promise<{ id: string; email: string | null; reason: SuppressionReason; createdAt: Date }[]> {
  const t = schema.suppressions;
  return db
    .delete(t)
    .where(
      and(
        eq(t.teamId, teamId),
        eq(t.reason, "one_click_unsubscribe"),
        inArray(t.emailHash, suppressionHashesFor(email)),
      ),
    )
    .returning({ id: t.id, email: t.email, reason: t.reason, createdAt: t.createdAt });
}
