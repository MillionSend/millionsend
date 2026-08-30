import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { eq, sql } from "drizzle-orm";
import { type PaidPlan, resolvePrices } from "./prices.js";
import type { BillingStripe } from "./stripe.js";

export interface BillingDeps {
  db: Db;
  stripe: BillingStripe;
  log?: ((message: string) => void) | undefined;
}

export interface BillingTeam {
  id: string;
  name: string;
  stripeCustomerId: string | null;
}

type PlanStatus = (typeof schema.planStatusEnum.enumValues)[number];

/**
 * Stripe still holds a subscription for the team under these statuses; a
 * second Checkout would stack another one and bill twice. Changes go through
 * the portal instead.
 */
const LIVE_SUBSCRIPTION_STATUSES: ReadonlySet<PlanStatus> = new Set<PlanStatus>([
  "active",
  "trialing",
  "past_due",
  "unpaid",
]);

export function hasLiveSubscription(status: PlanStatus): boolean {
  return LIVE_SUBSCRIPTION_STATUSES.has(status);
}

/**
 * The customer is created before Checkout (not by it) so the webhook can
 * always locate the team by stripe_customer_id. Concurrent first checkouts
 * may each create a customer; COALESCE keeps whichever linked first and both
 * requests continue with it (the loser is an empty, never-referenced customer).
 */
async function ensureCustomer(
  deps: BillingDeps,
  team: BillingTeam,
  email: string,
): Promise<string> {
  if (team.stripeCustomerId) return team.stripeCustomerId;
  const customer = await deps.stripe.customers.create({
    name: team.name,
    email,
    metadata: { team_id: team.id },
  });
  const [linked] = await deps.db
    .update(schema.teams)
    .set({ stripeCustomerId: sql`coalesce(${schema.teams.stripeCustomerId}, ${customer.id})` })
    .where(eq(schema.teams.id, team.id))
    .returning({ stripeCustomerId: schema.teams.stripeCustomerId });
  return linked?.stripeCustomerId ?? customer.id;
}

export async function createCheckoutSession(
  deps: BillingDeps,
  input: {
    team: BillingTeam;
    plan: PaidPlan;
    email: string;
    successUrl: string;
    cancelUrl: string;
  },
): Promise<string> {
  const [prices, customer] = await Promise.all([
    resolvePrices(deps.stripe),
    ensureCustomer(deps, input.team, input.email),
  ]);
  const session = await deps.stripe.checkout.sessions.create(
    {
      mode: "subscription",
      customer,
      client_reference_id: input.team.id,
      line_items: [{ price: prices[input.plan], quantity: 1 }],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      automatic_tax: { enabled: true },
      tax_id_collection: { enabled: true },
      allow_promotion_codes: true,
      billing_address_collection: "auto",
      // Automatic tax on an existing customer requires Checkout to persist the
      // collected address (and the business name for tax ids) onto it.
      customer_update: { address: "auto", name: "auto" },
    },
    // A double-click or two tabs within the same minute replay one session
    // instead of minting several.
    {
      idempotencyKey: `checkout:${input.team.id}:${input.plan}:${Math.floor(Date.now() / 60_000)}`,
    },
  );
  if (!session.url) throw new Error("Stripe checkout session has no url");
  return session.url;
}

export async function createPortalSession(
  stripe: BillingStripe,
  input: { customerId: string; returnUrl: string; configuration?: string | undefined },
): Promise<string> {
  const session = await stripe.billingPortal.sessions.create({
    customer: input.customerId,
    return_url: input.returnUrl,
    ...(input.configuration ? { configuration: input.configuration } : {}),
  });
  return session.url;
}
