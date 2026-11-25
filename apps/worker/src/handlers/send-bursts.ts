import { claimSendBursts, findInstanceOperator, instanceSettings } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { sendBurstMail } from "../notifications/templates.js";
import type { SystemMailer } from "../system-mail.js";

/**
 * The operator's alert on each young team whose sending looks like a list
 * blast (core claimSendBursts). Alert only: nothing is held. Claimed before
 * it is sent, so a failing send is logged, not retried.
 */
export async function alertSendBursts(
  db: Db,
  deps: { mailer: SystemMailer; appBaseUrl?: string | undefined; now?: Date },
): Promise<number> {
  const bursts = await claimSendBursts(db, deps.now ?? new Date());
  if (bursts.length === 0) return 0;
  const operator = await findInstanceOperator(db);
  if (!operator) return 0;
  const { burstWindowHours } = await instanceSettings(db);
  let sent = 0;
  for (const burst of bursts) {
    try {
      await deps.mailer.send(operator.email, {
        ...sendBurstMail({
          ...burst,
          windowHours: burstWindowHours,
          url: `${deps.appBaseUrl ?? ""}/console/safety/${burst.teamId}`,
        }),
        kind: "platform.send_burst",
      });
      sent += 1;
    } catch (err) {
      console.error(`safety.bursts: alert for team ${burst.teamId} failed`, err);
    }
  }
  return sent;
}
