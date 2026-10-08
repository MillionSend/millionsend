import {
  EMAIL_RETENTION_DAYS_DEFAULT,
  env,
  isCloudDeployment,
  SES_MAX_SEND_RATE_DEFAULT,
  SES_TRANSACTIONAL_RESERVE_DEFAULT,
  servedRegions,
  sesTenantsEnabled,
} from "@millionsend/config";
import {
  bulkShare,
  clampReserve,
  committedDailyVolume,
  getInstanceSettings,
  holdRegion,
  latestProbes,
  pacingHorizonDays,
  pausedRegions,
  planRegionSend,
  regionBulkCounts,
  regionCounterTotals,
  regionDailyPeaks,
  regionWindowCounts,
  releaseRegion,
  SES_TRANSACTIONAL_RESERVE_MAX,
  SES_TRANSACTIONAL_RESERVE_MIN,
  sendingBroadcasts,
  sesEventsHealth,
  transactionalSent24h,
  usableReserve,
} from "@millionsend/core";
import { schema } from "@millionsend/db";
import {
  createQuotaRequestClient,
  type QuotaRequestClient,
  requestSesDailyQuota,
  SES_REGIONS,
} from "@millionsend/ses";
import { TRPCError } from "@trpc/server";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { type RegionAccountDeps, servedRegionAccounts } from "../../console/ses-regions";
import { operatorProcedure, router } from "../../trpc";
import { effectiveSetting } from "../system";
import { emptyDaily, emptyHourly, regionDailySends, regionHourlySends } from "./series";
import { auditOperator } from "./shared";

/** SES list prices per 1,000 emails, in cents, by pricing plan; tenants add their own line. */
const RATE_CENTS_PER_1K: Record<string, number> = { NONE: 10, ESSENTIALS: 16 };
const ALA_CARTE_CENTS_PER_1K = 10;
const TENANT_CENTS_PER_1K = 0.5;

export interface ConsoleRegionDeps {
  quotaClient(region: string): QuotaRequestClient;
  accounts?: RegionAccountDeps | undefined;
}

const defaultDeps: ConsoleRegionDeps = {
  quotaClient: (region) =>
    createQuotaRequestClient({
      region,
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    }),
};

const regionInput = z.object({ region: z.string().min(1).max(32) });

function assertServed(region: string): void {
  if (!servedRegions().includes(region)) throw new TRPCError({ code: "NOT_FOUND" });
}

/** Headroom the hint leaves over the week's transactional peak before it suggests a reserve. */
const HINT_HEADROOM = 1.3;

/**
 * The smallest reserve (steps of five) whose usable part covers the week's
 * transactional peak with headroom, never under the default: a hint beside
 * the field, never applied on its own.
 */
function suggestedReserve(max24h: number | null, txPeak7d: number): number {
  if (max24h === null || max24h <= 0) return SES_TRANSACTIONAL_RESERVE_DEFAULT;
  for (let p = SES_TRANSACTIONAL_RESERVE_DEFAULT; p <= SES_TRANSACTIONAL_RESERVE_MAX; p += 5) {
    if (usableReserve(max24h, p) >= txPeak7d * HINT_HEADROOM) return p;
  }
  return SES_TRANSACTIONAL_RESERVE_MAX;
}

export function createConsoleRegionsRouter(deps: ConsoleRegionDeps = defaultDeps) {
  const accounts = (fresh = false) =>
    servedRegionAccounts({ fresh, ...(deps.accounts ? { deps: deps.accounts } : {}) });
  return router({
    /** Every served region with its live SES state, plus the SES regions the product knows but does not serve. */
    list: operatorProcedure.query(async ({ ctx }) => {
      const now = new Date();
      const served = servedRegions();
      const monthDays = now.getUTCDate();
      const d = schema.domains;
      const defaultRegion = served[0];
      const [
        regionAccounts,
        settings,
        day,
        week,
        month,
        paused,
        domains,
        hourly,
        daily,
        events,
        probes,
        peaks,
        bulk,
        sending,
        committedPerDay,
      ] = await Promise.all([
        accounts(),
        getInstanceSettings(ctx.db),
        regionWindowCounts(ctx.db, { now, hours: 24 }),
        regionCounterTotals(ctx.db, { now, days: 7 }),
        regionCounterTotals(ctx.db, { now, days: monthDays }),
        pausedRegions(ctx.db),
        ctx.db
          .select({ region: d.region, n: sql<number>`count(*)::int` })
          .from(d)
          .where(eq(d.status, "verified"))
          .groupBy(d.region),
        regionHourlySends(ctx.db, { now, hours: 24 }),
        regionDailySends(ctx.db, { now, days: 7 }),
        env.SNS_TOPIC_ARNS?.length ? sesEventsHealth(ctx.db, now) : Promise.resolve(null),
        latestProbes(ctx.db),
        Promise.all(
          served.map(
            async (region) =>
              [region, await regionDailyPeaks(ctx.db, { region, days: 7, now })] as const,
          ),
        ).then((rows) => new Map(rows)),
        regionBulkCounts(ctx.db, now),
        sendingBroadcasts(ctx.db),
        isCloudDeployment() ? committedDailyVolume(ctx.db, now) : Promise.resolve(null),
      ]);
      // Env values are raw strings when validation is skipped (tests), hence Number().
      const horizonDays = pacingHorizonDays(
        settings.emailRetentionDays ??
          Number(env.EMAIL_RETENTION_DAYS ?? EMAIL_RETENTION_DAYS_DEFAULT),
      );
      const ceiling =
        settings.sesMaxSendRate ?? Number(env.SES_MAX_SEND_RATE ?? SES_MAX_SEND_RATE_DEFAULT);
      const reserve = effectiveSetting(
        settings.sesTransactionalReserve,
        process.env.SES_TRANSACTIONAL_RESERVE,
        SES_TRANSACTIONAL_RESERVE_DEFAULT,
      );
      // The split only means something against a finite quota.
      const quotaOf = (account: (typeof regionAccounts)[number]) =>
        account.ok && account.overview.quota.max24h > 0 ? account.overview.quota.max24h : null;
      const defaultAccount = regionAccounts.find((a) => a.region === defaultRegion);
      const defaultQuota = defaultAccount ? quotaOf(defaultAccount) : null;
      const defaultPeak = defaultRegion ? (peaks.get(defaultRegion)?.txPeak ?? 0) : 0;
      const tenants = sesTenantsEnabled();
      const domainsByRegion = new Map(domains.map((r) => [r.region, r.n]));
      const breakers = new Map(paused.map((p) => [p.region, p]));
      // The worker's memory of a transactional row parking at the quota line,
      // one value for the instance: the probe carries seconds since.
      const txParkedProbe = probes.get("ses_transactional_parked");
      const txParkedAt =
        txParkedProbe && !txParkedProbe.ok && txParkedProbe.value !== null
          ? new Date(txParkedProbe.takenAt.getTime() - txParkedProbe.value * 1000)
          : null;
      // One planner run per region with a broadcast still going out: when
      // the last of them finishes, for the queue row and the notice.
      const lastFinishes = new Map(
        await Promise.all(
          regionAccounts.map(async (account) => {
            const inRegion = sending.filter((b) => b.region === account.region);
            if (!account.ok || inRegion.length === 0) return [account.region, null] as const;
            const plan = await planRegionSend(ctx.db, {
              region: account.region,
              account: account.overview.quota,
              reservePercent: reserve.value,
              rateCeiling: ceiling,
              horizonDays,
              now,
            });
            const ends = plan.estimates.flatMap((e) => (e.finishesAt ? [e.finishesAt] : []));
            return [
              account.region,
              ends.length > 0 ? new Date(Math.max(...ends.map((d) => d.getTime()))) : null,
            ] as const;
          }),
        ),
      );
      return {
        committedPerDay,
        served: regionAccounts.map((account) => {
          const region = account.region;
          const counts24 = day.get(region);
          const counts7 = week.get(region);
          const sentMonth = month.get(region)?.sent ?? 0;
          const plan = account.ok ? account.overview.pricingPlan : null;
          const rate = RATE_CENTS_PER_1K[plan ?? "NONE"] ?? ALA_CARTE_CENTS_PER_1K;
          const breaker = breakers.get(region);
          const quota = quotaOf(account);
          const share = quota === null ? null : bulkShare(quota, reserve.value);
          const bulkSent24h = bulk.get(region)?.sent24h ?? 0;
          const bulkQueued = bulk.get(region)?.queued ?? 0;
          const inRegion = sending.filter((b) => b.region === region);
          return {
            region,
            served: true as const,
            // What broadcasts may hold in the rolling window, and what the
            // total gate really protects above it; null without a finite quota.
            share,
            usableReserve: quota === null ? null : usableReserve(quota, reserve.value),
            bulkSent24h,
            txSent24h: account.ok
              ? transactionalSent24h({
                  sesSentLast24h: account.overview.quota.sentLast24h,
                  allSent24h: bulk.get(region)?.allSent24h ?? 0,
                  bulkSent24h,
                })
              : null,
            room: share === null ? null : Math.max(0, share - bulkSent24h - bulkQueued),
            bulkParked: inRegion.reduce((n, b) => n + b.parked, 0),
            waitingBroadcasts: inRegion.filter((b) => b.parked > 0).length,
            lastFinishesAt: lastFinishes.get(region) ?? null,
            txParkedAt,
            txPeak7d: peaks.get(region)?.txPeak ?? 0,
            bulkPeak7d: peaks.get(region)?.bulkPeak ?? 0,
            status: !account.ok
              ? ("unreachable" as const)
              : account.overview.productionAccess
                ? ("serving" as const)
                : ("sandbox" as const),
            probedAt: account.probedAt,
            latencyMs: account.ok ? account.latencyMs : null,
            error: account.ok ? null : account.message,
            account: account.ok ? account.overview : null,
            // What the worker's bucket runs at: the SES rate, capped by the
            // instance setting, shared between replicas.
            effectiveRate: account.ok
              ? Math.min(account.overview.quota.maxSendRate, ceiling) / env.WORKER_REPLICAS
              : null,
            domainsVerified: domainsByRegion.get(region) ?? 0,
            sent24h: counts24?.sent ?? 0,
            week: counts7
              ? {
                  sent: counts7.sent,
                  hardBounceRate: counts7.sent > 0 ? counts7.hardBounced / counts7.sent : 0,
                  complaintRate: counts7.sent > 0 ? counts7.complained / counts7.sent : 0,
                }
              : null,
            breaker: breaker
              ? {
                  paused: true as const,
                  manualReason: breaker.manualReason,
                  reason: breaker.reason,
                  pausedAt: breaker.pausedAt,
                }
              : null,
            hourly: hourly.get(region) ?? emptyHourly(now, 24),
            daily: daily.get(region) ?? emptyDaily(now, 7),
            cost: {
              sentThisMonth: sentMonth,
              plan,
              centsPer1k: rate + (tenants ? TENANT_CENTS_PER_1K : 0),
              cents: Math.round((sentMonth / 1000) * (rate + (tenants ? TENANT_CENTS_PER_1K : 0))),
              tenants,
            },
          };
        }),
        known: SES_REGIONS.filter((r) => !served.includes(r)).map((region) => ({ region })),
        reserve: {
          percent: reserve.value,
          source: reserve.source,
          min: SES_TRANSACTIONAL_RESERVE_MIN,
          max: SES_TRANSACTIONAL_RESERVE_MAX,
          // The default region's week: the hint beside the field.
          hint: {
            txPeak7d: defaultPeak,
            usableReserveNow:
              defaultQuota === null ? null : usableReserve(defaultQuota, reserve.value),
            suggested: suggestedReserve(defaultQuota, defaultPeak),
          },
        },
        eventsHealth: events,
        // The SQS pipeline is one queue for every region; the lag the worker measured applies to all.
        eventsLagSeconds: probes.get("ses_events_lag_s")?.value ?? null,
        cloud: isCloudDeployment(),
        defaultRegion: served[0] ?? env.AWS_REGION,
        envRegions: env.AWS_REGIONS ?? null,
      };
    }),

    /** Re-read GetAccount in every served region now (or one), past the minute cache. */
    refresh: operatorProcedure
      .input(z.object({ region: z.string().optional() }).optional())
      .mutation(async ({ input }) => {
        const results = await accounts(true);
        return results
          .filter((r) => !input?.region || r.region === input.region)
          .map((r) => ({
            region: r.region,
            ok: r.ok,
            latencyMs: r.ok ? r.latencyMs : null,
            message: r.ok ? null : r.message,
          }));
      }),

    /** The real numbers a production-access request is written from. */
    accessRequestFacts: operatorProcedure.input(regionInput).query(async ({ ctx, input }) => {
      assertServed(input.region);
      const now = new Date();
      const d = schema.domains;
      const [teams, daily, day, week, aligned] = await Promise.all([
        ctx.db
          .select({ n: sql<number>`count(distinct ${d.teamId})::int` })
          .from(d)
          .where(and(eq(d.region, input.region), eq(d.status, "verified")))
          .then((r) => r[0]?.n ?? 0),
        regionDailySends(ctx.db, { now, days: 30 }),
        regionWindowCounts(ctx.db, { now, hours: 24 }),
        regionCounterTotals(ctx.db, { now, days: 7 }),
        ctx.db
          .select({
            total: sql<number>`count(*)::int`,
            dmarc: sql<number>`count(*) filter (where ${d.dmarcPolicy} is not null)::int`,
          })
          .from(d)
          .where(and(eq(d.region, input.region), eq(d.status, "verified")))
          .then((r) => r[0] ?? { total: 0, dmarc: 0 }),
      ]);
      const w = week.get(input.region);
      return {
        region: input.region,
        teams,
        sent24h: day.get(input.region)?.sent ?? 0,
        peak30d: Math.max(0, ...(daily.get(input.region) ?? []).map((p) => p.sent)),
        hardBounceRate7d: w && w.sent > 0 ? w.hardBounced / w.sent : 0,
        complaintRate7d: w && w.sent > 0 ? w.complained / w.sent : 0,
        domainsVerified: aligned.total,
        domainsWithDmarc: aligned.dmarc,
      };
    }),

    /** Hold a region's broadcasts by hand; the breaker cron leaves it alone until released. */
    hold: operatorProcedure
      .input(regionInput.extend({ reason: z.string().trim().min(1).max(500) }))
      .mutation(async ({ ctx, input }) => {
        assertServed(input.region);
        await holdRegion(ctx.db, input.region, input.reason);
        await auditOperator(ctx, {
          teamId: null,
          action: "region.breaker_opened",
          target: { type: "region", id: input.region },
          metadata: { reason: input.reason, manual: true },
        });
      }),

    release: operatorProcedure.input(regionInput).mutation(async ({ ctx, input }) => {
      assertServed(input.region);
      await releaseRegion(ctx.db, input.region);
      await auditOperator(ctx, {
        teamId: null,
        action: "region.breaker_closed",
        target: { type: "region", id: input.region },
        metadata: { manual: true },
      });
    }),

    /** The share of every region's quota kept for transactional mail; clamped, stored on the instance row, audited. */
    setReserve: operatorProcedure
      .input(z.object({ percent: z.number().int() }))
      .mutation(async ({ ctx, input }) => {
        const percent = clampReserve(input.percent);
        const before = effectiveSetting(
          (await getInstanceSettings(ctx.db)).sesTransactionalReserve,
          process.env.SES_TRANSACTIONAL_RESERVE,
          SES_TRANSACTIONAL_RESERVE_DEFAULT,
        ).value;
        await ctx.db
          .insert(schema.instanceSettings)
          .values({ id: 1, sesTransactionalReserve: percent })
          .onConflictDoUpdate({
            target: schema.instanceSettings.id,
            set: { sesTransactionalReserve: percent, updatedAt: new Date() },
          });
        await auditOperator(ctx, {
          teamId: null,
          action: "instance.reserve_updated",
          metadata: { from: before, to: percent },
        });
        return { percent };
      }),

    /** File a daily quota raise through Service Quotas; access_denied means the operator pastes the request instead. */
    requestQuota: operatorProcedure
      .input(
        regionInput.extend({
          desired: z.number().int().min(1).max(100_000_000),
          justification: z.string().trim().max(2000).default(""),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        assertServed(input.region);
        const result = await requestSesDailyQuota(deps.quotaClient(input.region), input.desired);
        if (result.ok) {
          await auditOperator(ctx, {
            teamId: null,
            action: "region.quota_requested",
            target: { type: "region", id: input.region },
            metadata: {
              desired: input.desired,
              requestId: result.requestId,
              status: result.status,
              justification: input.justification,
            },
          });
        }
        return result;
      }),
  });
}

export const consoleRegionsRouter = createConsoleRegionsRouter();
