import { env } from "@millionsend/config";
import { router, teamProcedure } from "../trpc";

export const systemRouter = router({
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
});
