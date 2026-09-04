import { handleWebhook, isLiveKey } from "@millionsend/billing";
import { env } from "@millionsend/config";
import { effectivePlan, raisesDailyLimit, recordAudit } from "@millionsend/core";
import { type Db, getDb, schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import { getStripe } from "@/server/billing";
import { getQueue } from "@/server/queue";

/**
 * Stripe webhook endpoint. Unauthenticated by design: the raw body is
 * verified against STRIPE_WEBHOOK_SECRET inside handleWebhook, which is also
 * the ONLY writer of teams.plan.
 */
export async function POST(request: Request) {
  if (!env.IS_CLOUD) return new Response(null, { status: 404 });
  const rawBody = await request.text().catch(() => "");
  const db = getDb();
  // The customer id is read before verification only to snapshot the plan;
  // nothing is written unless handleWebhook accepts the signature.
  const event = parseEvent(rawBody);
  const before = event ? await planOf(db, event.customerId) : null;
  const status = await handleWebhook(rawBody, request.headers.get("stripe-signature"), {
    db,
    stripe: getStripe(),
    webhookSecret: env.STRIPE_WEBHOOK_SECRET ?? "",
    livemode: isLiveKey(env.STRIPE_SECRET_KEY ?? ""),
  });
  if (status === 200 && event && before) {
    const after = await planOf(db, event.customerId);
    if (after && (after.plan !== before.plan || after.planStatus !== before.planStatus)) {
      await recordAudit(db, {
        teamId: after.id,
        actor: "stripe",
        action: "billing.subscription_updated",
        target: { type: "team", id: after.id },
        metadata: { eventType: event.type, plan: after.plan, planStatus: after.planStatus },
      });
      // Mail parked over the old cap would otherwise wait for the next
      // scheduled drain; a paying upgrade should release it at once. The cap
      // that parked it is the effective one (a lapsed period counts as free),
      // so the comparison uses that. Best-effort: the plan is already
      // committed, and the scheduled drain releases the mail regardless.
      if (
        raisesDailyLimit(
          effectivePlan(before.plan, before.currentPeriodEnd),
          effectivePlan(after.plan, after.currentPeriodEnd),
        )
      ) {
        try {
          await (await getQueue()).runCronNow("quota.drain");
        } catch (err) {
          console.error(
            "billing webhook: quota.drain kick failed; the scheduled drain will release the mail",
            err,
          );
        }
      }
    }
  }
  return new Response(null, { status });
}

function parseEvent(rawBody: string): { type: string; customerId: string } | null {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { type, data } = parsed as { type?: unknown; data?: { object?: { customer?: unknown } } };
    const customer = data?.object?.customer;
    const customerId =
      typeof customer === "string"
        ? customer
        : typeof customer === "object" && customer !== null && "id" in customer
          ? String(customer.id)
          : null;
    return typeof type === "string" && customerId ? { type, customerId } : null;
  } catch {
    return null;
  }
}

async function planOf(db: Db, customerId: string) {
  const [team] = await db
    .select({
      id: schema.teams.id,
      plan: schema.teams.plan,
      planStatus: schema.teams.planStatus,
      currentPeriodEnd: schema.teams.currentPeriodEnd,
    })
    .from(schema.teams)
    .where(eq(schema.teams.stripeCustomerId, customerId));
  return team ?? null;
}
