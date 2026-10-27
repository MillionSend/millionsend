import {
  applyRegionBreakers,
  evaluateFreeFuse,
  evaluateRegionBreakers,
  findInstanceOperator,
  holdComplaintTeams,
  type RegionDecision,
  recordSesComplaintRates,
  recordSesEnforcementStatuses,
  type SystemMailKind,
  unmatchedComplaints,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import {
  freeFuseMail,
  type MailContent,
  regionPausedMail,
  regionResumedMail,
  sesComplaintsMail,
  sesEnforcementMail,
  teamsHeldMail,
} from "../notifications/templates.js";
import type { SystemMailer } from "../system-mail.js";

export interface PlatformBreakerDeps {
  mailer: SystemMailer;
  appBaseUrl?: string | undefined;
  now?: Date;
  /** Cloud: Free teams drawing complaints are held for review, and the Free fuse is judged. */
  isCloud: boolean;
  /** The first served region, where mail with no domain row goes out. */
  defaultRegion: string;
  /** Hands a team the breaker held to the tenant.status job; absent in tests. */
  syncTenant?: ((teamId: string) => Promise<void>) | undefined;
  /** SES's own complaint rate and enforcement status in each served region. */
  ses?: {
    regions: readonly string[];
    /** From CloudWatch. */
    complaintRate: (region: string) => Promise<number | null>;
    /** From GetAccount. */
    enforcementStatus?: ((region: string) => Promise<string | null>) | undefined;
    /** When each region's failed read was last logged; kept across runs. */
    loggedAt: Map<string, Date>;
  };
}

const HOUR_MS = 3_600_000;

/**
 * Every region's reading; a failed read is left out, so the stored one
 * stands, and logged at most hourly per region: a policy without the
 * CloudWatch read fails every run until the setup runs again.
 */
async function readSesComplaintRates(
  ses: NonNullable<PlatformBreakerDeps["ses"]>,
  now: Date,
): Promise<Map<string, number | null>> {
  const rates = new Map<string, number | null>();
  for (const region of ses.regions) {
    try {
      rates.set(region, await ses.complaintRate(region));
    } catch (err) {
      const last = ses.loggedAt.get(region);
      if (last && now.getTime() - last.getTime() < HOUR_MS) continue;
      ses.loggedAt.set(region, now);
      console.warn(
        `platform.breaker: SES complaint rate unreadable in ${region}; without a reading from the last day, our own complaint count is judged`,
        err,
      );
    }
  }
  return rates;
}

/**
 * Every region's enforcement status; a failed read, or one without a
 * status, is left out so the stored one stands (the per-minute GetAccount
 * probe logs the failures).
 */
async function readEnforcementStatuses(
  ses: NonNullable<PlatformBreakerDeps["ses"]>,
): Promise<Map<string, string>> {
  const statuses = new Map<string, string>();
  for (const region of ses.regions) {
    const status = await ses.enforcementStatus?.(region).catch(() => null);
    if (status) statuses.set(region, status);
  }
  return statuses;
}

/**
 * Store SES's complaint rates and enforcement statuses, evaluate the
 * per-region breakers, persist the flips and the teams they hold, hold the
 * Free teams a complaint trip puts up for review, and judge the Free fuse
 * (Cloud). The operator hears about each flip, each region whose SES rate
 * reached the alert line, each enforcement change, each review hold and a
 * fuse that trips. Returns the regions that changed.
 */
export async function runPlatformBreaker(
  db: Db,
  deps: PlatformBreakerDeps,
): Promise<{ tripped: string[]; resumed: string[] }> {
  const now = deps.now ?? new Date();
  const { defaultRegion, isCloud } = deps;
  const alerts = deps.ses
    ? await recordSesComplaintRates(db, await readSesComplaintRates(deps.ses, now), {
        now,
        defaultRegion,
      })
    : [];
  const enforcement = deps.ses?.enforcementStatus
    ? await recordSesEnforcementStatuses(db, await readEnforcementStatuses(deps.ses))
    : [];
  const decisions = await evaluateRegionBreakers(db, { now, defaultRegion, isCloud });
  const changed = await applyRegionBreakers(db, decisions, now);
  // Held before any mail: a pause notice points to the review-hold mail only
  // when one follows. A failed hold is rethrown only after the mails, since
  // the flip is already stored and a retry would never send its notice; the
  // next run, the region still tripped, holds the teams again.
  const reviewHeld = new Map<string, string[]>();
  const holdFailures: unknown[] = [];
  for (const d of decisions) {
    if (!d.trip || !d.reviewTeams?.length) continue;
    let held: string[];
    try {
      held = await holdComplaintTeams(db, d.reviewTeams, now);
    } catch (err) {
      holdFailures.push(err);
      continue;
    }
    if (held.length === 0) continue;
    for (const teamId of held) {
      // The hold already refuses every send; the tenant is a second lock, so
      // a failed hand-off is logged rather than failing the committed hold.
      try {
        await deps.syncTenant?.(teamId);
      } catch (err) {
        console.error(`platform.breaker: SES tenant hand-off for held team ${teamId} failed`, err);
      }
    }
    reviewHeld.set(
      d.region,
      d.reviewTeams.filter((s) => held.includes(s.teamId)).map((s) => s.teamName),
    );
  }
  const base = deps.appBaseUrl ?? "";
  const url = `${base}/console/regions`;
  const safetyUrl = `${base}/console/safety`;
  let operator: { email: string } | null | undefined;
  // The state is already persisted (the console shows it); a failing mail is
  // logged, never allowed to abort the handler or the other mails.
  const mail = async (about: string, kind: SystemMailKind, content: MailContent) => {
    if (operator === undefined) operator = await findInstanceOperator(db);
    if (!operator) return;
    try {
      await deps.mailer.send(operator.email, { ...content, kind });
    } catch (err) {
      console.error(`platform.breaker: operator mail about ${about} failed`, err);
    }
  };
  const teams = (contributors: RegionDecision["contributors"]) =>
    contributors.map((c) => ({
      team: c.teamName,
      hardBounced: c.hardBounced,
      complained: c.complained,
    }));
  // A region that tripped in this run gets the pause notice alone.
  const warned = alerts.filter((a) => !changed.tripped.includes(a.region));
  const unmatched =
    changed.tripped.length > 0 || warned.length > 0 ? await unmatchedComplaints(db, now) : 0;
  const byRegion = new Map(decisions.map((d) => [d.region, d]));
  for (const region of changed.tripped) {
    const d = byRegion.get(region) as RegionDecision & {
      reason: NonNullable<RegionDecision["reason"]>;
    };
    const top = d.contributors
      .map((c) => `${c.teamName} (${c.hardBounced} hard bounces, ${c.complained} complaints)`)
      .join(", ");
    const measured =
      "windowHours" in d.reason
        ? `over ${d.reason.windowHours}h (${d.reason.events}/${d.reason.sent})`
        : "measured by SES";
    const scope = d.heldTeams ? `broadcasts of ${d.heldTeams.length} team(s)` : "broadcasts";
    console.warn(
      `platform.breaker: ${scope} paused in ${region} — ${d.reason.metric} rate ${(d.reason.rate * 100).toFixed(2)}% ${measured}; top contributors: ${top || "none"}`,
    );
    await mail(
      region,
      "region.paused",
      regionPausedMail({
        region,
        reason: d.reason,
        contributors: teams(d.contributors),
        heldTeams: d.heldTeams?.map((s) => s.teamName) ?? null,
        isCloud,
        reviewHeld: reviewHeld.has(region),
        unmatched,
        url,
      }),
    );
  }
  for (const region of changed.resumed) {
    console.log(`platform.breaker: broadcasts resumed in ${region}`);
    await mail(region, "region.resumed", regionResumedMail({ region, url }));
  }
  for (const alert of warned) {
    console.warn(
      `platform.breaker: SES complaint rate in ${alert.region} at ${(alert.rate * 100).toFixed(2)}%`,
    );
    await mail(
      alert.region,
      "region.ses_complaints",
      sesComplaintsMail({
        region: alert.region,
        rate: alert.rate,
        contributors: teams(alert.contributors),
        unmatched,
        url,
      }),
    );
  }
  for (const change of enforcement) {
    console.warn(
      `platform.breaker: SES enforcement status in ${change.region}: ${change.from ?? "first read"} → ${change.to}`,
    );
    await mail(change.region, "region.ses_enforcement", sesEnforcementMail({ ...change, url }));
  }
  for (const [region, teams] of reviewHeld) {
    console.warn(`platform.breaker: ${teams.length} Free team(s) held for review in ${region}`);
    await mail(region, "region.teams_held", teamsHeldMail({ region, teams, url: safetyUrl }));
  }
  const fuse = isCloud ? await evaluateFreeFuse(db, now) : null;
  if (fuse) {
    console.warn(`platform.breaker: Free fuse tripped at ${fuse.complaints} complaints`);
    await mail("the Free fuse", "platform.free_fuse", freeFuseMail({ ...fuse, url: safetyUrl }));
  }
  if (holdFailures.length > 0) {
    throw new Error(
      `platform.breaker: ${holdFailures.length} region(s) failed their review holds`,
      {
        cause: holdFailures[0],
      },
    );
  }
  return changed;
}
