import type { BillingStripe } from "./stripe.js";

/**
 * The fingerprints of the cards a customer saved. Stripe gives the same card
 * number the same fingerprint across customers, which is what ties a new
 * team's card to a suspended one's.
 */
export async function cardFingerprints(
  stripe: BillingStripe,
  customerId: string,
): Promise<string[]> {
  const methods = await stripe.paymentMethods.list({
    customer: customerId,
    type: "card",
    limit: 20,
  });
  return [...new Set(methods.data.flatMap((method) => method.card?.fingerprint ?? []))];
}
