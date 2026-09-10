import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import {
  nextUtcDayStart,
  PLAN_DOMAIN_LIMIT,
  readPeriodUsage,
  teamQuota,
  utcDay,
} from "@millionsend/core";
import { schema } from "@millionsend/db";
import { and, eq } from "drizzle-orm";
import type { ApiDeps, Env } from "../app.js";
import { errorSchema, usageResponseSchema } from "../schemas.js";

export function registerUsageRoutes(
  app: OpenAPIHono<Env>,
  deps: Pick<ApiDeps, "db" | "isCloud" | "appBaseUrl">,
): void {
  app.openapi(
    createRoute({
      method: "get",
      path: "/usage",
      responses: {
        200: {
          content: { "application/json": { schema: usageResponseSchema } },
          description:
            "Effective plan, its send and domain limits, today's accepted send count (UTC day) and, on a monthly plan, the billing period's usage. MillionSend extension; plan, limits and period are null on a self-hosted instance.",
        },
        403: {
          content: { "application/json": { schema: errorSchema } },
          description: "Restricted API key",
        },
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const quota = teamQuota(auth.billing, deps.isCloud);
      const counters = schema.usageCounters;
      const [[team], [today], period] = await Promise.all([
        deps.db
          .select({ id: schema.teams.id, name: schema.teams.name })
          .from(schema.teams)
          .where(eq(schema.teams.id, auth.teamId)),
        deps.db
          .select({ accepted: counters.accepted })
          .from(counters)
          .where(and(eq(counters.teamId, auth.teamId), eq(counters.day, utcDay()))),
        quota.kind === "month" ? readPeriodUsage(deps.db, auth.teamId, quota.periodStart) : null,
      ]);
      if (!team) throw new Error("authenticated key has no team row");
      const plan = quota.kind === "none" ? null : quota.plan;
      return c.json(
        {
          object: "usage" as const,
          cloud: deps.isCloud,
          plan,
          limits: {
            emails_per_day: quota.kind === "day" ? quota.limit : null,
            emails_per_month: quota.kind === "month" ? quota.included : null,
            domains: plan ? PLAN_DOMAIN_LIMIT[plan] : null,
          },
          today: {
            emails_sent: today?.accepted ?? 0,
            resets_at: nextUtcDayStart().toISOString(),
          },
          period:
            quota.kind === "month"
              ? {
                  emails_sent: period?.accepted ?? 0,
                  included: quota.included,
                  overage_enabled: quota.overage,
                  overage_usd_per_1k: quota.overageCentsPer1k / 100,
                  starts_at: quota.periodStart.toISOString(),
                  ends_at: quota.periodEnd.toISOString(),
                }
              : null,
          team,
          app_url: deps.appBaseUrl ?? null,
        },
        200,
      );
    },
  );
}
