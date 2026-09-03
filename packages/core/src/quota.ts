import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { sql } from "drizzle-orm";
import { firstRow } from "./driver-result.js";
import { QUOTA_TOLERANCE } from "./plans.js";
import { utcDay } from "./utc-day.js";

export type QuotaResult =
  | { reserved: true; acceptedToday: number }
  | { reserved: false; acceptedToday: number };

/**
 * Atomically reserve `count` sends against a team's daily limit (UTC day).
 * Single upsert with the limit re-checked inside the UPDATE's WHERE, so
 * concurrent requests can never overshoot the cap — no cached aggregates.
 * `limit === null` means unlimited (Scale plan / self-host): counts are still
 * recorded for metrics but never rejected.
 *
 * CONTRACT: call inside the same transaction that inserts the email rows —
 * a crash between reserve and insert otherwise burns quota with nothing
 * sent. Callers that cannot share a transaction must compensate failures
 * with releaseDailyQuota.
 */
export async function reserveDailyQuota(
  db: Db,
  params: { teamId: string; count: number; limit: number | null; day?: string },
): Promise<QuotaResult> {
  const { teamId, count, limit } = params;
  if (count <= 0) throw new Error("count must be positive");
  const day = params.day ?? utcDay();
  const t = schema.usageCounters;
  const ceiling = limit === null ? null : Math.floor(limit * (1 + QUOTA_TOLERANCE));

  if (ceiling !== null && count > ceiling) {
    const existing = await db
      .select({ accepted: t.accepted })
      .from(t)
      .where(sql`${t.teamId} = ${teamId} and ${t.day} = ${day}`);
    return { reserved: false, acceptedToday: existing[0]?.accepted ?? 0 };
  }

  const guard = ceiling === null ? sql`true` : sql`${t.accepted} + ${count} <= ${ceiling}`;
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

/**
 * Compensating release for non-transactional callers whose work failed after
 * a successful reservation. Floors at zero.
 */
export async function releaseDailyQuota(
  db: Db,
  params: { teamId: string; count: number; day?: string },
): Promise<void> {
  if (params.count <= 0) throw new Error("count must be positive");
  const day = params.day ?? utcDay();
  const t = schema.usageCounters;
  await db.execute(sql`
    update ${t}
    set accepted = greatest(accepted - ${params.count}, 0)
    where ${t.teamId} = ${params.teamId} and ${t.day} = ${day}
  `);
}
