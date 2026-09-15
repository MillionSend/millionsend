import {
  GetAccountCommand,
  type GetAccountCommandOutput,
  SESv2Client,
} from "@aws-sdk/client-sesv2";

/**
 * Structural subset of SESv2Client so callers inject a fake in tests
 * (mirrors SesIdentityClient in domain-identity.ts).
 */
export interface SesAccountClient {
  send(command: GetAccountCommand): Promise<unknown>;
}

/**
 * Real SESv2 client typed for GetAccount. Mirrors createSesv2Client in
 * domain-identity.ts, whose SesIdentityClient return type cannot carry
 * GetAccountCommand; omitting credentials falls back to the SDK default
 * provider chain.
 */
export function createSesAccountClient(options: {
  region: string;
  accessKeyId?: string | undefined;
  secretAccessKey?: string | undefined;
}): SesAccountClient {
  const { region, accessKeyId, secretAccessKey } = options;
  return new SESv2Client({
    region,
    // GetAccount is a probe on the dashboard's and the worker's hot paths: a
    // region that does not answer must fail in seconds, not at the OS
    // connect timeout times the SDK's retries.
    requestHandler: { connectionTimeout: 3_000, requestTimeout: 10_000 },
    ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
  });
}

export interface SesAccountOverview {
  sendingEnabled: boolean;
  /** ProductionAccessEnabled — false means the account is in the SES sandbox. */
  productionAccess: boolean;
  /** EnforcementStatus for this region: HEALTHY, PROBATION or SHUTDOWN; null when SES reports none. */
  enforcementStatus: string | null;
  /**
   * PricingAttributes.CurrentPlan for this region: NONE (à la carte),
   * ESSENTIALS, PRO or ENTERPRISE; null when SES reports none. A region with
   * no prior sending starts on ESSENTIALS, which costs more per message.
   */
  pricingPlan: string | null;
  quota: {
    max24h: number;
    sentLast24h: number;
    /** Messages per second. */
    maxSendRate: number;
  };
}

/** SESv2 GetAccount mapped to the fields the dashboard shows. */
export async function getAccountOverview(client: SesAccountClient): Promise<SesAccountOverview> {
  const out = (await client.send(new GetAccountCommand({}))) as GetAccountCommandOutput;
  return {
    sendingEnabled: out.SendingEnabled ?? false,
    productionAccess: out.ProductionAccessEnabled ?? false,
    enforcementStatus: out.EnforcementStatus ?? null,
    pricingPlan: out.PricingAttributes?.CurrentPlan ?? null,
    quota: {
      max24h: out.SendQuota?.Max24HourSend ?? 0,
      sentLast24h: out.SendQuota?.SentLast24Hours ?? 0,
      maxSendRate: out.SendQuota?.MaxSendRate ?? 0,
    },
  };
}
