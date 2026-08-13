import { createHash } from "node:crypto";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, inArray } from "drizzle-orm";

/**
 * Normalization before hashing: trim + lowercase. The hash — not the address —
 * is the stable identity, because erasure nulls the address column while the
 * suppression must keep working.
 */
export function hashRecipient(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase(), "utf8").digest("hex");
}

/** Returns the subset of `recipients` that are suppressed for this team. */
export async function findSuppressed(
  db: Db,
  teamId: string,
  recipients: readonly string[],
): Promise<Set<string>> {
  if (recipients.length === 0) return new Set();
  const t = schema.suppressions;
  const hashByRecipient = new Map(recipients.map((r) => [r, hashRecipient(r)]));
  const rows = await db
    .select({ emailHash: t.emailHash })
    .from(t)
    .where(and(eq(t.teamId, teamId), inArray(t.emailHash, [...hashByRecipient.values()])));
  const suppressedHashes = new Set(rows.map((r) => r.emailHash));
  const suppressed = new Set<string>();
  for (const [recipient, hash] of hashByRecipient) {
    if (suppressedHashes.has(hash)) suppressed.add(recipient);
  }
  return suppressed;
}
