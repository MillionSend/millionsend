import { forwardToForwardTargets, type InboxSendDeps } from "@millionsend/core";
import type { Db } from "@millionsend/db";

/** The inbox.forward job: a delivered message passed on to the inbox's forward_to owners. */
export async function forwardToOwners(
  db: Db,
  deps: InboxSendDeps,
  job: { receivedEmailId: string; inboxId: string },
): Promise<void> {
  const outcome = await forwardToForwardTargets(db, deps, job);
  // A refusal (a suspended team, every owner suppressed) is final; retrying
  // would only refuse again. Ids and the error name only: no addresses.
  if (outcome?.kind === "refused") {
    console.warn(
      `inbox.forward: ${job.receivedEmailId} inbox=${job.inboxId} not forwarded (${outcome.error.name})`,
    );
  }
}
