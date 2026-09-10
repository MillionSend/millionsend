import { DAY_MS, teamRung } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { BillingDeps } from "./checkout.js";
import { METER_EVENT_NAME } from "./prices.js";

/** Stripe refuses meter events older than this; a row that stale is logged and left. */
const METER_MAX_AGE_MS = 35 * DAY_MS;

export interface OverageReport {
  reported: number;
  failed: number;
}

/**
 * Sends past the included volume, for every period row that has more of
 * them than the meter already knows about, one event per team and period
 * per run. The event's identifier is the counter it advances from, so a
 * report whose commit is lost is re-sent under the same identifier and
 * Stripe drops it as a duplicate; the row is advanced inside the same
 * transaction as the Stripe call, so a Stripe failure leaves it for the
 * next run. Usage of a period that already ended is stamped inside that
 * period, which is where Stripe invoices it (the invoice stays a draft for
 * about an hour after the period closes).
 */
export async function reportOverage(
  deps: BillingDeps,
  opts: { now?: Date; teamId?: string } = {},
): Promise<OverageReport> {
  const now = opts.now ?? new Date();
  const log = deps.log ?? console.warn;
  const t = schema.teams;
  const p = schema.usagePeriods;
  const rows = await deps.db
    .select({
      teamId: t.id,
      customerId: t.stripeCustomerId,
      plan: t.plan,
      planQuota: t.planQuota,
      currentPeriodStart: t.currentPeriodStart,
      currentPeriodEnd: t.currentPeriodEnd,
      periodStart: p.periodStart,
      accepted: p.accepted,
      reportedOverage: p.reportedOverage,
    })
    .from(p)
    .innerJoin(t, eq(t.id, p.teamId))
    .where(
      and(
        isNotNull(t.stripeOverageItemId),
        isNotNull(t.stripeCustomerId),
        opts.teamId ? eq(t.id, opts.teamId) : undefined,
      ),
    );
  let reported = 0;
  let failed = 0;
  for (const row of rows) {
    const rung = teamRung(row.plan, row.planQuota);
    if (rung.period !== "month" || !row.customerId) continue;
    const delta = row.accepted - rung.included - row.reportedOverage;
    if (delta <= 0) continue;
    // A period before the current one ended where the current one starts;
    // the current one ends at the recorded period end. A row keyed at or past
    // that end (the renewal webhook not landed yet) is still running.
    const ps = row.periodStart.getTime();
    const end =
      row.currentPeriodStart && ps < row.currentPeriodStart.getTime()
        ? row.currentPeriodStart
        : row.currentPeriodEnd && ps < row.currentPeriodEnd.getTime()
          ? row.currentPeriodEnd
          : null;
    const at = end && now.getTime() >= end.getTime() ? new Date(end.getTime() - 1000) : now;
    if (now.getTime() - at.getTime() > METER_MAX_AGE_MS) {
      log(
        `overage: team ${row.teamId} period ${row.periodStart.toISOString()} is too old to meter`,
      );
      failed += 1;
      continue;
    }
    const customerId = row.customerId;
    try {
      await deps.db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const advanced = await txDb
          .update(p)
          .set({ reportedOverage: sql`${p.reportedOverage} + ${delta}` })
          .where(
            and(
              eq(p.teamId, row.teamId),
              eq(p.periodStart, row.periodStart),
              eq(p.reportedOverage, row.reportedOverage),
            ),
          )
          .returning({ reportedOverage: p.reportedOverage });
        // Another run advanced the row first; its event carries this usage.
        if (advanced.length === 0) return;
        await deps.stripe.billing.meterEvents.create({
          event_name: METER_EVENT_NAME,
          identifier: `${row.teamId}:${row.periodStart.getTime()}:${row.reportedOverage}`,
          timestamp: Math.floor(at.getTime() / 1000),
          payload: { stripe_customer_id: customerId, value: String(delta) },
        });
        reported += 1;
      });
    } catch (err) {
      failed += 1;
      log(`overage: team ${row.teamId} report failed: ${String(err)}`);
    }
  }
  return { reported, failed };
}
