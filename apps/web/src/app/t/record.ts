import { env, isCloudDeployment, OPEN_PREFETCH_WINDOW_SECONDS_DEFAULT } from "@millionsend/config";
import {
  applyStatusCas,
  bumpHourlyUsage,
  classifyOpen,
  deriveTrackingKey,
  enqueueWebhookDeliveries,
  forwardedClientIp,
  highestStatus,
  type QueuedWebhookDelivery,
  utcDay,
  type WebhookEnqueue,
} from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
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

/**
 * Two different links of one message hit this close together were fetched
 * by a machine walking the message, whatever it calls itself: a person
 * reads before the next click. The gateways seen so far fan out in under
 * thirty milliseconds.
 */
const BURST_WINDOW_MS = 1_000;

type RecordedType = "opened" | "clicked" | "prefetched";

interface EmailFacts {
  id: string;
  teamId: string;
  from: string;
  to: string[];
  subject: string;
}

interface FoldedClick {
  id: string;
  occurredAt: Date;
  data: Record<string, unknown> | null;
}

const earliest = (rows: readonly { occurredAt: Date }[]) =>
  new Date(Math.min(...rows.map((row) => row.occurredAt.getTime())));

/** Takes back a unique counter on the day and hour its first event advanced. */
async function retractCounter(
  tx: Db,
  teamId: string,
  counter: "opened" | "clicked",
  at: Date,
): Promise<void> {
  await tx.execute(sql`
    update ${schema.usageCounters}
    set ${sql.raw(counter)} = ${schema.usageCounters}.${sql.raw(counter)} - 1
    where team_id = ${teamId} and day = ${utcDay(at)}
  `);
  await bumpHourlyUsage(tx, { teamId, at, counts: { [counter]: -1 } });
}

/**
 * A click recorded before the burst around it could be seen was a
 * machine's after all. The row becomes a prefetch, the open inferred from
 * it goes, and what the click advanced — status, unique counters,
 * deliveries not yet posted — is taken back. A delivery already posted
 * stays posted: the opt-in `email.prefetched` that follows carries the
 * click's own timestamp, which is how a consumer learns it was retracted.
 */
async function foldBurst(
  tx: Db,
  email: EmailFacts,
  folded: readonly FoldedClick[],
  deliveries: QueuedWebhookDelivery[],
): Promise<void> {
  await tx
    .update(schema.emailEvents)
    .set({
      type: "prefetched",
      data: sql`jsonb_set(${schema.emailEvents.data}, '{click,reason}', '"burst"')`,
    })
    .where(
      inArray(
        schema.emailEvents.id,
        folded.map((row) => row.id),
      ),
    );
  // The open inferred from a click is stamped one millisecond before it.
  const removedOpens = await tx
    .delete(schema.emailEvents)
    .where(
      and(
        eq(schema.emailEvents.emailId, email.id),
        eq(schema.emailEvents.type, "opened"),
        sql`${schema.emailEvents.data}->'open'->>'reason' = 'click'`,
        inArray(
          schema.emailEvents.occurredAt,
          folded.map((row) => new Date(row.occurredAt.getTime() - 1)),
        ),
      ),
    )
    .returning({ occurredAt: schema.emailEvents.occurredAt });
  await tx.delete(schema.webhookDeliveries).where(
    and(
      eq(schema.webhookDeliveries.emailId, email.id),
      eq(schema.webhookDeliveries.status, "pending"),
      eq(schema.webhookDeliveries.attempts, 0),
      inArray(schema.webhookDeliveries.eventType, ["email.clicked", "email.opened"]),
      inArray(
        sql`${schema.webhookDeliveries.payload}->>'created_at'`,
        [...folded, ...removedOpens].map((row) => row.occurredAt.toISOString()),
      ),
    ),
  );
  const remaining = (
    await tx
      .selectDistinct({ type: schema.emailEvents.type })
      .from(schema.emailEvents)
      .where(eq(schema.emailEvents.emailId, email.id))
  ).map((row) => row.type);
  // A unique counter advanced on the email's first event of its type; with
  // none left, that event was among the ones taken back.
  if (!remaining.includes("clicked")) {
    await retractCounter(tx, email.teamId, "clicked", earliest(folded));
  }
  if (removedOpens.length > 0 && !remaining.includes("opened")) {
    await retractCounter(tx, email.teamId, "opened", earliest(removedOpens));
  }
  // The status stood on a person's click; the remaining events say what it
  // is. A tracking token only exists in a message that was sent, so that is
  // the least the row can say once older events have aged out.
  await tx
    .update(schema.emails)
    .set({ latestStatus: highestStatus(remaining) ?? "sent" })
    .where(
      and(
        eq(schema.emails.id, email.id),
        inArray(schema.emails.latestStatus, ["opened", "clicked"]),
      ),
    );
  for (const row of folded) {
    const click = { ...(row.data?.click as Record<string, unknown>), reason: "burst" };
    await enqueueWebhookDeliveries(tx, {
      teamId: email.teamId,
      email: { emailId: email.id, from: email.from, to: email.to, subject: email.subject },
      type: "email.prefetched",
      occurredAt: row.occurredAt,
      extras: { click },
      enqueue: async (rows) => {
        deliveries.push(...rows);
      },
    });
  }
}

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
 * type, link): a person who clicks a second link a moment later made a
 * second click. The daily usage counter still advances only on the FIRST
 * event of its type for this email — open/click RATES stay unique-based,
 * mirroring the old SES OPEN/CLICK path. Both endpoints are public, so a
 * missing/foreign/non-uuid emailId returns silently.
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
    // The email row is held for the whole record: a gateway fetches every
    // link of a message at once, and each hit must see the rows the one
    // before it wrote before it damps, counts or lifts the status.
    const [email] = await tx
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
      .limit(1)
      .for("update");
    if (!email) return;

    let recorded: RecordedType = type;
    let data: Record<string, unknown>;
    // A link a machine followed is no click either — security gateways and
    // link previews fetch every URL seconds after delivery — so clicks pass
    // through the same rules as the pixel and land as prefetches when they fail.
    const verdict = classifyOpen({
      userAgent: hit?.userAgent ?? null,
      at: occurredAt,
      anchor: await openAnchor(tx, email),
      windowMs: prefetchWindowMs(),
    });
    // The other links of this message hit within the burst window. One is
    // enough: this hit is a machine's whatever it calls itself, and any of
    // those siblings still standing as a click is folded into a prefetch.
    const siblings =
      type === "clicked" && hit?.link !== undefined
        ? await tx
            .select({
              id: schema.emailEvents.id,
              type: schema.emailEvents.type,
              occurredAt: schema.emailEvents.occurredAt,
              data: schema.emailEvents.data,
            })
            .from(schema.emailEvents)
            .where(
              and(
                eq(schema.emailEvents.emailId, email.id),
                inArray(schema.emailEvents.type, ["clicked", "prefetched"]),
                sql`${schema.emailEvents.data}->'click'->>'link' <> ${hit.link}`,
                gt(schema.emailEvents.occurredAt, new Date(occurredAt.getTime() - BURST_WINDOW_MS)),
              ),
            )
        : [];
    if (verdict.prefetched || siblings.length > 0) recorded = "prefetched";
    const reason =
      recorded === "prefetched" ? { reason: verdict.prefetched ? verdict.reason : "burst" } : {};
    if (type === "clicked") {
      data = {
        click: { ...(hit?.link === undefined ? {} : { link: hit.link }), ...fetcher, ...reason },
      };
    } else {
      data = { open: { ...fetcher, ...reason } };
    }

    // Damping compares like with like: a link against earlier hits on that
    // same link, the pixel against earlier pixel fetches. Prefetched rows
    // hold either shape, so the shape is part of the match.
    const sameHit =
      type === "clicked"
        ? sql`${schema.emailEvents.data}->'click'->>'link' = ${hit?.link ?? ""}`
        : sql`${schema.emailEvents.data} ? 'open'`;
    const [newest] = await tx
      .select({ occurredAt: schema.emailEvents.occurredAt })
      .from(schema.emailEvents)
      .where(
        and(
          eq(schema.emailEvents.emailId, email.id),
          eq(schema.emailEvents.type, recorded),
          sameHit,
        ),
      )
      .orderBy(desc(schema.emailEvents.occurredAt))
      .limit(1);
    if (newest && occurredAt.getTime() - newest.occurredAt.getTime() < DAMP_WINDOW_MS) return;
    const [prior] = await tx
      .select({ id: schema.emailEvents.id })
      .from(schema.emailEvents)
      .where(and(eq(schema.emailEvents.emailId, email.id), eq(schema.emailEvents.type, recorded)))
      .limit(1);
    const folded = siblings.filter((row) => row.type === "clicked");
    if (folded.length > 0) await foldBurst(tx, email, folded, deliveries);

    await tx
      .insert(schema.emailEvents)
      .values({ emailId: email.id, type: recorded, occurredAt, data });
    // A prefetch is a fact about a machine, never about the recipient: the
    // status ladder moves only for a person.
    if (recorded !== "prefetched") await applyStatusCas(tx, email.id, recorded);

    // A person cannot click a link in a message they never rendered, so a
    // click on an email with no open yet is also its open — the only way one
    // can ever be recorded for a reader whose client served the pixel from a
    // cache (Apple Mail Privacy Protection). Stamped a millisecond earlier so
    // the timeline reads open, then click; marked so consumers can tell it
    // from a pixel fetch.
    if (recorded === "clicked") {
      const [opened] = await tx
        .select({ id: schema.emailEvents.id })
        .from(schema.emailEvents)
        .where(and(eq(schema.emailEvents.emailId, email.id), eq(schema.emailEvents.type, "opened")))
        .limit(1);
      if (!opened) {
        const openedAt = new Date(occurredAt.getTime() - 1);
        const open = { ...fetcher, timestamp: openedAt.toISOString(), reason: "click" };
        await tx
          .insert(schema.emailEvents)
          .values({ emailId: email.id, type: "opened", occurredAt: openedAt, data: { open } });
        await enqueueWebhookDeliveries(tx, {
          teamId: email.teamId,
          email: { emailId: email.id, from: email.from, to: email.to, subject: email.subject },
          type: "email.opened",
          occurredAt: openedAt,
          extras: { open },
          enqueue: async (rows) => {
            deliveries.push(...rows);
          },
        });
        await tx.execute(sql`
          insert into ${schema.usageCounters} (team_id, day, opened)
          values (${email.teamId}, ${utcDay(openedAt)}, 1)
          on conflict (team_id, day) do update
            set opened = ${schema.usageCounters}.opened + 1
        `);
        await bumpHourlyUsage(tx, { teamId: email.teamId, at: openedAt, counts: { opened: 1 } });
      }
    }

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
    if (!prior) {
      await tx.execute(sql`
        insert into ${schema.usageCounters} (team_id, day, ${sql.raw(recorded)})
        values (${email.teamId}, ${utcDay(occurredAt)}, 1)
        on conflict (team_id, day) do update
          set ${sql.raw(recorded)} = ${schema.usageCounters}.${sql.raw(recorded)} + 1
      `);
      await bumpHourlyUsage(tx, {
        teamId: email.teamId,
        at: occurredAt,
        counts: { [recorded]: 1 },
      });
    }
  });

  if (enqueueWebhookDeliveriesFn && deliveries.length > 0) {
    try {
      await enqueueWebhookDeliveriesFn(deliveries);
    } catch (err) {
      console.error("webhook drain enqueue failed; reconcile sweep will recover", err);
    }
  }
}
