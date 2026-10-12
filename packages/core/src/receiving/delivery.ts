import type { Db } from "@millionsend/db";
import type { InboxActor } from "../inboxes/activity.js";
import type { WebhookEnqueue } from "../webhooks.js";

export interface DeliveryDeps {
  enqueueWebhookDeliveries?: WebhookEnqueue | undefined;
  enqueueInboxForward?:
    | ((p: { receivedEmailId: string; inboxId: string }) => Promise<void>)
    | undefined;
}

/** inboxId null releases a virus-held catch-all row. Never re-judges. */
export async function releaseQuarantined(
  _db: Db,
  _deps: DeliveryDeps,
  _p: {
    teamId: string;
    receivedEmailId: string;
    inboxId: string | null;
    actor: InboxActor;
    trustSender: boolean;
    now?: Date | undefined;
  },
): Promise<
  | { ok: true; releasedAt: Date; trustedSender: string | null }
  | { ok: false; reason: "not_found" | "not_quarantined" | "allowlist_full" }
> {
  throw new Error("INBOX_CONTRACT_STUB");
}

/** Re-enqueues memberships pending past the screening deadline; how many it re-enqueued. */
export async function reconcilePendingScreens(
  _db: Db,
  _enqueue: (p: { receivedEmailId: string; inboxId: string }) => Promise<void>,
  _now?: Date | undefined,
): Promise<number> {
  throw new Error("INBOX_CONTRACT_STUB");
}
