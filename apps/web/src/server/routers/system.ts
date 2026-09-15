import {
  AWS_REGION_DEFAULT,
  EMAIL_RETENTION_DAYS_DEFAULT,
  env,
  isCloudDeployment,
  SES_MAX_SEND_RATE_DEFAULT,
  servedRegions,
  trackingSubdomainsSupported,
} from "@millionsend/config";
import {
  committedDailyVolume,
  getInstanceSettings,
  pausedRegions,
  sesEventsHealth,
} from "@millionsend/core";
import { schema } from "@millionsend/db";
import {
  createSesAccountClient,
  getAccountOverview,
  type SesAccountClient,
} from "@millionsend/ses";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { isAwsCredentialError } from "@/lib/aws-errors";
import { recordAudit } from "../audit";
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

type OperatorCtx = {
  db: Parameters<typeof isInstanceOperator>[0];
  session: { user: { id: string } };
};

async function canManageInstance(ctx: OperatorCtx & { role: "owner" | "admin" | "member" }) {
  return (
    !isCloudDeployment() &&
    ctx.role !== "member" &&
    (await isInstanceOperator(ctx.db, ctx.session.user.id))
  );
}

/**
 * Instance-wide facts (the platform's SES account, env configuration) are
 * the operator's, not any tenant's: in cloud they do not exist for anyone
 * else. Self-host members may read them — the instance is theirs.
 */
async function assertInstanceVisible(ctx: OperatorCtx): Promise<void> {
  if (isCloudDeployment() && !(await isInstanceOperator(ctx.db, ctx.session.user.id))) {
    throw new TRPCError({ code: "NOT_FOUND" });
  }
}

/**
 * SES access seam, mirroring DomainsSesDeps: tests inject a fake via
 * createSystemRouter(deps) instead of stubbing the AWS SDK.
 */
export interface SystemSesDeps {
  accountClient(region: string): SesAccountClient;
}

const defaultSesDeps: SystemSesDeps = {
  // Built per call: GetAccount runs when the operator clicks "Test
  // connection" and once a minute per region for the features probe, so
  // there is nothing worth caching.
  accountClient: (region) =>
    createSesAccountClient({
      region,
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    }),
};

/** How long a region's production-access answer is reused by `features`. */
const PRODUCTION_PROBE_TTL_MS = 60_000;

export function createSystemRouter(deps: SystemSesDeps = defaultSesDeps) {
  // Production access per served region, for the add-domain form: one
  // GetAccount per region at most once a minute — features runs on every
  // dashboard page and the non-send SES API is throttled at one request per
  // second per region. Only a region's first probe is awaited (bounded by
  // the client's timeouts); an expired answer is served at once while the
  // probe refreshes it, so a region that stops answering never stalls the
  // screens. A failed probe keeps the last answer; without credentials
  // nothing is probed (the SDK chain fails slowly) and every region reads
  // alike.
  const productionProbes = new Map<string, { at: number; value: Promise<boolean> }>();
  const productionAccess = (region: string): Promise<boolean> => {
    const cached = productionProbes.get(region);
    if (cached && Date.now() - cached.at < PRODUCTION_PROBE_TTL_MS) return cached.value;
    const value = awsCredentialsConfigured()
      ? getAccountOverview(deps.accountClient(region)).then(
          (overview) => overview.productionAccess,
          () => cached?.value ?? false,
        )
      : Promise.resolve(false);
    productionProbes.set(region, { at: Date.now(), value });
    return cached ? cached.value : value;
  };
  return router({
    /**
     * Env-level deployment readiness, behind team auth like everything else.
     * credentialsConfigured is honest: true only for explicit keys, or when
     * the operator opted into the default provider chain via
     * AWS_DEFAULT_CHAIN=true — an unset env merely gets the chain "attempted",
     * so the dashboard warns instead of assuming it works.
     */
    awsReadiness: teamProcedure.query(async ({ ctx }) => {
      await assertInstanceVisible(ctx);
      const regions = servedRegions();
      return {
        credentialsConfigured: awsCredentialsConfigured(),
        // The default region, first of the served list.
        region: regions[0] ?? AWS_REGION_DEFAULT,
        regions,
      };
    }),

    /**
     * Deployment facts every tenant's screens need, cloud included — nothing
     * here describes the operator's account.
     */
    features: teamProcedure.query(async () => ({
      // Regions new domain identities may be provisioned in, the default
      // first, and whether AWS has granted production access in each.
      regions: await Promise.all(
        servedRegions().map(async (code) => ({ code, production: await productionAccess(code) })),
      ),
      // Local tracking hosts get a "links will not resolve" warning.
      appBaseUrl: env.APP_BASE_URL ?? null,
      // Why the domain screen may omit the branded tracking subdomain field.
      trackingSubdomainsSupported: trackingSubdomainsSupported(),
      // Why cloud domains without a tracking subdomain ship untracked links.
      trackingRequiresSubdomain: isCloudDeployment(),
      // The shared first-email sender the onboarding snippet and button use; null hides the button.
      onboardingSender: env.ONBOARDING_EMAIL_FROM ?? null,
    })),

    /**
     * Instance-wide SES event pipeline health for the dashboard banner; null =
     * nothing to show this user (ingestion off on purpose, or a cloud tenant —
     * only the operator can act on it there).
     */
    eventsHealth: teamProcedure.query(async ({ ctx }) => {
      if (!env.SNS_TOPIC_ARNS?.length) return null;
      if (isCloudDeployment() && !(await isInstanceOperator(ctx.db, ctx.session.user.id))) {
        return null;
      }
      // The SES settings page does not exist on cloud, so the banner has
      // nowhere to send the operator there. The probe is advisory: a failure
      // is logged for the operator and the banner stays quiet, instead of a
      // 500 on every page of the app.
      try {
        return { ...(await sesEventsHealth(ctx.db)), settingsAvailable: !isCloudDeployment() };
      } catch (error) {
        console.error("SES events health probe failed", error);
        return null;
      }
    }),

    /**
     * Regions where the platform breaker holds broadcasts, for the dashboard
     * banner; null when none are paused or the caller may not see instance
     * facts (cloud tenants — only the operator can act on it there).
     */
    platformBreakers: teamProcedure.query(async ({ ctx }) => {
      if (isCloudDeployment() && !(await isInstanceOperator(ctx.db, ctx.session.user.id))) {
        return null;
      }
      const paused = await pausedRegions(ctx.db);
      return paused.length > 0 ? paused : null;
    }),

    /** Env-side SES settings the setup page reports alongside awsReadiness. */
    sesEnv: teamProcedure.query(async ({ ctx }) => {
      await assertInstanceVisible(ctx);
      return {
        // Whether events actually arrive, not just whether the vars are set.
        // Nothing to judge while ingestion is not configured at all.
        eventsHealth: env.SNS_TOPIC_ARNS?.length
          ? await sesEventsHealth(ctx.db)
          : { status: "idle" as const, sentInWindow: 0, lastSesEventAt: null },
        snsTopicsConfigured: Boolean(env.SNS_TOPIC_ARNS?.length),
        configurationSetConfigured: Boolean(env.SES_CONFIGURATION_SET),
        maxSendRate: env.SES_MAX_SEND_RATE,
        // The setup page bakes the SNS subscription endpoint into its
        // generated setup script; null means the events section is omitted.
        appBaseUrl: env.APP_BASE_URL ?? null,
        // Why the sign-in screen may hide "Forgot password?": recovery needs
        // SES credentials plus AUTH_EMAIL_FROM.
        passwordRecoveryEnabled: passwordRecoveryEnabled(),
        trackingSubdomainsSupported: trackingSubdomainsSupported(),
        trackingRequiresSubdomain: isCloudDeployment(),
      };
    }),

    /**
     * Live SESv2 GetAccount in one served region (the default when none is
     * named), run on demand from the SES setup page. AWS failures come back
     * as a typed { ok: false } value — raw SDK errors never propagate to the
     * client as thrown tRPC errors.
     */
    sesAccount: teamProcedure
      .input(z.object({ region: z.string().optional() }).optional())
      .query(async ({ ctx, input }) => {
        await assertInstanceVisible(ctx);
        const regions = servedRegions();
        const region = input?.region ?? regions[0];
        if (!region || !regions.includes(region)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `this deployment does not serve ${region}`,
          });
        }
        const committed = isCloudDeployment() ? await committedDailyVolume(ctx.db) : null;
        try {
          const overview = await getAccountOverview(deps.accountClient(region));
          return { ok: true as const, region, ...overview, committedPerDay: committed };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            ok: false as const,
            region,
            kind: isAwsCredentialError(message)
              ? ("credentials" as const)
              : ("unreachable" as const),
            message,
          };
        }
      }),

    /**
     * Instance-wide (NOT team-scoped) operator settings. Self-host members
     * may read them; writes belong only to the first user (the instance
     * operator), and are never tenant-editable in cloud mode.
     */
    instanceSettings: router({
      get: teamProcedure.query(async ({ ctx }) => {
        await assertInstanceVisible(ctx);
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
          await recordAudit(ctx, { action: "instance.settings_updated", metadata: input });
        }),
    }),
  });
}

export const systemRouter = createSystemRouter();
