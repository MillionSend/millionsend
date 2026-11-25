import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, gt, gte, isNull, lte, ne, or, sql } from "drizzle-orm";
import { firstRow } from "./driver-result.js";
import { providerFamilySql } from "./mailbox-provider-sql.js";
import { instanceSettings } from "./monitor-settings.js";
import { DAY_MS } from "./utc-day.js";

const HOUR_MS = 3600_000;
/** The newest sends a candidate's shares are read from, so one read stays bounded. */
const SEND_BURST_SAMPLE = 10_000;

export interface SendBurst {
  teamId: string;
  name: string;
  createdAt: Date;
  /** Sent over the window, from the hourly counters. */
  sent: number;
  /** The sample the shares are read from. */
  sample: number;
  /** Of the sample: sends with one recipient, sends outside a broadcast. */
  single: number;
  api: number;
  /** The provider family most of the sample went to, and how many. */
  family: string;
  familyCount: number;
}

/**
 * Young teams whose recent sending looks like a list blast: at least
 * burstMinSent sent over the last burstWindowHours by a team younger than
 * burstTeamAgeDays, burstSingleShare of it to one recipient each and
 * burstProviderShare of it to one provider family. Each is claimed
 * (teams.send_burst_alerted_at) before it is returned, so a team alerts
 * once. Teams an operator vouched for or lifted the new-account limit of are
 * left out. Off while burstMinSent is 0.
 */
export async function claimSendBursts(db: Db, now: Date): Promise<SendBurst[]> {
  const s = await instanceSettings(db);
  if (!s.burstMinSent) return [];
  const h = schema.usageCountersHourly;
  const t = schema.teams;
  const m = schema.teamMonitor;
  const since = new Date(
    Math.floor((now.getTime() - s.burstWindowHours * HOUR_MS) / HOUR_MS) * HOUR_MS,
  );
  const sent = sql<number>`sum(${h.sent})::int`;
  const candidates = await db
    .select({ teamId: t.id, name: t.name, createdAt: t.createdAt, sent })
    .from(h)
    .innerJoin(t, eq(t.id, h.teamId))
    .leftJoin(m, eq(m.teamId, t.id))
    .where(
      and(
        gte(h.hour, since),
        gt(t.createdAt, new Date(now.getTime() - s.burstTeamAgeDays * DAY_MS)),
        ne(t.plan, "system"),
        isNull(t.suspendedAt),
        isNull(t.sendBurstAlertedAt),
        or(isNull(m.vouchedAt), lte(m.vouchUntil, now)),
        or(isNull(m.limitBypassAt), lte(m.limitBypassUntil, now)),
      ),
    )
    .groupBy(t.id, t.name, t.createdAt)
    .having(sql`sum(${h.sent}) >= ${s.burstMinSent}`);
  const bursts: SendBurst[] = [];
  for (const c of candidates) {
    const family = providerFamilySql(sql`lower(rtrim(split_part(s.recipient, '@', -1), '>'))`);
    const shares = firstRow<{
      sample: number;
      single: number;
      api: number;
      family: string | null;
      family_count: number | null;
    }>(
      await db.execute(sql`
        with s as (
          select e."to"->>0 as recipient, e.broadcast_id,
            jsonb_array_length(e."to") + coalesce(jsonb_array_length(e.cc), 0)
              + coalesce(jsonb_array_length(e.bcc), 0) as recipients
          from emails e
          where e.team_id = ${c.teamId}
            and e.created_at >= ${since.toISOString()}::timestamptz
            and e.sent_at is not null
          order by e.created_at desc
          limit ${SEND_BURST_SAMPLE}
        ), f as (
          select ${family} as family, count(*)::int as n from s group by 1 order by 2 desc limit 1
        )
        select count(*)::int as sample,
          count(*) filter (where s.recipients = 1)::int as single,
          count(*) filter (where s.broadcast_id is null)::int as api,
          (select family from f) as family,
          (select n from f) as family_count
        from s
      `),
    );
    if (!shares || shares.sample === 0 || !shares.family) continue;
    if (shares.single / shares.sample < s.burstSingleShare) continue;
    if ((shares.family_count ?? 0) / shares.sample < s.burstProviderShare) continue;
    const [claimed] = await db
      .update(t)
      .set({ sendBurstAlertedAt: now })
      .where(and(eq(t.id, c.teamId), isNull(t.sendBurstAlertedAt)))
      .returning({ id: t.id });
    if (!claimed) continue;
    bursts.push({
      ...c,
      sample: shares.sample,
      single: shares.single,
      api: shares.api,
      family: shares.family,
      familyCount: shares.family_count ?? 0,
    });
  }
  return bursts;
}
