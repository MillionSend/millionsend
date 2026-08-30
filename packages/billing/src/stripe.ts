import Stripe from "stripe";

/**
 * The slice of the Stripe SDK billing touches. The real client satisfies it
 * structurally; tests hand in a fake with the same shape.
 */
export interface BillingStripe {
  prices: { list(params: Stripe.PriceListParams): Promise<Stripe.ApiList<Stripe.Price>> };
  customers: { create(params: Stripe.CustomerCreateParams): Promise<Stripe.Customer> };
  subscriptions: {
    retrieve(id: string, params?: Stripe.SubscriptionRetrieveParams): Promise<Stripe.Subscription>;
    list(params: Stripe.SubscriptionListParams): Promise<Stripe.ApiList<Stripe.Subscription>>;
    cancel(id: string, params?: Stripe.SubscriptionCancelParams): Promise<Stripe.Subscription>;
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
