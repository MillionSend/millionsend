import { type Db, schema } from "@millionsend/db";
import { and, eq, inArray, type SQLWrapper, sql } from "drizzle-orm";

import { extractAddrSpec, normalizeAddress } from "./suppressions.js";

/** Historical contacts have no confirmation state and retain their semantics. */
export function hasRevocableConfirmation(value: { state: string } | null | undefined): boolean {
  return value?.state === "pending" || value?.state === "confirmed";
}

/** Suppression writers lock contacts first, matching confirmation's lock order. */
export async function lockSuppressionContacts(
  db: Db,
  teamId: string,
  addresses: readonly string[],
) {
  if (!addresses.length) return;
  const normalized = [
    ...new Set(addresses.map((x) => normalizeAddress(extractAddrSpec(x)))),
  ].sort();
  // The address lock also covers contacts that do not exist yet.
  for (const email of normalized)
    await db.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${teamId}:${email}`}, 0))`,
    );
  const t = schema.contacts;
  await db
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.teamId, teamId), inArray(sql`lower(${t.email})`, normalized)))
    .orderBy(t.id)
    .for("update");
}

/** Evaluated on the locked row, so a racing confirmation cannot escape withdrawal. */
export function revokeContactConfirmation(column: SQLWrapper, at = new Date(), withdrawal = true) {
  const marker = JSON.stringify({
    state: "revoked",
    revokedAt: at.toISOString(),
    ...(withdrawal ? { withdrawnAt: at.toISOString() } : {}),
  });
  return sql`case when ${column}->>'state' in ('pending','confirmed')
    then ${column} || ${marker}::jsonb else ${column} end`;
}

/** A later suppression removal must never revive an older mailbox request. */
export async function revokeSuppressedConfirmations(
  db: Db,
  teamId: string,
  addresses: readonly string[],
  withdrawal = false,
) {
  if (!addresses.length) return;
  const t = schema.contacts;
  await db
    .update(t)
    .set({
      confirmation: revokeContactConfirmation(t.confirmation, new Date(), withdrawal),
      ...(withdrawal
        ? { unsubscribed: true, unsubscribedAt: sql`coalesce(${t.unsubscribedAt}, now())` }
        : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(t.teamId, teamId),
        inArray(
          sql`lower(${t.email})`,
          addresses.map((x) => normalizeAddress(extractAddrSpec(x))),
        ),
        withdrawal ? undefined : sql`${t.confirmation}->>'state' in ('pending','confirmed')`,
      ),
    );
}
