import type { schema } from "@millionsend/db";
import { DAY_MS } from "./utc-day.js";

export type Plan = (typeof schema.planEnum.enumValues)[number];

/** Stripe's subscription status as the team row mirrors it; "none" = never subscribed. */
export type PlanStatus = (typeof schema.planStatusEnum.enumValues)[number];

/** A plan on the ladder: every plan but system, which has no rung and no cap. */
export type LadderPlan = Exclude<Plan, "system">;

/** Days past current_period_end a paid plan keeps its limits without a fresh Stripe period. */
export const PLAN_GRACE_DAYS = 7;

/**
 * The plan whose limits apply right now. teams.plan is written only by the
 * Stripe webhook, so a dropped cancellation would leave a paid plan forever;
 * once the last paid period is past its grace window the team is limited as
 * free until Stripe reports a new period. A null period end (never
 * subscribed, or a plan set outside Stripe) is taken at face value, and the
 * system plan never lapses: Stripe has no say over it. team-plan's
 * effectivelyFree reads it the same way in SQL, so the two change together.
 */
export function effectivePlan(
  plan: Plan,
  currentPeriodEnd: Date | null,
  now: Date = new Date(),
): Plan {
  if (plan === "free" || plan === "system" || !currentPeriodEnd) return plan;
  return currentPeriodEnd.getTime() + PLAN_GRACE_DAYS * DAY_MS < now.getTime() ? "free" : plan;
}

/**
 * Whether a team counts as paying. Pass the effective plan, so a lapsed paid
 * plan reads as free. Self-host has no plans: every team counts.
 */
export function paidPlan(plan: Plan, isCloud: boolean): boolean {
  return !isCloud || plan !== "free";
}

/** Whether a plan may drop the "Powered by MillionSend" line from the hosted unsubscribe page. */
export function planCanHidePoweredBy(plan: Plan): boolean {
  return plan !== "free";
}

/** Plan names as every surface says them: the same word in every language. */
export const PLAN_NAME: Record<Plan, string> = {
  free: "Free",
  starter: "Starter",
  pro: "Pro",
  scale: "Scale",
  system: "System",
};

/** One step of the ladder: what a team gets for a monthly price. */
export interface PlanRung {
  /** Stable id, also the stem of the Stripe lookup keys and price metadata. */
  key: string;
  plan: Plan;
  /** Emails included per `period`. */
  included: number;
  /** A daily cap resets at UTC midnight; a monthly one follows the Stripe billing period. */
  period: "day" | "month";
  priceCents: number;
  /** Cents per 1,000 emails past `included`; null where sends stop at the cap. */
  overageCentsPer1k: number | null;
}

/**
 * The ladder, cheapest first. Free and Starter cap per day; Pro and Scale
 * include a monthly volume and can bill overage past it. Self-host ignores
 * plans entirely. The system plan (the instance's own team) has no rung:
 * callers that can see it branch before asking for one.
 */
export const PLAN_RUNGS = [
  {
    key: "free",
    plan: "free",
    included: 100,
    period: "day",
    priceCents: 0,
    overageCentsPer1k: null,
  },
  {
    key: "starter",
    plan: "starter",
    included: 1_500,
    period: "day",
    priceCents: 900,
    overageCentsPer1k: null,
  },
  {
    key: "pro_100k",
    plan: "pro",
    included: 100_000,
    period: "month",
    priceCents: 2_000,
    overageCentsPer1k: 30,
  },
  {
    key: "pro_200k",
    plan: "pro",
    included: 200_000,
    period: "month",
    priceCents: 3_500,
    overageCentsPer1k: 30,
  },
  {
    key: "scale_500k",
    plan: "scale",
    included: 500_000,
    period: "month",
    priceCents: 7_500,
    overageCentsPer1k: 25,
  },
  {
    key: "scale_1m",
    plan: "scale",
    included: 1_000_000,
    period: "month",
    priceCents: 14_000,
    overageCentsPer1k: 20,
  },
  {
    key: "scale_1_5m",
    plan: "scale",
    included: 1_500_000,
    period: "month",
    priceCents: 20_000,
    overageCentsPer1k: 18,
  },
  {
    key: "scale_2_5m",
    plan: "scale",
    included: 2_500_000,
    period: "month",
    priceCents: 33_000,
    overageCentsPer1k: 16,
  },
] as const satisfies readonly PlanRung[];

export type PlanRungKey = (typeof PLAN_RUNGS)[number]["key"];

export const PLAN_RUNG_KEYS = PLAN_RUNGS.map((r) => r.key) as [PlanRungKey, ...PlanRungKey[]];

/** Rungs a team can buy. */
export const PAID_RUNGS: readonly PlanRung[] = PLAN_RUNGS.filter((r) => r.priceCents > 0);

export function isPlanRungKey(value: unknown): value is PlanRungKey {
  return typeof value === "string" && (PLAN_RUNG_KEYS as readonly string[]).includes(value);
}

export function rungByKey(key: PlanRungKey): PlanRung {
  const rung = PLAN_RUNGS.find((r) => r.key === key);
  if (!rung) throw new Error(`unknown plan rung ${key}`);
  return rung;
}

/**
 * The rung a team row sits on: its plan, and on a monthly plan the included
 * volume it bought. A monthly plan with no recorded volume (a row written
 * before rungs existed) sits on the plan's first rung.
 */
export function teamRung(plan: Plan, planQuota: number | null): PlanRung {
  const rungs = PLAN_RUNGS.filter((r) => r.plan === plan);
  const first = rungs[0];
  if (!first) throw new Error(`plan ${plan} has no rungs`);
  return rungs.find((r) => r.period === "month" && r.included === planQuota) ?? first;
}

/** "100K", "1M", "1.5M": a volume the way plan cards and mails print it. */
export function formatVolume(n: number): string {
  if (n >= 1_000_000) return `${n / 1_000_000}M`;
  if (n >= 1_000) return `${n / 1_000}K`;
  return String(n);
}

/** "Pro 100K" on a monthly plan, the bare plan name on a daily one (and on System). */
export function planLabel(plan: Plan, planQuota: number | null): string {
  if (plan === "system") return PLAN_NAME.system;
  const rung = teamRung(plan, planQuota);
  return rung.period === "month"
    ? `${PLAN_NAME[plan]} ${formatVolume(rung.included)}`
    : PLAN_NAME[plan];
}

/**
 * Sends keep passing this far past a DAILY limit before parking, so a day
 * that runs past the cap does not hold a customer's messages until midnight.
 * The nominal limit stays what plans and the dashboard show; owners hear
 * about it at 80% of the limit, at the limit, and when parking begins.
 * Monthly quotas have no tolerance: past the included volume a team either
 * bills overage or stops.
 */
export const QUOTA_TOLERANCE = 0.5;

/**
 * A Free pool's burst allowance on Cloud (core bookFreeBurst): its mail to
 * providers that report complaints reaches FREE_BURST recipients at once,
 * then one more every FREE_BURST_REFILL_MS. Complaints arrive minutes to
 * hours after a send, so the pool's pause can act before a whole day's mail
 * has left.
 */
export const FREE_BURST = 10;
export const FREE_BURST_REFILL_MS = 6 * 60_000;
/** How long a spent allowance takes to refill to FREE_BURST: its burst window. */
export const FREE_BURST_WINDOW_MS = FREE_BURST * FREE_BURST_REFILL_MS;

/** The billing columns a quota is derived from. */
export interface QuotaTeamRow {
  plan: Plan;
  planQuota: number | null;
  /** A past-due subscription keeps its plan through Stripe's retries, but its overage waits for the payment. */
  planStatus: PlanStatus;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  overageEnabled: boolean;
  /** Operator ceiling on the team's UTC day (instance console); null or absent = the plan decides. */
  dailySendCeiling?: number | null | undefined;
  /** The team's creator, recorded on Cloud only (teams.pool_owner_id); see freePoolOwner. */
  poolOwnerId?: string | null | undefined;
}

/**
 * The Free pool a team counts in right now: its creator's id while the team
 * is effectively on Free and its creator is recorded, which only Cloud does.
 * Every such team of one creator shares one daily cap and one bounce and
 * complaint record. Null for a paid or system team, and on self-host.
 */
export function freePoolOwner(
  team: Pick<QuotaTeamRow, "plan" | "currentPeriodEnd" | "poolOwnerId">,
  now: Date = new Date(),
): string | null {
  return team.poolOwnerId && effectivePlan(team.plan, team.currentPeriodEnd, now) === "free"
    ? team.poolOwnerId
    : null;
}

/** What limits a team's sends right now. */
export type TeamQuota =
  /** Self-host, and the instance's own team: counted, never capped. */
  | { kind: "none" }
  | {
      kind: "day";
      plan: LadderPlan;
      limit: number;
      /** An operator ceiling on the day, enforced as typed (the plan's tolerance never stretches it). */
      dailyCeiling?: number | null | undefined;
      /**
       * A Free pool's shared cap (freePoolOwner): `limit` here is the plan's
       * own, which the pool counter reserves against with the plan's
       * tolerance; the team's own counter keeps its own line too, which binds
       * only on usage from before the team joined the pool. Holds a user id:
       * never sent to a browser.
       */
      pool?: { ownerId: string; limit: number } | undefined;
    }
  | {
      kind: "month";
      plan: LadderPlan;
      included: number;
      periodStart: Date;
      periodEnd: Date;
      /** Sends past `included` bill instead of stopping: the customer's switch, off while a payment is past due. */
      overage: boolean;
      /** The switch is on, but a past-due payment holds overage off until the invoice is paid. */
      overagePaused?: true | undefined;
      overageCentsPer1k: number;
      /** An operator ceiling on each UTC day inside the period; absent or null = the period alone caps. */
      dailyCeiling?: number | null | undefined;
    };

function addUtcMonth(date: Date): Date {
  const next = new Date(date);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
}

/**
 * The billing period a monthly plan's sends count against. Stripe starts a
 * period exactly where the previous one ended, so a period past its end whose
 * renewal webhook has not landed yet (or is inside the grace window) is
 * already the next one. A plan set outside Stripe runs on UTC calendar months.
 */
export function quotaPeriod(
  team: Pick<QuotaTeamRow, "currentPeriodStart" | "currentPeriodEnd">,
  now: Date = new Date(),
): { start: Date; end: Date } {
  const { currentPeriodStart: start, currentPeriodEnd: end } = team;
  if (end && now.getTime() >= end.getTime()) return { start: end, end: addUtcMonth(end) };
  if (start) return { start, end: end ?? addUtcMonth(start) };
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { start: monthStart, end: addUtcMonth(monthStart) };
}

function planQuota(team: QuotaTeamRow, isCloud: boolean, now: Date): TeamQuota {
  if (!isCloud) return { kind: "none" };
  const plan = effectivePlan(team.plan, team.currentPeriodEnd, now);
  if (plan === "system") return { kind: "none" };
  const rung = teamRung(plan, plan === team.plan ? team.planQuota : null);
  if (rung.period === "day") {
    const ownerId = freePoolOwner(team, now);
    return ownerId
      ? { kind: "day", plan, limit: rung.included, pool: { ownerId, limit: rung.included } }
      : { kind: "day", plan, limit: rung.included };
  }
  const period = quotaPeriod(team, now);
  const paused = team.overageEnabled && team.planStatus === "past_due";
  return {
    kind: "month",
    plan,
    included: rung.included,
    periodStart: period.start,
    periodEnd: period.end,
    overage: team.overageEnabled && !paused,
    ...(paused ? { overagePaused: true } : {}),
    overageCentsPer1k: rung.overageCentsPer1k ?? 0,
  };
}

/**
 * The operator's daily ceiling sits beside the plan and never replaces it:
 * a daily cap becomes the lower of the two, a monthly plan gains a per-day
 * cap on top of its period, and an uncapped team (self-host) gets a plain
 * daily cap.
 */
function withCeiling(quota: TeamQuota, plan: Plan, ceiling: number | null): TeamQuota {
  // The system plan is the instance's own team: no rung, no cap, no ceiling.
  if (ceiling === null || plan === "system") return quota;
  if (quota.kind === "none") return { kind: "day", plan, limit: ceiling, dailyCeiling: ceiling };
  if (quota.kind === "day") {
    return { ...quota, limit: Math.min(quota.limit, ceiling), dailyCeiling: ceiling };
  }
  return { ...quota, dailyCeiling: ceiling };
}

/** The cap that applies to a team row right now; every send surface derives it from here. */
export function teamQuota(team: QuotaTeamRow, isCloud: boolean, now: Date = new Date()): TeamQuota {
  return withCeiling(planQuota(team, isCloud, now), team.plan, team.dailySendCeiling ?? null);
}

/** Emails a quota lets through in a month (a daily cap times 30); Infinity without a cap. */
export function monthlyCapacity(quota: TeamQuota): number {
  if (quota.kind === "none") return Number.POSITIVE_INFINITY;
  if (quota.kind === "day") return quota.limit * 30;
  const period = quota.overage ? quota.included * OVERAGE_HARD_CAP : quota.included;
  return quota.dailyCeiling == null ? period : Math.min(period, quota.dailyCeiling * 30);
}

/** Whether a quota change lets more mail through, so parked sends deserve an immediate drain. */
export function raisesQuota(before: TeamQuota, after: TeamQuota): boolean {
  return monthlyCapacity(after) > monthlyCapacity(before);
}

/**
 * Teams a user may own on Cloud, by the best effective plan among the teams
 * they already own: a paying owner gets room for more teams without buying
 * each one up. Membership in someone else's paid team does not count. On
 * Free, every team the user created in the last TEAM_CREATE_WINDOW_DAYS
 * counts too, deleted ones included, so deleting a team never frees a place.
 * Self-host has no cap.
 */
export const PLAN_TEAM_LIMIT: Record<Plan, number> = {
  free: 3,
  starter: 5,
  pro: 10,
  scale: 15,
  system: Number.POSITIVE_INFINITY,
};

/** How far back a Free account's team creations count against PLAN_TEAM_LIMIT. */
export const TEAM_CREATE_WINDOW_DAYS = 30;

/** Sender domains per team per plan; null = unlimited. Self-host ignores plans entirely. */
export const PLAN_DOMAIN_LIMIT: Record<Plan, number | null> = {
  free: 3,
  starter: 10,
  pro: null,
  scale: null,
  system: null,
};

/**
 * Domains a cloud team may add per UTC clock hour, per plan; self-host has no
 * limit. Each add provisions an identity on the SES account every tenant
 * shares, and SES throttles that API account-wide, so one team's burst must
 * not spend everyone's.
 */
export const DOMAIN_CREATES_PER_HOUR: Record<Plan, number> = {
  free: 10,
  starter: 10,
  pro: 10,
  scale: 100,
  system: 10,
};

/** Contacts a team may hold per plan; null = unlimited. Self-host ignores plans entirely. */
export const PLAN_CONTACT_LIMIT: Record<Plan, number | null> = {
  free: 1_000,
  starter: null,
  pro: null,
  scale: null,
  system: null,
};

/**
 * With overage on, sends still stop at this multiple of the included volume
 * until the period renews: a runaway integration (or a stolen key) can run
 * up at most a few times the plan, never an open-ended bill.
 */
export const OVERAGE_HARD_CAP = 5;

/** The monthly refusal names the cap it hit: the plan's volume, or the overage hard cap past it. */
export function monthlyQuotaMessage(result: { periodEnd: Date; overage: boolean }): string {
  const renews = result.periodEnd.toISOString();
  return result.overage
    ? `Monthly sending quota exceeded: sends stop at ${OVERAGE_HARD_CAP} times the included volume even with overage on; the period renews on ${renews}`
    : `Monthly sending quota exceeded with overage off or paused for a past-due payment; the period renews on ${renews}`;
}
