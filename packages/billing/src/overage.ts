import { DAY_MS, teamRung } from "@millionsend/core";
import { schema } from "@millionsend/db";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
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
 * per run. Three steps per row, each its own statement: the row first pins
 * the counter the event will advance to (`pendingOverage`), the event goes
 * out with an identifier naming both ends of the step, then the row catches
 * up. A crash between the last two leaves the pin, so the next run re-sends
 * the same value under the same identifier and Stripe drops it as a
 * duplicate; a Stripe failure leaves the pin for the next run too. Usage of
 * a period that already ended is stamped inside that period, which is where
 * Stripe invoices it (the invoice stays a draft for about an hour after the
 * period closes).
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
      pendingOverage: p.pendingOverage,
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
    const from = row.reportedOverage;
    // A pinned step is finished before a new one starts.
    const to = row.pendingOverage ?? row.accepted - rung.included;
    if (to <= from) continue;
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
    const key = and(eq(p.teamId, row.teamId), eq(p.periodStart, row.periodStart));
    try {
      if (row.pendingOverage === null) {
        const pinned = await deps.db
          .update(p)
          .set({ pendingOverage: to })
          .where(and(key, eq(p.reportedOverage, from), isNull(p.pendingOverage)))
          .returning({ pendingOverage: p.pendingOverage });
        // Another run pinned this row first; its event carries the usage.
        if (pinned.length === 0) continue;
      }
      await deps.stripe.billing.meterEvents.create({
        event_name: METER_EVENT_NAME,
        identifier: `${row.teamId}:${row.periodStart.getTime()}:${from}:${to}`,
        timestamp: Math.floor(at.getTime() / 1000),
        payload: { stripe_customer_id: row.customerId, value: String(to - from) },
      });
      await deps.db
        .update(p)
        .set({ reportedOverage: to, pendingOverage: null })
        .where(and(key, eq(p.reportedOverage, from)));
      reported += 1;
    } catch (err) {
      failed += 1;
      log(`overage: team ${row.teamId} report failed: ${String(err)}`);
    }
  }
  return { reported, failed };
}
