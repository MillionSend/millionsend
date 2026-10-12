import type { InboxSendDeps } from "@millionsend/core";
import type { Db } from "@millionsend/db";

/** The inbox.forward job: a delivered message passed on to the inbox's forward_to owners. */
export async function forwardToOwners(
  _db: Db,
  _deps: InboxSendDeps,
  _job: { receivedEmailId: string; inboxId: string },
): Promise<void> {
  throw new Error("INBOX_CONTRACT_STUB");
}
