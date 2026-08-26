import Stripe from "stripe";

/**
 * The slice of the Stripe SDK billing touches. The real client satisfies it
 * structurally; tests hand in a fake with the same shape.
 */
export interface BillingStripe {
  prices: { list(params: Stripe.PriceListParams): Promise<Stripe.ApiList<Stripe.Price>> };
  customers: { create(params: Stripe.CustomerCreateParams): Promise<Stripe.Customer> };
  subscriptions: { retrieve(id: string): Promise<Stripe.Subscription> };
  checkout: {
    sessions: {
      create(params: Stripe.Checkout.SessionCreateParams): Promise<Stripe.Checkout.Session>;
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
