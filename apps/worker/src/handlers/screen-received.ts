import type { AbuseJudge, Keyring, MonitorSettings, WebhookEnqueue } from "@millionsend/core";
import type { Db } from "@millionsend/db";

/** The received.screen job: the inbound judge for one pending membership. */
export async function screenReceived(
  _db: Db,
  _deps: {
    judge: AbuseJudge | null;
    keyring: Keyring;
    settings: MonitorSettings;
    timeoutMs: number;
    enqueueWebhookDeliveries: WebhookEnqueue;
    enqueueInboxForward: (p: { receivedEmailId: string; inboxId: string }) => Promise<void>;
  },
  _job: { receivedEmailId: string; inboxId: string },
): Promise<void> {
  throw new Error("INBOX_CONTRACT_STUB");
}
