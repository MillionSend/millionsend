import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, sql } from "drizzle-orm";
import { firstRow, resultRows } from "./driver-result.js";

export type IdempotencyBegin =
  | { kind: "new" }
  | { kind: "replay"; emailIds: string[] }
  | { kind: "in_flight" }
  | { kind: "conflict" };

const TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Claim an Idempotency-Key. Outcomes: "new" (this request owns the key),
 * "replay" (same key + same canonical body → stored response), "in_flight"
 * (same key + same body, owner hasn't completed), "conflict" (same key,
 * different body — client bug, surface as 409/422).
 */
export async function beginIdempotent(
  db: Db,
  params: { teamId: string; key: string; bodyHash: string },
): Promise<IdempotencyBegin> {
  const t = schema.idempotencyKeys;
  const now = Date.now();
  const inserted = await db.execute<{ key: string }>(sql`
    insert into ${t} (team_id, key, body_hash, expires_at)
    values (${params.teamId}, ${params.key}, ${params.bodyHash}, ${new Date(now + TTL_MS)})
    on conflict (team_id, key) do nothing
    returning key
  `);
  const claimed = firstRow<{ key: string }>(inserted);
  if (claimed) return { kind: "new" };

  const existing = (
    await db
      .select({
        bodyHash: t.bodyHash,
        responseEmailIds: t.responseEmailIds,
        expiresAt: t.expiresAt,
      })
      .from(t)
      .where(and(eq(t.teamId, params.teamId), eq(t.key, params.key)))
  )[0];
  // Row vanished between insert and select (expiry cleanup): treat as conflict
  // and let the client retry rather than double-claiming.
  if (!existing) return { kind: "conflict" };
  if (existing.bodyHash !== params.bodyHash) return { kind: "conflict" };
  if (!existing.responseEmailIds) return { kind: "in_flight" };
  return { kind: "replay", emailIds: existing.responseEmailIds };
}

export async function completeIdempotent(
  db: Db,
  params: { teamId: string; key: string; emailIds: string[] },
): Promise<void> {
  const t = schema.idempotencyKeys;
  await db
    .update(t)
    .set({ responseEmailIds: params.emailIds })
    .where(and(eq(t.teamId, params.teamId), eq(t.key, params.key)));
}

/** Cleanup job target: rows past expiry. Returns deleted count. */
export async function purgeExpiredIdempotencyKeys(db: Db, now = new Date()): Promise<number> {
  const t = schema.idempotencyKeys;
  const rows = await db.execute<{ key: string }>(
    sql`delete from ${t} where ${t.expiresAt} < ${now} returning key`,
  );
  return resultRows<{ key: string }>(rows).length;
}
