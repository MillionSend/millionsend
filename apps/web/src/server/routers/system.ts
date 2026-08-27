import {
  EMAIL_RETENTION_DAYS_DEFAULT,
  env,
  SES_MAX_SEND_RATE_DEFAULT,
  trackingSubdomainsSupported,
} from "@millionsend/config";
import { getInstanceSettings } from "@millionsend/core";
import { schema } from "@millionsend/db";
import {
  createSesAccountClient,
  getAccountOverview,
  type SesAccountClient,
} from "@millionsend/ses";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { isAwsCredentialError } from "@/lib/aws-errors";
import { isInstanceOperator } from "../instance-operator";
import { awsCredentialsConfigured, passwordRecoveryEnabled } from "../system-mail";
import { router, teamProcedure } from "../trpc";

/**
 * Effective value + where it came from (db > env > default). Derived from
 * the raw process.env entry rather than the parsed env proxy: under
 * SKIP_ENV_VALIDATION the proxy is raw process.env (strings, no defaults),
 * and boot validation already guarantees the raw value is numeric. ""
 * counts as unset, matching emptyStringAsUndefined.
 */
function effectiveSetting(dbValue: number | null, envRaw: string | undefined, fallback: number) {
  if (dbValue !== null) return { value: dbValue, source: "db" as const };
  if (envRaw) return { value: Number(envRaw), source: "env" as const };
  return { value: fallback, source: "default" as const };
}

function isCloudDeployment(): boolean {
  return process.env.IS_CLOUD === "true" || process.env.IS_CLOUD === "1";
}

async function canManageInstance(ctx: {
  db: Parameters<typeof isInstanceOperator>[0];
  session: { user: { id: string } };
  role: "owner" | "admin" | "member";
}): Promise<boolean> {
  return (
    !isCloudDeployment() &&
    ctx.role !== "member" &&
    (await isInstanceOperator(ctx.db, ctx.session.user.id))
  );
}

/**
 * SES access seam, mirroring DomainsSesDeps: tests inject a fake via
 * createSystemRouter(deps) instead of stubbing the AWS SDK.
 */
export interface SystemSesDeps {
  accountClient(): SesAccountClient;
}

const defaultSesDeps: SystemSesDeps = {
  // Built per call: GetAccount only runs when the operator clicks
  // "Test connection", so there is nothing worth caching.
  accountClient: () =>
    createSesAccountClient({
      region: env.AWS_REGION,
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    }),
};

export function createSystemRouter(deps: SystemSesDeps = defaultSesDeps) {
  return router({
    /**
     * Env-level deployment readiness, behind team auth like everything else.
     * credentialsConfigured is honest: true only for explicit keys, or when
     * the operator opted into the default provider chain via
     * AWS_DEFAULT_CHAIN=true — an unset env merely gets the chain "attempted",
     * so the dashboard warns instead of assuming it works.
     */
    awsReadiness: teamProcedure.query(() => ({
      credentialsConfigured: awsCredentialsConfigured(),
      region: env.AWS_REGION,
    })),

    /** Env-side SES settings the setup page reports alongside awsReadiness. */
    sesEnv: teamProcedure.query(() => ({
      snsTopicsConfigured: Boolean(env.SNS_TOPIC_ARNS?.length),
      configurationSetConfigured: Boolean(env.SES_CONFIGURATION_SET),
      maxSendRate: env.SES_MAX_SEND_RATE,
      // The setup page bakes the SNS subscription endpoint into its generated
      // setup script; null means the events section is omitted.
      appBaseUrl: env.APP_BASE_URL ?? null,
      // Why the sign-in screen may hide "Forgot password?": recovery needs
      // SES credentials plus AUTH_EMAIL_FROM.
      passwordRecoveryEnabled: passwordRecoveryEnabled(),
      // Why the domain screen may omit the branded tracking subdomain field.
      trackingSubdomainsSupported: trackingSubdomainsSupported(),
    })),

    /**
     * Live SESv2 GetAccount, run on demand from the SES setup page. AWS
     * failures come back as a typed { ok: false } value — raw SDK errors
     * never propagate to the client as thrown tRPC errors.
     */
    sesAccount: teamProcedure.query(async () => {
      try {
        const overview = await getAccountOverview(deps.accountClient());
        return { ok: true as const, ...overview };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false as const,
          kind: isAwsCredentialError(message) ? ("credentials" as const) : ("unreachable" as const),
          message,
        };
      }
    }),

    /**
     * Instance-wide (NOT team-scoped) operator settings. Reads are open to
     * any member; writes belong only to the first self-host user (the instance
     * operator), and are never tenant-editable in cloud mode.
     */
    instanceSettings: router({
      get: teamProcedure.query(async ({ ctx }) => {
        const stored = await getInstanceSettings(ctx.db);
        return {
          sesMaxSendRate: effectiveSetting(
            stored.sesMaxSendRate,
            process.env.SES_MAX_SEND_RATE,
            SES_MAX_SEND_RATE_DEFAULT,
          ),
          emailRetentionDays: effectiveSetting(
            stored.emailRetentionDays,
            process.env.EMAIL_RETENTION_DAYS,
            EMAIL_RETENTION_DAYS_DEFAULT,
          ),
          canEdit: await canManageInstance(ctx),
        };
      }),

      update: teamProcedure
        .input(
          z.object({
            // null clears the override — the env value (then built-in
            // default) applies again.
            sesMaxSendRate: z.number().int().min(1).max(200).nullable(),
            emailRetentionDays: z.number().int().min(1).max(3650).nullable(),
          }),
        )
        .mutation(async ({ ctx, input }) => {
          if (!(await canManageInstance(ctx))) throw new TRPCError({ code: "FORBIDDEN" });
          await ctx.db
            .insert(schema.instanceSettings)
            .values({ id: 1, ...input })
            .onConflictDoUpdate({
              target: schema.instanceSettings.id,
              set: { ...input, updatedAt: new Date() },
            });
        }),
    }),
  });
}

export const systemRouter = createSystemRouter();
