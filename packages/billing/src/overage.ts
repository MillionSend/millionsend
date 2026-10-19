import { DAY_MS, teamRung } from "@millionsend/core";
import { schema } from "@millionsend/db";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { BillingDeps } from "./checkout.js";
import { METER_EVENT_NAME } from "./prices.js";

/** Stripe refuses meter events older than this; a row that stale is logged and left. */
const METER_MAX_AGE_MS = 35 * DAY_MS;

/** Refuses a move up while Stripe has not yet counted the overage reported for the period. */
export class OverageInFlightError extends Error {
  constructor() {
    super("overage_in_flight");
  }
}

export interface OverageReport {
  reported: number;
  /** Steps Stripe refused; each stays pinned for the next run. */
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
 * period closes). Stripe bills nothing reported on the old price between a
 * move up's request and its payment, so while a team's move up waits on
 * payment its running period is skipped: the wait's sends are reported once
 * the move applies (against the new volume) or lapses.
 */
export async function reportOverage(
  deps: BillingDeps,
  opts: {
    now?: Date;
    teamId?: string;
    /** Reports even while a move up waits: the caller's own change voids that wait. */
    throughHold?: boolean;
  } = {},
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
      moveUpPendingUntil: t.moveUpPendingUntil,
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
    // The system plan has no rung and is never metered, whatever Stripe ids
    // its row still carries; one throw here would stop the run for every team.
    if (row.plan === "system") continue;
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
    // Only the running period waits on a move up's payment: an ended
    // period's invoice closes within the hour.
    const running = at === now;
    if (running && !opts.throughHold && row.moveUpPendingUntil && row.moveUpPendingUntil > now) {
      continue;
    }
    if (now.getTime() - at.getTime() > METER_MAX_AGE_MS) {
      log(
        `overage: team ${row.teamId} period ${row.periodStart.toISOString()} is too old to meter`,
      );
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

/**
 * Stripe drops a meter event it has not counted yet when the metered price
 * changes, and counting takes about a minute. A move up re-prices the metered
 * item, so it waits until the overage reported for the period is counted,
 * give or take 1% of the volume (at least 1,000 emails): a burst sent just
 * before the move would otherwise never bill.
 */
export async function assertOverageCounted(
  deps: BillingDeps,
  input: { teamId: string; customerId: string; periodStart: Date; included: number; now?: Date },
): Promise<void> {
  const p = schema.usagePeriods;
  const [row] = await deps.db
    .select({ reported: p.reportedOverage, pending: p.pendingOverage })
    .from(p)
    .where(and(eq(p.teamId, input.teamId), eq(p.periodStart, input.periodStart)));
  // A pinned step is one Stripe refused or another run is still sending:
  // the move would drop it, and nothing would report the period again.
  if (row && row.pending !== null && row.pending > row.reported) {
    throw new OverageInFlightError();
  }
  const slack = Math.max(1_000, Math.ceil(input.included / 100));
  const reported = row?.reported ?? 0;
  if (reported <= slack) return;
  const { data: meters } = await deps.stripe.billing.meters.list({ status: "active", limit: 100 });
  const meter = meters.find((m) => m.event_name === METER_EVENT_NAME);
  if (!meter) throw new Error(`Stripe meter ${METER_EVENT_NAME} not found`);
  // Minute-aligned, as the summaries ask; starting after the period's first
  // minute leaves out the previous period's last events, stamped a second
  // before its end.
  const minute = 60;
  const now = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const { data } = await deps.stripe.billing.meters.listEventSummaries(meter.id, {
    customer: input.customerId,
    start_time: Math.ceil(input.periodStart.getTime() / 1000 / minute) * minute,
    end_time: (Math.floor(now / minute) + 2) * minute,
  });
  const counted = data.reduce((sum, s) => sum + s.aggregated_value, 0);
  if (reported - counted > slack) throw new OverageInFlightError();
}
