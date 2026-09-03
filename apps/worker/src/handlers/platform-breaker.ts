import {
  applyRegionBreakers,
  evaluateRegionBreakers,
  findInstanceOperator,
  type RegionDecision,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { regionPausedMail, regionResumedMail } from "../notifications/templates.js";
import type { SystemMailer } from "../system-mail.js";

export interface PlatformBreakerDeps {
  mailer: SystemMailer;
  appBaseUrl?: string | undefined;
  now?: Date;
}

/**
 * Evaluate the per-region breakers, persist the flips, and tell the operator
 * about each one with the teams behind it. Returns the regions that changed.
 */
export async function runPlatformBreaker(
  db: Db,
  deps: PlatformBreakerDeps,
): Promise<{ tripped: string[]; resumed: string[] }> {
  const now = deps.now ?? new Date();
  const decisions = await evaluateRegionBreakers(db, { now });
  const changed = await applyRegionBreakers(db, decisions, now);
  if (changed.tripped.length === 0 && changed.resumed.length === 0) return changed;
  const operator = await findInstanceOperator(db);
  const url = deps.appBaseUrl ?? "";
  // The flip is already persisted (the banner shows it); a failing mail is
  // logged, never allowed to abort the handler or the other regions' mails.
  const mail = async (region: string, content: Parameters<SystemMailer["send"]>[1]) => {
    if (!operator) return;
    try {
      await deps.mailer.send(operator.email, content);
    } catch (err) {
      console.error(`platform.breaker: operator mail for ${region} failed`, err);
    }
  };
  const byRegion = new Map(decisions.map((d) => [d.region, d]));
  for (const region of changed.tripped) {
    const d = byRegion.get(region) as RegionDecision & {
      reason: NonNullable<RegionDecision["reason"]>;
    };
    const top = d.contributors
      .map((c) => `${c.teamName} (${c.hardBounced} hard bounces, ${c.complained} complaints)`)
      .join(", ");
    console.warn(
      `platform.breaker: broadcasts paused in ${region} — ${d.reason.metric} rate ${(d.reason.rate * 100).toFixed(2)}% over ${d.reason.windowHours}h (${d.reason.events}/${d.reason.sent}); top contributors: ${top || "none"}`,
    );
    await mail(
      region,
      regionPausedMail({
        region,
        ...d.reason,
        contributors: d.contributors.map((c) => ({
          team: c.teamName,
          hardBounced: c.hardBounced,
          complained: c.complained,
        })),
        url,
      }),
    );
  }
  for (const region of changed.resumed) {
    console.log(`platform.breaker: broadcasts resumed in ${region}`);
    await mail(region, regionResumedMail({ region, url }));
  }
  return changed;
}
