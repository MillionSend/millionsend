import { handleWebhook, isLiveKey } from "@millionsend/billing";
import { accountEmailFrom, env, notificationsEmailFrom } from "@millionsend/config";
import {
  type AccountMailKind,
  accountMailPhrase,
  CANCEL_REMINDER_DAYS,
  claimNotification,
  clearNotifications,
  DAY_MS,
  formatMailDate,
  freeCapText,
  listTeamOwners,
  type MailLocale,
  planCapPhrase,
  planLabel,
  planMove,
  QUOTA_COLUMNS,
  raisesQuota,
  recordAudit,
  teamQuota,
} from "@millionsend/core";
import { type Db, getDb, schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import { appBaseUrl } from "@/lib/api-base-url";
import { BILLING_PATH, getStripe, mailPlanMove } from "@/server/billing";
import { getQueue } from "@/server/queue";
import { buildAccountEmail, sendAccountMail } from "@/server/system-mail";

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
    if (after) {
      if (
        after.plan !== before.plan ||
        after.planQuota !== before.planQuota ||
        after.planStatus !== before.planStatus
      ) {
        await recordAudit(db, {
          teamId: after.id,
          actor: "stripe",
          action: "billing.subscription_updated",
          target: { type: "team", id: after.id },
          metadata: {
            eventType: event.type,
            plan: after.plan,
            planQuota: after.planQuota,
            planStatus: after.planStatus,
          },
        });
      }
      // Mail parked over the old cap would otherwise wait for the next
      // scheduled drain; a paying upgrade (or overage turning on) should
      // release it at once. The cap that parked it is the effective one (a
      // lapsed period counts as free), which teamQuota derives. Best-effort:
      // the plan is already committed, and the scheduled drain releases the
      // mail regardless.
      if (raisesQuota(teamQuota(before, true), teamQuota(after, true))) {
        try {
          await (await getQueue()).runCronNow("quota.drain");
        } catch (err) {
          console.error(
            "billing webhook: quota.drain kick failed; the scheduled drain will release the mail",
            err,
          );
        }
      }
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
      ...QUOTA_COLUMNS,
      planStatus: schema.teams.planStatus,
      cancelAt: schema.teams.cancelAt,
    })
    .from(schema.teams)
    .where(eq(schema.teams.stripeCustomerId, customerId));
  return team ?? null;
}

type PlanRow = NonNullable<Awaited<ReturnType<typeof planOf>>>;

/**
 * What the owners hear about, read off the row before and after the event
 * rather than off the event itself: activation and changes are the plan
 * moving, a scheduled cancellation is cancel_at appearing on a paid plan,
 * and a downgrade is the plan reaching free, which also covers an immediate
 * cancellation. Every mail is claimed, because Stripe delivers a checkout's
 * events in parallel and each request snapshots `before` outside the
 * customer lock, so all of them see the same move. A failed charge leaves
 * the plan alone and is claimed per invoice attempt.
 */
async function mailOwners(db: Db, event: BillingEvent, before: PlanRow, after: PlanRow) {
  const from = notificationsEmailFrom();
  if (!from) return;
  const team = after.name;
  const claim = (kind: AccountMailKind, periodKey: string) =>
    claimNotification(db, { teamId: after.id, kind, periodKey });
  const send = async (
    kind: AccountMailKind,
    values: (locale: MailLocale) => Record<string, string>,
    url?: string,
  ) => {
    for (const owner of await listTeamOwners(db, after.id, accountEmailFrom(), kind)) {
      sendAccountMail(
        buildAccountEmail({
          from,
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
    if (await claim("billing.payment_failed", `${id}:${attemptCount}`)) {
      await send(
        "billing.payment_failed",
        (locale) => ({
          team,
          plan: planLabel(after.plan, after.planQuota),
          cap: planCapPhrase(locale, after.plan, after.planQuota),
          freeCap: freeCapText(locale),
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

  // The dashboard's plan change, the daily reconcile and the grace sweep
  // claim a move with the same key.
  const move = planMove(before, after);
  if (move) {
    await mailPlanMove(db, { id: after.id, name: team }, before, after);
    if (move.kind === "billing.downgraded") return;
  }
  if (before.cancelAt !== null && after.cancelAt === null) {
    // Resumed: a later cancellation, even for the same date, is news again.
    await clearNotifications(db, { teamId: after.id, kind: "billing.cancel_scheduled" });
    await clearNotifications(db, { teamId: after.id, kind: "billing.cancel_reminder" });
  }
  if (before.cancelAt === null && after.cancelAt !== null && after.plan !== "free") {
    const endsAt = after.cancelAt;
    if (!(await claim("billing.cancel_scheduled", endsAt.toISOString()))) return;
    // Scheduled inside the reminder window, this notice is the reminder:
    // holding the sweep's claim keeps it from saying the same minutes later.
    if (endsAt.getTime() <= Date.now() + CANCEL_REMINDER_DAYS * DAY_MS) {
      await claim("billing.cancel_reminder", endsAt.toISOString());
    }
    await send("billing.cancel_scheduled", (locale) => ({
      team,
      plan: planLabel(after.plan, after.planQuota),
      date: formatMailDate(locale, endsAt),
      freeCap: freeCapText(locale),
    }));
  }
}
