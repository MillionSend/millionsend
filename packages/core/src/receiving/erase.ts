import type { Db } from "@millionsend/db";
import type { InboxActor } from "../inboxes/activity.js";

/** Erases one received email now; false when the team has no such row. */
export async function deleteReceivedEmail(
  _db: Db,
  _p: { teamId: string; id: string; actor: InboxActor },
): Promise<boolean> {
  throw new Error("INBOX_CONTRACT_STUB");
}
