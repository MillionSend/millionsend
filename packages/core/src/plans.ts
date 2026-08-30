import type { schema } from "@millionsend/db";

export type Plan = (typeof schema.planEnum.enumValues)[number];

/** Daily send caps per plan; null = unlimited. Self-host ignores plans entirely. */
export const PLAN_DAILY_LIMIT: Record<Plan, number | null> = {
  free: 100,
  pro: 3000,
  scale: null,
};

/** Sender domains per team per plan; null = unlimited. Self-host ignores plans entirely. */
export const PLAN_DOMAIN_LIMIT: Record<Plan, number | null> = {
  free: 3,
  pro: 20,
  scale: 100,
};
