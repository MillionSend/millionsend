import type { schema } from "@millionsend/db";
import { DAY_MS } from "./utc-day.js";

export type Plan = (typeof schema.planEnum.enumValues)[number];

/** Days past current_period_end a paid plan keeps its limits without a fresh Stripe period. */
export const PLAN_GRACE_DAYS = 7;

/**
 * The plan whose limits apply right now. teams.plan is written only by the
 * Stripe webhook, so a dropped cancellation would leave a paid plan forever;
 * once the last paid period is past its grace window the team is limited as
 * free until Stripe reports a new period. A null period end (never
 * subscribed, or a plan set outside Stripe) is taken at face value.
 */
export function effectivePlan(
  plan: Plan,
  currentPeriodEnd: Date | null,
  now: Date = new Date(),
): Plan {
  if (plan === "free" || !currentPeriodEnd) return plan;
  return currentPeriodEnd.getTime() + PLAN_GRACE_DAYS * DAY_MS < now.getTime() ? "free" : plan;
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
 * plans entirely.
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

/** "100k", "1M", "1.5M": a volume the way plan cards and mails print it. */
export function formatVolume(n: number): string {
  if (n >= 1_000_000) return `${n / 1_000_000}M`;
  if (n >= 1_000) return `${n / 1_000}k`;
  return String(n);
}

/** "Pro 100k" on a monthly plan, the bare plan name on a daily one. */
export function planLabel(plan: Plan, planQuota: number | null): string {
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

/** The billing columns a quota is derived from. */
export interface QuotaTeamRow {
  plan: Plan;
  planQuota: number | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  overageEnabled: boolean;
}

/** What limits a team's sends right now. */
export type TeamQuota =
  /** Self-host: counted, never capped. */
  | { kind: "none" }
  | { kind: "day"; plan: Plan; limit: number }
  | {
      kind: "month";
      plan: Plan;
      included: number;
      periodStart: Date;
      periodEnd: Date;
      /** Sends past `included` bill instead of stopping. */
      overage: boolean;
      overageCentsPer1k: number;
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

/** The cap that applies to a team row right now; every send surface derives it from here. */
export function teamQuota(team: QuotaTeamRow, isCloud: boolean, now: Date = new Date()): TeamQuota {
  if (!isCloud) return { kind: "none" };
  const plan = effectivePlan(team.plan, team.currentPeriodEnd, now);
  const rung = teamRung(plan, plan === team.plan ? team.planQuota : null);
  if (rung.period === "day") return { kind: "day", plan, limit: rung.included };
  const period = quotaPeriod(team, now);
  return {
    kind: "month",
    plan,
    included: rung.included,
    periodStart: period.start,
    periodEnd: period.end,
    overage: team.overageEnabled,
    overageCentsPer1k: rung.overageCentsPer1k ?? 0,
  };
}

/** Emails a quota lets through in a month (a daily cap times 30); Infinity without a cap. */
export function monthlyCapacity(quota: TeamQuota): number {
  if (quota.kind === "none") return Number.POSITIVE_INFINITY;
  if (quota.kind === "day") return quota.limit * 30;
  return quota.overage ? quota.included * OVERAGE_HARD_CAP : quota.included;
}

/** Whether a quota change lets more mail through, so parked sends deserve an immediate drain. */
export function raisesQuota(before: TeamQuota, after: TeamQuota): boolean {
  return monthlyCapacity(after) > monthlyCapacity(before);
}

/**
 * Teams a user may own on Cloud, by the best effective plan among the teams
 * they already own: a paying owner gets room for more teams without buying
 * each one up. Membership in someone else's paid team does not count.
 * Self-host has no cap.
 */
export const PLAN_TEAM_LIMIT: Record<Plan, number> = {
  free: 3,
  starter: 5,
  pro: 10,
  scale: 15,
};

/** Sender domains per team per plan; null = unlimited. Self-host ignores plans entirely. */
export const PLAN_DOMAIN_LIMIT: Record<Plan, number | null> = {
  free: 3,
  starter: 10,
  pro: null,
  scale: null,
};

/** Contacts a team may hold per plan; null = unlimited. Self-host ignores plans entirely. */
export const PLAN_CONTACT_LIMIT: Record<Plan, number | null> = {
  free: 1_000,
  starter: null,
  pro: null,
  scale: null,
};

/**
 * With overage on, sends still stop at this multiple of the included volume
 * until the period renews: a runaway integration (or a stolen key) can run
 * up at most a few times the plan, never an open-ended bill.
 */
export const OVERAGE_HARD_CAP = 5;
