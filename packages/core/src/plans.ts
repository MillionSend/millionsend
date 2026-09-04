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

/** Daily send caps per plan; null = unlimited. Self-host ignores plans entirely. */
export const PLAN_DAILY_LIMIT: Record<Plan, number | null> = {
  free: 100,
  pro: 3000,
  scale: null,
};

/**
 * Sends keep passing this far past the daily limit before parking, so a day
 * that runs past the cap does not hold a customer's messages until midnight.
 * The nominal limit stays what plans and the dashboard show; owners hear
 * about it at 80% of the limit, at the limit, and when parking begins.
 */
export const QUOTA_TOLERANCE = 0.5;

/** Whether moving between plans lifts the daily send cap (unlimited counts as higher). */
export function raisesDailyLimit(from: Plan, to: Plan): boolean {
  const a = PLAN_DAILY_LIMIT[from];
  const b = PLAN_DAILY_LIMIT[to];
  return a !== null && (b === null || b > a);
}

/**
 * Teams a user may own on Cloud, by the best effective plan among the teams
 * they already own: a paying owner gets room for more teams without buying
 * each one up. Membership in someone else's paid team does not count.
 * Self-host has no cap.
 */
export const PLAN_TEAM_LIMIT: Record<Plan, number> = {
  free: 3,
  pro: 10,
  scale: 15,
};

/** Sender domains per team per plan; null = unlimited. Self-host ignores plans entirely. */
export const PLAN_DOMAIN_LIMIT: Record<Plan, number | null> = {
  free: 3,
  pro: 20,
  scale: 100,
};
