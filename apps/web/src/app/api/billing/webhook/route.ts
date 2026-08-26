import { handleWebhook } from "@millionsend/billing";
import { env } from "@millionsend/config";
import { getDb } from "@millionsend/db";
import { getStripe } from "@/server/billing";

/**
 * Stripe webhook endpoint. Unauthenticated by design: the raw body is
 * verified against STRIPE_WEBHOOK_SECRET inside handleWebhook, which is also
 * the ONLY writer of teams.plan.
 */
export async function POST(request: Request) {
  if (!env.IS_CLOUD) return new Response(null, { status: 404 });
  const rawBody = await request.text().catch(() => "");
  const status = await handleWebhook(rawBody, request.headers.get("stripe-signature"), {
    db: getDb(),
    stripe: getStripe(),
    webhookSecret: env.STRIPE_WEBHOOK_SECRET ?? "",
  });
  return new Response(null, { status });
}
