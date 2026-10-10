import { env } from "@millionsend/config";
import {
  clearMonitorOverride,
  getMonitorSettingsRow,
  isValidMonitorSetting,
  MONITOR_OVERRIDE_DAYS,
  MONITOR_SETTING_KEYS,
  MONITOR_SETTINGS,
  type MonitorSettingKey,
  monitorDayCounts,
  monitorSettingDefault,
  monitorThresholdsOrdered,
  resolveMonitorSettings,
  resumeMonitorPause,
  setMonitorOverride,
} from "@millionsend/core";
import { schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { judgeStatus } from "../../console/monitor";
import { operatorProcedure, router } from "../../trpc";
import { auditOperator, kickQuotaDrain, loadTeam } from "./shared";

const DAY_MS = 86_400_000;

/** The env the settings fall back to; raw strings under SKIP_ENV_VALIDATION, parsed either way. */
const envValues = () => env as unknown as Record<string, unknown>;

export const consoleMonitorRouter = router({
  /** The Overview card: the judge, today's tallies and the open monitor flags. */
  status: operatorProcedure.query(async ({ ctx }) => {
    const judge = judgeStatus();
    const { settings } = resolveMonitorSettings(await getMonitorSettingsRow(ctx.db), envValues());
    const f = schema.teamFlags;
    const [flags] = await ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(f)
      .where(and(eq(f.reason, "monitor"), eq(f.status, "open")));
    // Tallies are read whatever this process's env says: the worker is the
    // one that samples, and its rows are the truth.
    return {
      judge,
      today: await monitorDayCounts(ctx.db, settings),
      openFlags: flags?.n ?? 0,
      flagScore: settings.flagScore,
      flagRisk: settings.flagRisk,
      alertRisk: settings.alertRisk,
    };
  }),

  settings: router({
    /** Every setting with its effective value and where it came from. */
    get: operatorProcedure.query(async ({ ctx }) => {
      const { settings, sources } = resolveMonitorSettings(
        await getMonitorSettingsRow(ctx.db),
        envValues(),
      );
      // What clearing the stored value falls back to: the env value, else the default.
      const fallback = resolveMonitorSettings(null, envValues()).settings;
      return {
        judge: judgeStatus(),
        settings: MONITOR_SETTING_KEYS.map((key) => ({
          key,
          value: settings[key],
          source: sources[key],
          default: monitorSettingDefault(key, envValues()),
          fallback: fallback[key],
          kind: MONITOR_SETTINGS[key].kind,
        })),
      };
    }),

    /**
     * One upsert of the keys sent: a value stores an override, null clears it
     * so the env value, then the default, applies again. The thresholds must
     * still climb once the change lands.
     */
    update: operatorProcedure
      .input(
        z.partialRecord(
          z.enum(MONITOR_SETTING_KEYS),
          z.union([z.number(), z.boolean()]).nullable(),
        ),
      )
      .mutation(async ({ ctx, input }) => {
        const stored = await getMonitorSettingsRow(ctx.db);
        const changes: Partial<Record<MonitorSettingKey, number | boolean | null>> = {};
        for (const key of MONITOR_SETTING_KEYS) {
          const value = input[key];
          if (value === undefined) continue;
          if (value !== null && !isValidMonitorSetting(key, value)) {
            throw new TRPCError({ code: "BAD_REQUEST", message: `invalid_${key}` });
          }
          if ((stored?.[MONITOR_SETTINGS[key].column] ?? null) !== value) changes[key] = value;
        }
        if (Object.keys(changes).length === 0) return { changed: [] };
        const merged = { ...(stored ?? {}) } as Record<string, number | boolean | null>;
        for (const [key, value] of Object.entries(changes)) {
          merged[MONITOR_SETTINGS[key as MonitorSettingKey].column] = value ?? null;
        }
        const { settings } = resolveMonitorSettings(merged, envValues());
        if (!monitorThresholdsOrdered(settings)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "thresholds_order" });
        }
        const columns = Object.fromEntries(
          Object.entries(changes).map(([key, value]) => [
            MONITOR_SETTINGS[key as MonitorSettingKey].column,
            value,
          ]),
        );
        await ctx.db
          .insert(schema.instanceSettings)
          .values({ id: 1, ...columns })
          .onConflictDoUpdate({
            target: schema.instanceSettings.id,
            set: { ...columns, updatedAt: new Date() },
          });
        await auditOperator(ctx, {
          teamId: null,
          action: "instance.monitor_settings_updated",
          metadata: changes,
        });
        return { changed: Object.keys(changes) };
      }),
  }),

  /** "Sample everything for 7 days": every accepted send of the team is judged until then. */
  setOverride: operatorProcedure
    .input(z.object({ teamId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const team = await loadTeam(ctx.db, input.teamId);
      const until = new Date(Date.now() + MONITOR_OVERRIDE_DAYS * DAY_MS);
      await setMonitorOverride(ctx.db, {
        teamId: team.id,
        rate: 1,
        until,
        actor: { userId: ctx.operator.id },
      });
      return { until };
    }),

  clearOverride: operatorProcedure
    .input(z.object({ teamId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const team = await loadTeam(ctx.db, input.teamId);
      await clearMonitorOverride(ctx.db, { teamId: team.id, actor: { userId: ctx.operator.id } });
    }),

  /** Lifts the pause the policy applied; the operator hold it rode on goes with it. */
  resumeBroadcasts: operatorProcedure
    .input(z.object({ teamId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const team = await loadTeam(ctx.db, input.teamId);
      const resumed = await resumeMonitorPause(ctx.db, {
        teamId: team.id,
        actor: { userId: ctx.operator.id },
      });
      if (resumed) await kickQuotaDrain();
      return { resumed };
    }),
});
