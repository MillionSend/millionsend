import { type BillingStripe, createStripe } from "@millionsend/billing";
import { env } from "@millionsend/config";

let client: BillingStripe | undefined;

/** Process-wide Stripe client; only reached on cloud paths, where boot validation guarantees the key. */
export function getStripe(): BillingStripe {
  client ??= createStripe(env.STRIPE_SECRET_KEY ?? "");
  return client;
}
