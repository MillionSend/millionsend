import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, count, eq, gt, isNull, min, or, type SQL } from "drizzle-orm";
import type { Plan } from "../plans.js";
import { MAX_RECEIVED_MESSAGE_BYTES } from "../receiving/protocol.js";
import { DAY_MS } from "../utc-day.js";
import type { InboxKind } from "./types.js";

const HOUR_MS = 3_600_000;

/** Live inboxes per team per plan; null = unlimited. Self-host ignores plans entirely. */
export const PLAN_INBOX_LIMIT: Record<Plan, number | null> = {
  free: 3,
  starter: 25,
  pro: null,
  scale: null,
  system: null,
};

/**
 * Inbox creations per team per rolling hour; null = unlimited. Counted from
 * inbox_activity, so deleting inboxes never resets it.
 */
export const INBOX_CREATES_PER_HOUR: Record<Plan, number | null> = {
  free: 10,
  starter: 60,
  pro: 600,
  scale: 600,
  system: null,
};

/** Accepted messages per inbox per rolling hour before RCPT answers 452. */
export const INBOX_FLOOD_PER_HOUR: Record<InboxKind, number> = { agent: 200, human: 2000 };

export const INBOX_LABELS_MAX = 100;
export const INBOX_ALLOWLIST_MAX = 500;
export const INBOX_OWNER_ADDRESSES_MAX = 50;
export const INBOX_FORWARD_TO_MAX = 5;
/** Active inbox-scoped keys per inbox, outside the team's MAX_ACTIVE_API_KEYS. */
export const INBOX_KEYS_MAX = 5;

/** Milliseconds; an inbox may also never expire (null), which it does unless told otherwise. */
export const INBOX_MAX_TTL = 365 * DAY_MS;
/** Milliseconds a shared-domain inbox may go unused before the hourly sweep deletes it, whatever its expiry. */
export const SHARED_INBOX_IDLE_TTL = 90 * DAY_MS;
/** Milliseconds between two stamps of an inbox's last use. */
export const INBOX_USE_STAMP_INTERVAL = HOUR_MS;
/** Names the shared domain's identity review may refuse per team per UTC day before it stops reviewing. */
export const SHARED_NAME_REFUSALS_PER_DAY = 20;
/** Reviews of shared-domain names per team per UTC day, each a judge call, refused or not. */
export const SHARED_NAME_REVIEWS_PER_DAY = 200;
/** Milliseconds a pending_approval draft waits before it expires. */
export const DRAFT_APPROVAL_TTL = 7 * DAY_MS;
/** Milliseconds a trashed thread is kept. */
export const TRASH_RETENTION = 30 * DAY_MS;
/** Milliseconds a received code or link counts as private for outgoing mail. */
export const RECEIVED_SECRET_WINDOW = 24 * HOUR_MS;

export const LONG_POLL_MAX_SECONDS = 50;
export const WAITS_PER_TEAM_PER_PROCESS = 20;
/** Long-polls one API process holds for all teams together: each polls the database about once a second. */
export const WAITS_PER_PROCESS = 200;
export const INBOUND_QUARANTINE_SCORE = 80;
export const INBOUND_JUDGE_PER_INBOX_DAILY = 200;
export const CLAMAV_TIMEOUT_MS = 30_000;
export const CLAMAV_MAX_BYTES = MAX_RECEIVED_MESSAGE_BYTES;
/** to + cc + bcc of one reply, forward or draft (Resend's limit). */
export const RECIPIENTS_PER_SEND_MAX = 50;

/** An inbox lifetime: 1-9999 hours or days. */
export const EXPIRES_IN_RE = /^[1-9][0-9]{0,3}[hd]$/;

/** Milliseconds an `expires_in` value stands for; null when it is not one (EXPIRES_IN_RE). */
export function expiresInMs(value: string): number | null {
  if (!EXPIRES_IN_RE.test(value)) return null;
  return Number(value.slice(0, -1)) * (value.endsWith("d") ? DAY_MS : HOUR_MS);
}

/** An inbox reads as gone from the moment it expires, before the sweep deletes it. */
export const liveInbox = (now: Date): SQL | undefined =>
  or(isNull(schema.inboxes.expiresAt), gt(schema.inboxes.expiresAt, now));

/** A live inbox of the team by id or by address. */
export async function findLiveInbox(
  db: Db,
  p: { teamId: string; inboxId?: string | undefined; address?: string | undefined; now?: Date },
): Promise<typeof schema.inboxes.$inferSelect | null> {
  const i = schema.inboxes;
  const match = p.inboxId
    ? eq(i.id, p.inboxId)
    : eq(i.emailAddress, (p.address ?? "").toLowerCase());
  const [row] = await db
    .select()
    .from(i)
    .where(and(eq(i.teamId, p.teamId), match, liveInbox(p.now ?? new Date())))
    .limit(1);
  return row ?? null;
}

/**
 * How many more inboxes the team may create under its plan's cap; null when
 * nothing caps them (self-host, uncapped plans). Read before an insert, not
 * locked, like contactRoom: a race can land one past the cap.
 */
export async function inboxRoom(
  db: Db,
  teamId: string,
  plan: Plan,
  isCloud: boolean,
  now: Date = new Date(),
): Promise<number | null> {
  const limit = isCloud ? PLAN_INBOX_LIMIT[plan] : null;
  if (limit === null) return null;
  const [row] = await db
    .select({ n: count() })
    .from(schema.inboxes)
    .where(and(eq(schema.inboxes.teamId, teamId), liveInbox(now)));
  return Math.max(0, limit - (row?.n ?? 0));
}

/**
 * Creations left in the team's rolling hour, and when the oldest one in it
 * ages out; null when nothing caps them (self-host, system plan).
 */
export async function inboxCreatesLeft(
  db: Db,
  teamId: string,
  plan: Plan,
  isCloud: boolean,
  now: Date = new Date(),
): Promise<{ left: number; retryAfterSec: number } | null> {
  const limit = isCloud ? INBOX_CREATES_PER_HOUR[plan] : null;
  if (limit === null) return null;
  const a = schema.inboxActivity;
  const [row] = await db
    .select({ n: count(), oldest: min(a.createdAt) })
    .from(a)
    .where(
      and(
        eq(a.teamId, teamId),
        eq(a.action, "inbox.created"),
        gt(a.createdAt, new Date(now.getTime() - HOUR_MS)),
      ),
    );
  const oldest = row?.oldest ? new Date(row.oldest).getTime() : now.getTime();
  return {
    left: Math.max(0, limit - (row?.n ?? 0)),
    retryAfterSec: Math.max(1, Math.ceil((oldest + HOUR_MS - now.getTime()) / 1000)),
  };
}
