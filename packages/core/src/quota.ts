import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { sql } from "drizzle-orm";
import { firstRow } from "./driver-result.js";

export type QuotaResult =
  | { reserved: true; acceptedToday: number }
  | { reserved: false; acceptedToday: number };

/**
 * Atomically reserve `count` sends against a team's daily limit (UTC day).
 * Single upsert with the limit re-checked inside the UPDATE's WHERE, so
 * concurrent requests can never overshoot the cap — no cached aggregates.
 * `limit === null` means unlimited (Scale plan / self-host): counts are still
 * recorded for metrics but never rejected.
 */
export async function reserveDailyQuota(
  db: Db,
  params: { teamId: string; count: number; limit: number | null; day?: string },
): Promise<QuotaResult> {
  const { teamId, count, limit } = params;
  if (count <= 0) throw new Error("count must be positive");
  const day = params.day ?? new Date().toISOString().slice(0, 10);
  const t = schema.usageCounters;

  if (limit !== null && count > limit) {
    const existing = await db
      .select({ accepted: t.accepted })
      .from(t)
      .where(sql`${t.teamId} = ${teamId} and ${t.day} = ${day}`);
    return { reserved: false, acceptedToday: existing[0]?.accepted ?? 0 };
  }

  const guard = limit === null ? sql`true` : sql`${t.accepted} + ${count} <= ${limit}`;
  const rows = await db.execute<{ accepted: number }>(sql`
    insert into ${t} (team_id, day, accepted)
    values (${teamId}, ${day}, ${count})
    on conflict (team_id, day) do update
      set accepted = ${t.accepted} + ${count}
      where ${guard}
    returning accepted
  `);

  const row = firstRow<{ accepted: number }>(rows);
  if (row) return { reserved: true, acceptedToday: Number(row.accepted) };

  const existing = await db
    .select({ accepted: t.accepted })
    .from(t)
    .where(sql`${t.teamId} = ${teamId} and ${t.day} = ${day}`);
  return { reserved: false, acceptedToday: existing[0]?.accepted ?? 0 };
}
