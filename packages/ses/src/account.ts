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
    ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
  });
}

export interface SesAccountOverview {
  sendingEnabled: boolean;
  /** ProductionAccessEnabled — false means the account is in the SES sandbox. */
  productionAccess: boolean;
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
    quota: {
      max24h: out.SendQuota?.Max24HourSend ?? 0,
      sentLast24h: out.SendQuota?.SentLast24Hours ?? 0,
      maxSendRate: out.SendQuota?.MaxSendRate ?? 0,
    },
  };
}
