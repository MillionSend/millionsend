import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { firstRow, resultRows } from "./driver-result.js";
import { DAY_MS } from "./utc-day.js";

export type IdempotencyBegin =
  | { kind: "new" }
  | { kind: "replay"; emailIds: string[] }
  | { kind: "in_flight" }
  | { kind: "conflict" };

const TTL_MS = DAY_MS;
/** An incomplete claim older than this is treated as a dead owner and taken over. */
const IN_FLIGHT_LEASE_MS = 10 * 60 * 1000;

/**
 * Claim an Idempotency-Key. Outcomes: "new" (this request owns the key —
 * expired rows and dead owners' stale claims are reclaimed atomically),
 * "replay" (same key + same canonical body → stored response), "in_flight"
 * (a live owner is still working), "conflict" (same key, different body).
 * Correct even when the purge job never runs: expiry is enforced here.
 */
export async function beginIdempotent(
  db: Db,
  params: { teamId: string; key: string; bodyHash: string },
  now = new Date(),
): Promise<IdempotencyBegin> {
  const t = schema.idempotencyKeys;
  const expiresAt = new Date(now.getTime() + TTL_MS);
  const staleBefore = new Date(now.getTime() - IN_FLIGHT_LEASE_MS);
  // Single atomic claim: fresh insert, or takeover of an expired row / a
  // stale incomplete claim with the same body.
  const inserted = await db.execute<{ key: string }>(sql`
    insert into ${t} (team_id, key, body_hash, expires_at, created_at)
    values (${params.teamId}, ${params.key}, ${params.bodyHash}, ${expiresAt}, ${now})
    on conflict (team_id, key) do update
      set body_hash = excluded.body_hash,
          response_email_ids = null,
          expires_at = excluded.expires_at,
          created_at = excluded.created_at
      where ${t.expiresAt} <= ${now}
         or (${t.responseEmailIds} is null
             and ${t.createdAt} < ${staleBefore}
             and ${t.bodyHash} = excluded.body_hash)
    returning key
  `);
  if (firstRow<{ key: string }>(inserted)) return { kind: "new" };

  const existing = firstRow<{
    body_hash: string;
    response_email_ids: string[] | null;
  }>(
    await db.execute(sql`
      select body_hash, response_email_ids from ${t}
      where ${t.teamId} = ${params.teamId} and ${t.key} = ${params.key}
        and ${t.expiresAt} > ${now}
    `),
  );
  // Row vanished or expired between claim and read: surface as conflict so
  // the client retries rather than this request double-claiming.
  if (!existing) return { kind: "conflict" };
  if (existing.body_hash !== params.bodyHash) return { kind: "conflict" };
  if (!existing.response_email_ids) return { kind: "in_flight" };
  return { kind: "replay", emailIds: existing.response_email_ids };
}

/**
 * Record the response for a claimed key. Guarded on response_email_ids IS
 * NULL so a stale-lease takeover's recorded response is never overwritten by
 * the original (dead) owner completing late. Returns false when the claim no
 * longer exists or was already completed by another owner — the caller must
 * treat that as "my result was not recorded", not success.
 */
export async function completeIdempotent(
  db: Db,
  params: { teamId: string; key: string; emailIds: string[] },
): Promise<boolean> {
  const t = schema.idempotencyKeys;
  const rows = await db
    .update(t)
    .set({ responseEmailIds: params.emailIds })
    .where(and(eq(t.teamId, params.teamId), eq(t.key, params.key), isNull(t.responseEmailIds)))
    .returning({ key: t.key });
  return rows.length > 0;
}

/**
 * Release an incomplete claim after the owning request failed, so retries
 * get "new" immediately instead of a bricked key for the lease window.
 * Completed claims are never released.
 */
export async function releaseIdempotent(
  db: Db,
  params: { teamId: string; key: string },
): Promise<void> {
  const t = schema.idempotencyKeys;
  await db
    .delete(t)
    .where(and(eq(t.teamId, params.teamId), eq(t.key, params.key), isNull(t.responseEmailIds)));
}

/** Cleanup job target: rows past expiry. Returns deleted count. */
export async function purgeExpiredIdempotencyKeys(db: Db, now = new Date()): Promise<number> {
  const t = schema.idempotencyKeys;
  const rows = await db.execute<{ key: string }>(
    sql`delete from ${t} where ${t.expiresAt} < ${now} returning key`,
  );
  return resultRows<{ key: string }>(rows).length;
}
