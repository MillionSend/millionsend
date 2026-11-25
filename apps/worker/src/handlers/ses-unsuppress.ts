import {
  extractAddrSpec,
  hashRecipient,
  normalizeAddress,
  type SesUnsuppressRequest,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { deleteAccountSuppression, type SesSuppressionClient } from "@millionsend/ses";
import { and, eq } from "drizzle-orm";

/**
 * SES throttles its non-send API at about one call per second per region,
 * for the whole account. The queue runs on one lane and each round of calls
 * (one per region) waits this long before the next, so a batch removal of a
 * thousand addresses drains in minutes without starving the other calls.
 */
export const SES_UNSUPPRESS_PAUSE_MS = 1_100;

export interface SesUnsuppressDeps {
  regions: readonly string[];
  clientForRegion: (region: string) => SesSuppressionClient;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * SES matches a suppressed address case-sensitively and lists it as it was
 * sent, while a row may hold it as typed or lowercased: its normalized form
 * and the spellings the source email addressed it by are tried as well.
 */
export async function sesSpellings(db: Db, job: SesUnsuppressRequest): Promise<string[]> {
  const spellings = new Set([job.email, normalizeAddress(job.email)]);
  if (job.sourceEmailId) {
    const e = schema.emails;
    const [email] = await db
      .select({ to: e.to, cc: e.cc, bcc: e.bcc })
      .from(e)
      .where(and(eq(e.id, job.sourceEmailId), eq(e.teamId, job.teamId)));
    const hash = hashRecipient(job.email);
    for (const recipient of [...(email?.to ?? []), ...(email?.cc ?? []), ...(email?.bcc ?? [])]) {
      const spec = extractAddrSpec(recipient);
      if (hashRecipient(spec) === hash) spellings.add(spec);
    }
  }
  return [...spellings];
}

const errorName = (error: unknown): string | undefined => (error as { name?: string })?.name;

/**
 * Clears one address from SES's account-level suppression list in every
 * served region. A region whose IAM policy lacks the action is logged and
 * skipped rather than retried; any other failure throws into pg-boss's
 * backoff, and the calls that already went through read as done next time.
 */
export async function runSesUnsuppress(
  db: Db,
  deps: SesUnsuppressDeps,
  job: SesUnsuppressRequest,
): Promise<void> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const denied = new Set<string>();
  let removed = 0;
  let failure: unknown;
  for (const address of await sesSpellings(db, job)) {
    const live = deps.regions.filter((region) => !denied.has(region));
    if (live.length === 0) break;
    const results = await Promise.allSettled(
      live.map((region) => deleteAccountSuppression(deps.clientForRegion(region), address)),
    );
    results.forEach((result, i) => {
      if (result.status === "fulfilled") {
        if (result.value === "removed") removed += 1;
      } else if (errorName(result.reason) === "AccessDeniedException") {
        denied.add(live[i] ?? "");
      } else {
        failure ??= result.reason;
      }
    });
    await sleep(SES_UNSUPPRESS_PAUSE_MS);
  }
  const recipient = hashRecipient(job.email);
  if (denied.size > 0) {
    console.warn(
      `ses.unsuppress: AccessDenied in ${[...denied].join(",")} for recipient=${recipient}; the SES IAM policy needs ses:DeleteSuppressedDestination (re-run the setup or update the policy)`,
    );
  }
  if (removed > 0) {
    console.log(
      `ses.unsuppress: removed team=${job.teamId} recipient=${recipient} entries=${removed}`,
    );
  }
  if (failure) throw failure;
}
