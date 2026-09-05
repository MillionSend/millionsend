import { env, isCloudDeployment, OPEN_PREFETCH_WINDOW_SECONDS_DEFAULT } from "@millionsend/config";
import {
  applyStatusCas,
  classifyOpen,
  deriveTrackingKey,
  enqueueWebhookDeliveries,
  forwardedClientIp,
  type QueuedWebhookDelivery,
  utcDay,
  type WebhookEnqueue,
} from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { trustedProxies } from "../../server/trusted-proxies";

/**
 * Signing key for the open/click tokens the /t/o and /t/c endpoints verify.
 * Absent MASTER_ENCRYPTION_KEY (misconfigured deploy) there is no key, so every
 * token is treated as unverifiable — the endpoints degrade to 404 / blank pixel.
 */
export function trackingKey(): Buffer | null {
  if (!env.MASTER_ENCRYPTION_KEY) return null;
  return deriveTrackingKey(Buffer.from(env.MASTER_ENCRYPTION_KEY, "base64"));
}

/** What a tracking request tells us about the fetcher. */
export interface EngagementHit {
  userAgent: string | null;
  ipAddress: string | null;
  /** Click destination — the signed URL the redirect follows. */
  link?: string;
}

export function engagementHit(request: Request, link?: string): EngagementHit {
  return {
    userAgent: request.headers.get("user-agent"),
    ipAddress: forwardedClientIp(request.headers, {
      cloud: isCloudDeployment(),
      trustedProxies: trustedProxies(),
    }),
    ...(link === undefined ? {} : { link }),
  };
}

/**
 * Repeat hits within this window are dropped entirely: mail proxies (Gmail
 * image cache, Apple MP) refetch the pixel in bursts, and a burst is one
 * engagement, not several. Prefetches damp apart from opens, so a scanner
 * hit never swallows the person who opens a moment later.
 */
const DAMP_WINDOW_MS = 60_000;

type RecordedType = "opened" | "clicked" | "prefetched";

/** Under SKIP_ENV_VALIDATION the env proxy carries the raw string, not the parsed number. */
function prefetchWindowMs(): number {
  const raw: unknown = env.OPEN_PREFETCH_WINDOW_SECONDS;
  const seconds = Number(raw ?? OPEN_PREFETCH_WINDOW_SECONDS_DEFAULT);
  return (Number.isFinite(seconds) ? seconds : OPEN_PREFETCH_WINDOW_SECONDS_DEFAULT) * 1000;
}

/**
 * The moment a pixel fetch is measured against: the first delivery report
 * (SES's own timestamp, so ingestion lag never shortens the window), else the
 * send. Null before either, which turns the timing rules off. The pixel is
 * shared by every recipient, so the fetch is measured from when the message
 * first became readable: a later recipient's delivery must not re-arm the
 * window against an earlier recipient's open.
 */
async function openAnchor(
  tx: Db,
  email: { id: string; sentAt: Date | null },
): Promise<{ at: Date; delivered: boolean } | null> {
  const [delivered] = await tx
    .select({ occurredAt: schema.emailEvents.occurredAt })
    .from(schema.emailEvents)
    .where(and(eq(schema.emailEvents.emailId, email.id), eq(schema.emailEvents.type, "delivered")))
    .orderBy(asc(schema.emailEvents.occurredAt))
    .limit(1);
  if (delivered) return { at: delivered.occurredAt, delivered: true };
  return email.sentAt ? { at: email.sentAt, delivered: false } : null;
}

/**
 * Records an app-layer engagement event for a verified tracking token. The
 * teamId is read from the email row — never taken from the request — so a
 * token can only ever touch its own email's team.
 *
 * A pixel fetch is classified first: one a machine plausibly made lands as a
 * `prefetched` event, which is kept and fanned out (opt-in) but never lifts
 * the status or the opened counter. Every verified hit records an event row
 * (and fans out webhooks), damped to at most one per minute per (email,
 * type). The daily usage counter still advances only on the FIRST event of
 * its type for this email — open/click RATES stay unique-based, mirroring the
 * old SES OPEN/CLICK path. Both endpoints are public, so a missing/foreign/
 * non-uuid emailId returns silently.
 */
export async function recordEngagement(
  db: Db,
  emailId: string,
  type: "opened" | "clicked",
  enqueueWebhookDeliveriesFn?: WebhookEnqueue,
  hit?: EngagementHit,
): Promise<void> {
  // A raw non-uuid string must never reach a uuid column — Postgres would 500.
  if (!z.uuid().safeParse(emailId).success) return;

  const [email] = await db
    .select({
      id: schema.emails.id,
      teamId: schema.emails.teamId,
      from: schema.emails.from,
      to: schema.emails.to,
      subject: schema.emails.subject,
      sentAt: schema.emails.sentAt,
    })
    .from(schema.emails)
    .where(eq(schema.emails.id, emailId))
    .limit(1);
  if (!email) return;

  const occurredAt = new Date();
  // The fetcher's identity in SES's shape — the object Resend's email.clicked
  // carries as `click` — so the webhook payload and the detail page read one
  // record. Absent facts are omitted rather than nulled.
  const fetcher = {
    ...(hit?.ipAddress ? { ipAddress: hit.ipAddress } : {}),
    ...(hit?.userAgent ? { userAgent: hit.userAgent } : {}),
    timestamp: occurredAt.toISOString(),
  };
  const deliveries: QueuedWebhookDelivery[] = [];
  await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    let recorded: RecordedType = type;
    let data: Record<string, unknown>;
    if (type === "clicked") {
      data = { click: { ...(hit?.link === undefined ? {} : { link: hit.link }), ...fetcher } };
    } else {
      const verdict = classifyOpen({
        userAgent: hit?.userAgent ?? null,
        at: occurredAt,
        anchor: await openAnchor(tx, email),
        windowMs: prefetchWindowMs(),
      });
      if (verdict.prefetched) recorded = "prefetched";
      data = { open: verdict.prefetched ? { ...fetcher, reason: verdict.reason } : fetcher };
    }

    const [newest] = await tx
      .select({ occurredAt: schema.emailEvents.occurredAt })
      .from(schema.emailEvents)
      .where(and(eq(schema.emailEvents.emailId, email.id), eq(schema.emailEvents.type, recorded)))
      .orderBy(desc(schema.emailEvents.occurredAt))
      .limit(1);
    // ponytail: two concurrent identical hits could both miss `newest` and
    // slip the damping window — same race the SES path carries. A slightly-
    // high engagement event count is not a correctness/security concern; add
    // row locking if it ever matters.
    if (newest && occurredAt.getTime() - newest.occurredAt.getTime() < DAMP_WINDOW_MS) return;

    await tx
      .insert(schema.emailEvents)
      .values({ emailId: email.id, type: recorded, occurredAt, data });
    // A prefetch is a fact about a machine, never about the recipient: the
    // status ladder moves only for a person.
    if (recorded !== "prefetched") await applyStatusCas(tx, email.id, recorded);

    // Fan every recorded event out to the team's webhook endpoints (damped
    // no-ops above never reach this): delivery rows join this transaction
    // (so the webhooks.reconcile sweep can recover a lost enqueue), the queue
    // send happens after commit.
    await enqueueWebhookDeliveries(tx, {
      teamId: email.teamId,
      email: { emailId: email.id, from: email.from, to: email.to, subject: email.subject },
      type: `email.${recorded}`,
      occurredAt,
      extras: data,
      enqueue: async (rows) => {
        deliveries.push(...rows);
      },
    });

    // Counter advances only on the first (unique) event of its type per
    // email: dashboards divide it by sent/delivered, so it must count emails
    // engaged, not engagement hits. Last in the transaction: this row is
    // shared by every send and event of the team, so its lock is held for
    // one statement and the commit, not across the fan-out above.
    if (!newest) {
      await tx.execute(sql`
        insert into ${schema.usageCounters} (team_id, day, ${sql.raw(recorded)})
        values (${email.teamId}, ${utcDay(occurredAt)}, 1)
        on conflict (team_id, day) do update
          set ${sql.raw(recorded)} = ${schema.usageCounters}.${sql.raw(recorded)} + 1
      `);
    }
  });

  if (enqueueWebhookDeliveriesFn && deliveries.length > 0) {
    try {
      await enqueueWebhookDeliveriesFn(deliveries);
    } catch (err) {
      console.error("webhook.deliver enqueue failed; reconcile sweep will recover", err);
    }
  }
}
