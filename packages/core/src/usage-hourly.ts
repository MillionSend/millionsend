import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { sql } from "drizzle-orm";

export const USAGE_COUNTERS = [
  "accepted",
  "sent",
  "delivered",
  "bounced",
  "hard_bounced",
  "complained",
  "opened",
  "clicked",
  "prefetched",
] as const;
export type UsageCounter = (typeof USAGE_COUNTERS)[number];

/**
 * The UTC hour an instant falls in.
 * ponytail: hourly grain — in :30/:45 zones the bucket straddling local
 * midnight is dated to the earlier day, so up to 45 min of traffic lands on
 * the previous bar; bucket at 15 min if those markets matter.
 */
export function utcHour(at: Date | number): Date {
  const hour = new Date(at);
  hour.setUTCMinutes(0, 0, 0);
  return hour;
}

/**
 * Bump the hourly counters beside a daily bump, in the caller's transaction.
 * A release may land in a different hour than its reservation, so an hour
 * can go briefly negative and only sums over a range are meaningful — no
 * floor here, unlike the daily row quota enforces on. Column names come
 * from USAGE_COUNTERS only, never from input.
 */
export async function bumpHourlyUsage(
  db: Db,
  params: { teamId: string; at: Date | number; counts: Partial<Record<UsageCounter, number>> },
): Promise<void> {
  const entries = USAGE_COUNTERS.flatMap((c) => {
    const n = params.counts[c];
    return n ? [[c, n] as const] : [];
  });
  if (entries.length === 0) return;
  const t = schema.usageCountersHourly;
  const cols = sql.raw(entries.map(([c]) => c).join(", "));
  const inserts = sql.join(
    entries.map(([, n]) => sql`${n}`),
    sql`, `,
  );
  const updates = sql.join(
    entries.map(([c, n]) => sql`${sql.raw(c)} = ${t}.${sql.raw(c)} + ${n}`),
    sql`, `,
  );
  await db.execute(sql`
    insert into ${t} (team_id, hour, ${cols})
    values (${params.teamId}, ${utcHour(params.at)}, ${inserts})
    on conflict (team_id, hour) do update set ${updates}
  `);
}
