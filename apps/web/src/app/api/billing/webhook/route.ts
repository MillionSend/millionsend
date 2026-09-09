import { handleWebhook, isLiveKey } from "@millionsend/billing";
import { accountEmailFrom, env } from "@millionsend/config";
import {
  type AccountMailKind,
  accountMailPhrase,
  claimNotification,
  effectivePlan,
  formatMailDate,
  listTeamOwners,
  type MailLocale,
  PLAN_DAILY_LIMIT,
  PLAN_NAME,
  planCapPhrase,
  raisesDailyLimit,
  recordAudit,
} from "@millionsend/core";
import { type Db, getDb, schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import { appBaseUrl } from "@/lib/api-base-url";
import { getStripe } from "@/server/billing";
import { getQueue } from "@/server/queue";
import { buildAccountEmail, sendAccountMail } from "@/server/system-mail";

const BILLING_PATH = "/settings/billing";

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
    if (after) {
      try {
        await mailOwners(db, event, before, after);
      } catch (err) {
        console.error("billing webhook: owner mail skipped", err);
      }
    }
  }
  return new Response(null, { status });
}

interface BillingEvent {
  type: string;
  customerId: string;
  /** Set on invoice events; how Stripe reports a failed charge and its own retry. */
  invoice: {
    id: string;
    attemptCount: number;
    nextAttempt: Date | null;
    hostedUrl: string | null;
  } | null;
}

function parseEvent(rawBody: string): BillingEvent | null {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { type, data } = parsed as {
      type?: unknown;
      data?: {
        object?: {
          id?: unknown;
          customer?: unknown;
          attempt_count?: unknown;
          next_payment_attempt?: unknown;
          hosted_invoice_url?: unknown;
        };
      };
    };
    const object = data?.object;
    const customer = object?.customer;
    const customerId =
      typeof customer === "string"
        ? customer
        : typeof customer === "object" && customer !== null && "id" in customer
          ? String(customer.id)
          : null;
    if (typeof type !== "string" || !customerId) return null;
    const invoice =
      type.startsWith("invoice.") && typeof object?.id === "string"
        ? {
            id: object.id,
            attemptCount: typeof object.attempt_count === "number" ? object.attempt_count : 0,
            nextAttempt:
              typeof object.next_payment_attempt === "number"
                ? new Date(object.next_payment_attempt * 1000)
                : null,
            hostedUrl:
              typeof object.hosted_invoice_url === "string" ? object.hosted_invoice_url : null,
          }
        : null;
    return { type, customerId, invoice };
  } catch {
    return null;
  }
}

async function planOf(db: Db, customerId: string) {
  const [team] = await db
    .select({
      id: schema.teams.id,
      name: schema.teams.name,
      plan: schema.teams.plan,
      planStatus: schema.teams.planStatus,
      currentPeriodEnd: schema.teams.currentPeriodEnd,
      cancelAt: schema.teams.cancelAt,
    })
    .from(schema.teams)
    .where(eq(schema.teams.stripeCustomerId, customerId));
  return team ?? null;
}

type PlanRow = NonNullable<Awaited<ReturnType<typeof planOf>>>;

/**
 * What the owners hear about, read off the row before and after the event
 * rather than off the event itself, so a redelivered or reordered event says
 * nothing twice: activation and changes are the plan moving, a scheduled
 * cancellation is cancel_at appearing on a paid plan, and a downgrade is the
 * plan reaching free, which also covers an immediate cancellation. A failed
 * charge leaves the plan alone and is claimed per invoice attempt instead.
 */
async function mailOwners(db: Db, event: BillingEvent, before: PlanRow, after: PlanRow) {
  const from = accountEmailFrom();
  if (!from) return;
  const team = after.name;
  const freeCap = (locale: MailLocale) => (PLAN_DAILY_LIMIT.free ?? 0).toLocaleString(locale);
  const send = async (
    kind: AccountMailKind,
    values: (locale: MailLocale) => Record<string, string>,
    url?: string,
  ) => {
    for (const owner of await listTeamOwners(db, after.id, from)) {
      sendAccountMail(
        buildAccountEmail({
          to: owner.email,
          kind,
          locale: owner.locale,
          path: BILLING_PATH,
          url,
          values: values(owner.locale),
        }),
      );
    }
  };

  if (event.type === "invoice.payment_failed" && event.invoice && after.planStatus === "past_due") {
    const { id, attemptCount, nextAttempt, hostedUrl } = event.invoice;
    const claimed = await claimNotification(db, {
      teamId: after.id,
      kind: "billing.payment_failed",
      periodKey: `${id}:${attemptCount}`,
    });
    if (claimed) {
      await send(
        "billing.payment_failed",
        (locale) => ({
          team,
          plan: PLAN_NAME[after.plan],
          cap: planCapPhrase(locale, after.plan),
          freeCap: freeCap(locale),
          retry: nextAttempt
            ? accountMailPhrase({
                locale,
                kind: "billing.payment_failed",
                key: "retryOn",
                values: { date: formatMailDate(locale, nextAttempt) },
              })
            : accountMailPhrase({ locale, kind: "billing.payment_failed", key: "noRetry" }),
          billingUrl: `${appBaseUrl()}${BILLING_PATH}`,
        }),
        hostedUrl ?? undefined,
      );
    }
  }

  if (before.plan !== "free" && after.plan === "free") {
    // The sweep claims the same kind with the same period end when the grace
    // window lapses before Stripe's event arrives; whichever runs first wins.
    const claimed = await claimNotification(db, {
      teamId: after.id,
      kind: "billing.downgraded",
      periodKey: before.currentPeriodEnd?.toISOString() ?? "none",
    });
    if (claimed) {
      const ended = before.currentPeriodEnd ?? before.cancelAt ?? new Date();
      await send("billing.downgraded", (locale) => ({
        team,
        plan: PLAN_NAME[before.plan],
        date: formatMailDate(locale, ended),
        freeCap: freeCap(locale),
      }));
    }
    return;
  }
  if (before.plan === "free" && after.plan !== "free") {
    await send("billing.plan_activated", (locale) => ({
      team,
      plan: PLAN_NAME[after.plan],
      cap: planCapPhrase(locale, after.plan),
    }));
  } else if (before.plan !== after.plan) {
    await send("billing.plan_changed", (locale) => ({
      team,
      old: PLAN_NAME[before.plan],
      new: PLAN_NAME[after.plan],
      cap: planCapPhrase(locale, after.plan),
    }));
  }
  if (before.cancelAt === null && after.cancelAt !== null && after.plan !== "free") {
    const endsAt = after.cancelAt;
    await send("billing.cancel_scheduled", (locale) => ({
      team,
      plan: PLAN_NAME[after.plan],
      date: formatMailDate(locale, endsAt),
      freeCap: freeCap(locale),
    }));
  }
}
