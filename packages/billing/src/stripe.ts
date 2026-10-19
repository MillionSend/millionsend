import Stripe from "stripe";

/**
 * The slice of the Stripe SDK billing touches. The real client satisfies it
 * structurally; tests hand in a fake with the same shape.
 */
export interface BillingStripe {
  prices: { list(params: Stripe.PriceListParams): Promise<Stripe.ApiList<Stripe.Price>> };
  customers: { create(params: Stripe.CustomerCreateParams): Promise<Stripe.Customer> };
  paymentMethods: {
    list(params: Stripe.PaymentMethodListParams): Promise<Stripe.ApiList<Stripe.PaymentMethod>>;
  };
  subscriptions: {
    retrieve(id: string, params?: Stripe.SubscriptionRetrieveParams): Promise<Stripe.Subscription>;
    list(params: Stripe.SubscriptionListParams): Promise<Stripe.ApiList<Stripe.Subscription>>;
    update(id: string, params?: Stripe.SubscriptionUpdateParams): Promise<Stripe.Subscription>;
    cancel(id: string, params?: Stripe.SubscriptionCancelParams): Promise<Stripe.Subscription>;
  };
  subscriptionItems: {
    create(params: Stripe.SubscriptionItemCreateParams): Promise<Stripe.SubscriptionItem>;
    update(
      id: string,
      params?: Stripe.SubscriptionItemUpdateParams,
    ): Promise<Stripe.SubscriptionItem>;
    del(
      id: string,
      params?: Stripe.SubscriptionItemDeleteParams,
    ): Promise<Stripe.DeletedSubscriptionItem>;
  };
  subscriptionSchedules: {
    create(params: Stripe.SubscriptionScheduleCreateParams): Promise<Stripe.SubscriptionSchedule>;
    update(
      id: string,
      params: Stripe.SubscriptionScheduleUpdateParams,
    ): Promise<Stripe.SubscriptionSchedule>;
    release(id: string): Promise<Stripe.SubscriptionSchedule>;
  };
  billing: {
    meterEvents: {
      create(params: Stripe.Billing.MeterEventCreateParams): Promise<Stripe.Billing.MeterEvent>;
    };
    meters: {
      list(params?: Stripe.Billing.MeterListParams): Promise<Stripe.ApiList<Stripe.Billing.Meter>>;
      listEventSummaries(
        id: string,
        params: Stripe.Billing.MeterListEventSummariesParams,
      ): Promise<Stripe.ApiList<Stripe.Billing.MeterEventSummary>>;
    };
  };
  invoices: {
    list(params: Stripe.InvoiceListParams): Promise<Stripe.ApiList<Stripe.Invoice>>;
    voidInvoice(id: string): Promise<Stripe.Invoice>;
  };
  /** Iterating the list auto-paginates, as the real client's list does. */
  charges: { list(params: Stripe.ChargeListParams): AsyncIterable<Stripe.Charge> };
  refunds: {
    create(
      params: Stripe.RefundCreateParams,
      options?: Stripe.RequestOptions,
    ): Promise<Stripe.Refund>;
  };
  checkout: {
    sessions: {
      create(
        params: Stripe.Checkout.SessionCreateParams,
        options?: Stripe.RequestOptions,
      ): Promise<Stripe.Checkout.Session>;
    };
  };
  billingPortal: {
    sessions: {
      create(
        params: Stripe.BillingPortal.SessionCreateParams,
      ): Promise<Stripe.BillingPortal.Session>;
    };
  };
  webhooks: { constructEvent(payload: string, header: string, secret: string): Stripe.Event };
}

export function createStripe(secretKey: string): BillingStripe {
  return new Stripe(secretKey);
}

/** Secret and restricted keys share the `_live_` / `_test_` mode marker. */
export function isLiveKey(secretKey: string): boolean {
  return /^[sr]k_live_/.test(secretKey);
}
