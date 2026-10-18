import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import Stripe from "stripe";
import type { BillingStripe } from "../src/stripe.js";

/** Signature verification is pure crypto; a key-less real client signs and verifies offline. */
export const webhooks: Stripe["webhooks"] = new Stripe("sk_test_x").webhooks;

/** Billing period every fixture subscription item carries, in Stripe seconds. */
export const PERIOD_START = 1_897_300_000;
export const PERIOD_END = 1_900_000_000;

/** Fake price ids are derived from the lookup key so a call can be matched back to its rung. */
export const priceId = (lookupKey: string | null) => `price_${lookupKey ?? "rotated"}`;
const lookupKeyOf = (id: string) => id.replace(/^price_/, "");
const isOverageKey = (key: string) => key.endsWith("_overage");

/** The product behind a price sold before the ladder: its metadata names the plan, its key no rung. */
export const legacyProduct = (plan: string) => ({
  id: `prod_${plan}`,
  object: "product",
  metadata: { millionsend_plan: plan },
});

export function price(
  lookupKey: string | null,
  extra: { product?: unknown; metadata?: Record<string, string>; metered?: boolean } = {},
): Stripe.Price {
  return {
    id: priceId(lookupKey),
    object: "price",
    active: true,
    lookup_key: lookupKey,
    metadata: extra.metadata ?? {},
    recurring: { interval: "month", usage_type: extra.metered ? "metered" : "licensed" },
    product: extra.product ?? "prod_1",
  } as unknown as Stripe.Price;
}

/** A licensed item carries quantity 1 like Stripe's; a metered one has no quantity. */
function item(id: string, p: Stripe.Price): Stripe.SubscriptionItem {
  const metered = p.recurring?.usage_type === "metered";
  return {
    id,
    object: "subscription_item",
    current_period_start: PERIOD_START,
    current_period_end: PERIOD_END,
    price: p,
    ...(metered ? {} : { quantity: 1 }),
  } as unknown as Stripe.SubscriptionItem;
}

/** An expanded subscription schedule whose last phase carries `items` (price objects, as expanded). */
export function schedule(items: unknown[], id = "sched_0"): Stripe.SubscriptionSchedule {
  return {
    id,
    object: "subscription_schedule",
    phases: [
      { start_date: PERIOD_START, end_date: PERIOD_END, items: items.map((price) => ({ price })) },
    ],
  } as unknown as Stripe.SubscriptionSchedule;
}

/**
 * A subscription with one plan item (`si_<id>`) and, given `overageKey`
 * (null for a rotated, key-less price), a metered item (`si_<id>_overage`).
 */
export function subscription(
  id: string,
  customer: string,
  status: Stripe.Subscription.Status,
  lookupKey: string | null = "millionsend_pro_100k_monthly",
  opts: {
    product?: unknown;
    metadata?: Record<string, string>;
    overageKey?: string | null;
    overageMetadata?: Record<string, string>;
    cancelAt?: number;
    schedule?: Stripe.SubscriptionSchedule;
  } = {},
): Stripe.Subscription {
  const data = [item(`si_${id}`, price(lookupKey, opts))];
  if (opts.overageKey !== undefined) {
    data.push(
      item(
        `si_${id}_overage`,
        price(opts.overageKey, {
          metered: true,
          ...(opts.overageMetadata ? { metadata: opts.overageMetadata } : {}),
        }),
      ),
    );
  }
  return {
    id,
    object: "subscription",
    customer,
    status,
    cancel_at: opts.cancelAt ?? null,
    schedule: opts.schedule ?? null,
    items: { object: "list", data },
  } as unknown as Stripe.Subscription;
}

/** A succeeded $20 card payment by `customer`, created at `created` (Stripe seconds). */
export function charge(
  id: string,
  customer: string,
  created: number,
  extra: Partial<Pick<Stripe.Charge, "amount" | "amount_refunded" | "currency">> & {
    status?: Stripe.Charge.Status;
    disputed?: boolean;
    refunded?: boolean;
  } = {},
): Stripe.Charge {
  return {
    id,
    object: "charge",
    customer,
    created,
    amount: 2000,
    amount_refunded: 0,
    currency: "usd",
    status: "succeeded",
    disputed: false,
    refunded: false,
    ...extra,
  } as unknown as Stripe.Charge;
}

/**
 * In-memory BillingStripe: subscriptions are plain fixtures the tests seed
 * and mutate; item, subscription and schedule updates edit them in place so
 * a re-fetch sees the change, and every write is recorded in `state`.
 * Charges are seeded the same way; a refund marks its charge refunded, and a
 * charge named in `refundErrors` fails its refund with that error.
 */
export function fakeStripe() {
  const state = {
    subscriptions: {} as Record<string, Stripe.Subscription>,
    calls: [] as string[],
    retrieves: [] as string[],
    retrieveParams: undefined as Stripe.SubscriptionRetrieveParams | undefined,
    listParams: undefined as Stripe.SubscriptionListParams | undefined,
    cancels: [] as string[],
    cancelParams: undefined as Stripe.SubscriptionCancelParams | undefined,
    charges: [] as Stripe.Charge[],
    chargeListParams: undefined as Stripe.ChargeListParams | undefined,
    refunds: [] as [Stripe.RefundCreateParams, Stripe.RequestOptions | undefined][],
    refundErrors: {} as Record<string, Error>,
    updates: [] as [string, Stripe.SubscriptionUpdateParams][],
    itemCreates: [] as Stripe.SubscriptionItemCreateParams[],
    itemUpdates: [] as [string, Stripe.SubscriptionItemUpdateParams | undefined][],
    itemDeletes: [] as string[],
    scheduleCreates: [] as Stripe.SubscriptionScheduleCreateParams[],
    scheduleUpdates: [] as [string, Stripe.SubscriptionScheduleUpdateParams][],
    scheduleReleases: [] as string[],
    meterEvents: [] as Stripe.Billing.MeterEventCreateParams[],
    meterError: null as Error | null,
    /** The bank declines (or wants confirmed) the charge a pending_if_incomplete update makes. */
    declineUpdates: false,
    /** What the meter's summaries have counted; null counts every event sent, as if Stripe were instant. */
    meterCounted: null as number | null,
    summaryParams: [] as [string, Stripe.Billing.MeterListEventSummariesParams][],
    customers: [] as Stripe.CustomerCreateParams[],
    checkouts: [] as Stripe.Checkout.SessionCreateParams[],
  };
  const sub = (id: string) => {
    const s = state.subscriptions[id];
    if (!s) throw new Error(`No such subscription: ${id}`);
    return s;
  };
  const findItem = (id: string) => {
    for (const s of Object.values(state.subscriptions)) {
      const idx = s.items.data.findIndex((i) => i.id === id);
      if (idx >= 0) return { s, idx };
    }
    throw new Error(`No such subscription item: ${id}`);
  };
  const scheduled = (id: string) => {
    const s = Object.values(state.subscriptions).find(
      (x) => typeof x.schedule === "object" && x.schedule?.id === id,
    );
    if (!s || typeof s.schedule !== "object" || !s.schedule) {
      throw new Error(`No such subscription schedule: ${id}`);
    }
    return { s, sched: s.schedule };
  };
  const repriced = (current: Stripe.Price, id: string) =>
    price(lookupKeyOf(id), { metered: current.recurring?.usage_type === "metered" });
  const stripe = {
    webhooks,
    prices: {
      async list(p: Stripe.PriceListParams) {
        state.calls.push("prices.list");
        return { data: (p.lookup_keys ?? []).map((k) => price(k, { metered: isOverageKey(k) })) };
      },
    },
    customers: {
      async create(p: Stripe.CustomerCreateParams) {
        state.calls.push("customers.create");
        state.customers.push(p);
        return { id: `cus_${state.customers.length}`, object: "customer" };
      },
    },
    subscriptions: {
      async retrieve(id: string, params?: Stripe.SubscriptionRetrieveParams) {
        state.calls.push("subscriptions.retrieve");
        state.retrieves.push(id);
        state.retrieveParams = params;
        return sub(id);
      },
      async list(params: Stripe.SubscriptionListParams) {
        state.calls.push("subscriptions.list");
        state.listParams = params;
        // Newest first, like Stripe.
        const data = Object.values(state.subscriptions)
          .filter((s) => s.customer === params.customer)
          .reverse();
        return { data: data.slice(0, params.limit ?? data.length) };
      },
      async update(id: string, params: Stripe.SubscriptionUpdateParams = {}) {
        state.calls.push("subscriptions.update");
        state.updates.push([id, params]);
        const s = sub(id);
        // Like Stripe's pending updates: nothing changes until the invoice is paid.
        if (state.declineUpdates && params.payment_behavior === "pending_if_incomplete") {
          return {
            ...s,
            pending_update: { expires_at: PERIOD_START + 82_800 },
            latest_invoice: {
              id: "in_pending",
              object: "invoice",
              status: "open",
              hosted_invoice_url: "https://invoice.stripe.com/i/in_pending",
            },
          };
        }
        for (const change of params.items ?? []) {
          if (!change.id) {
            if (change.price) {
              const key = lookupKeyOf(change.price);
              s.items.data.push(
                item(`si_${id}_overage`, price(key, { metered: isOverageKey(key) })),
              );
            }
            continue;
          }
          const idx = s.items.data.findIndex((i) => i.id === change.id);
          if (idx < 0) continue;
          const current = s.items.data[idx];
          if (change.deleted) s.items.data.splice(idx, 1);
          else if (change.price && current) current.price = repriced(current.price, change.price);
        }
        return s;
      },
      async cancel(id: string, params?: Stripe.SubscriptionCancelParams) {
        state.calls.push("subscriptions.cancel");
        state.cancels.push(id);
        state.cancelParams = params;
        return { ...sub(id), status: "canceled" };
      },
    },
    charges: {
      // Newest first, the customer's created in the window only, like Stripe.
      async *list(params: Stripe.ChargeListParams) {
        state.calls.push("charges.list");
        state.chargeListParams = params;
        const since = typeof params.created === "object" ? (params.created.gte ?? 0) : 0;
        yield* state.charges
          .filter((c) => c.customer === params.customer && c.created >= since)
          .sort((a, b) => b.created - a.created);
      },
    },
    refunds: {
      async create(p: Stripe.RefundCreateParams, options?: Stripe.RequestOptions) {
        state.calls.push("refunds.create");
        const error = state.refundErrors[p.charge ?? ""];
        if (error) throw error;
        state.refunds.push([p, options]);
        const refunded = state.charges.find((c) => c.id === p.charge);
        if (refunded) Object.assign(refunded, { amount_refunded: refunded.amount, refunded: true });
        return { id: `re_${state.refunds.length}`, object: "refund", charge: p.charge };
      },
    },
    subscriptionItems: {
      async create(p: Stripe.SubscriptionItemCreateParams) {
        state.calls.push("subscriptionItems.create");
        state.itemCreates.push(p);
        const created = item(
          `si_${p.subscription}_overage`,
          price(lookupKeyOf(p.price ?? ""), { metered: true }),
        );
        sub(p.subscription).items.data.push(created);
        return created;
      },
      async update(id: string, p?: Stripe.SubscriptionItemUpdateParams) {
        state.calls.push("subscriptionItems.update");
        state.itemUpdates.push([id, p]);
        const { s, idx } = findItem(id);
        const current = s.items.data[idx];
        if (current && p?.price) current.price = repriced(current.price, p.price);
        return current;
      },
      async del(id: string) {
        state.calls.push("subscriptionItems.del");
        state.itemDeletes.push(id);
        const { s, idx } = findItem(id);
        s.items.data.splice(idx, 1);
        return { id, object: "subscription_item", deleted: true };
      },
    },
    subscriptionSchedules: {
      async create(p: Stripe.SubscriptionScheduleCreateParams) {
        state.calls.push("subscriptionSchedules.create");
        state.scheduleCreates.push(p);
        const s = sub(p.from_subscription ?? "");
        const sched = {
          id: `sched_${state.scheduleCreates.length}`,
          object: "subscription_schedule",
          subscription: s.id,
          phases: [
            {
              start_date: PERIOD_START,
              end_date: PERIOD_END,
              items: s.items.data.map((i) => ({ price: i.price, quantity: i.quantity })),
            },
          ],
        } as unknown as Stripe.SubscriptionSchedule;
        s.schedule = sched;
        return sched;
      },
      async update(id: string, p: Stripe.SubscriptionScheduleUpdateParams) {
        state.calls.push("subscriptionSchedules.update");
        state.scheduleUpdates.push([id, p]);
        const { sched } = scheduled(id);
        // Phases come back with their prices expanded, as the retrieve asks for.
        sched.phases = (p.phases ?? []).map(
          (phase) =>
            ({
              ...phase,
              items: phase.items.map((i) => ({
                ...i,
                price: price(lookupKeyOf(i.price ?? ""), { metered: isOverageKey(i.price ?? "") }),
              })),
            }) as unknown as Stripe.SubscriptionSchedule.Phase,
        );
        return sched;
      },
      async release(id: string) {
        state.calls.push("subscriptionSchedules.release");
        state.scheduleReleases.push(id);
        const { s, sched } = scheduled(id);
        s.schedule = null;
        return { ...sched, status: "released" };
      },
    },
    billing: {
      meterEvents: {
        async create(p: Stripe.Billing.MeterEventCreateParams) {
          state.calls.push("billing.meterEvents.create");
          if (state.meterError) throw state.meterError;
          state.meterEvents.push(p);
          return p;
        },
      },
      meters: {
        async list() {
          state.calls.push("billing.meters.list");
          return { data: [{ id: "mtr_1", event_name: "emails_over_quota" }] };
        },
        async listEventSummaries(id: string, p: Stripe.Billing.MeterListEventSummariesParams) {
          state.calls.push("billing.meters.listEventSummaries");
          state.summaryParams.push([id, p]);
          const counted =
            state.meterCounted ??
            state.meterEvents.reduce((sum, e) => sum + Number(e.payload.value), 0);
          return { data: [{ aggregated_value: counted }] };
        },
      },
    },
    checkout: {
      sessions: {
        async create(p: Stripe.Checkout.SessionCreateParams) {
          state.calls.push("checkout.sessions.create");
          state.checkouts.push(p);
          return { url: `https://checkout.stripe.com/c/pay/cs_${state.checkouts.length}` };
        },
      },
    },
  } as unknown as BillingStripe;
  return { stripe, state };
}

/** The billing columns of a team row. */
export async function teamRow(db: Db, teamId: string) {
  const [row] = await db
    .select({
      plan: schema.teams.plan,
      planQuota: schema.teams.planQuota,
      planStatus: schema.teams.planStatus,
      stripeCustomerId: schema.teams.stripeCustomerId,
      stripeSubscriptionId: schema.teams.stripeSubscriptionId,
      stripeOverageItemId: schema.teams.stripeOverageItemId,
      overageEnabled: schema.teams.overageEnabled,
      pendingRung: schema.teams.pendingRung,
      currentPeriodStart: schema.teams.currentPeriodStart,
      currentPeriodEnd: schema.teams.currentPeriodEnd,
    })
    .from(schema.teams)
    .where(eq(schema.teams.id, teamId));
  return row;
}
