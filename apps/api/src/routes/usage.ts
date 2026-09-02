import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { nextUtcDayStart, PLAN_DAILY_LIMIT, PLAN_DOMAIN_LIMIT, utcDay } from "@millionsend/core";
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
            "Effective plan, its daily send and domain limits, and today's accepted send count (UTC day). MillionSend extension; plan and limits are null on a self-hosted instance.",
        },
        403: {
          content: { "application/json": { schema: errorSchema } },
          description: "Restricted API key",
        },
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const counters = schema.usageCounters;
      const [[team], [today]] = await Promise.all([
        deps.db
          .select({ id: schema.teams.id, name: schema.teams.name })
          .from(schema.teams)
          .where(eq(schema.teams.id, auth.teamId)),
        deps.db
          .select({ accepted: counters.accepted })
          .from(counters)
          .where(and(eq(counters.teamId, auth.teamId), eq(counters.day, utcDay()))),
      ]);
      if (!team) throw new Error("authenticated key has no team row");
      // auth.plan is already the effective plan (grace window applied), the
      // same value the dashboard's usage meter derives.
      const plan = deps.isCloud ? auth.plan : null;
      return c.json(
        {
          object: "usage" as const,
          cloud: deps.isCloud,
          plan,
          limits: {
            emails_per_day: plan ? PLAN_DAILY_LIMIT[plan] : null,
            domains: plan ? PLAN_DOMAIN_LIMIT[plan] : null,
          },
          today: {
            emails_sent: today?.accepted ?? 0,
            resets_at: nextUtcDayStart().toISOString(),
          },
          team,
          app_url: deps.appBaseUrl ?? null,
        },
        200,
      );
    },
  );
}
