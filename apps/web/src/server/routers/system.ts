import { env } from "@millionsend/config";
import {
  createSesAccountClient,
  getAccountOverview,
  type SesAccountClient,
} from "@millionsend/ses";
import { isAwsCredentialError } from "@/lib/aws-errors";
import { router, teamProcedure } from "../trpc";

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
      credentialsConfigured:
        Boolean(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) ||
        process.env.AWS_DEFAULT_CHAIN === "true" ||
        process.env.AWS_DEFAULT_CHAIN === "1",
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
  });
}

export const systemRouter = createSystemRouter();
