import {
  CreateEmailIdentityCommand,
  type CreateEmailIdentityCommandOutput,
  DeleteEmailIdentityCommand,
  GetEmailIdentityCommand,
  type GetEmailIdentityCommandOutput,
  PutEmailIdentityMailFromAttributesCommand,
  SESv2Client,
} from "@aws-sdk/client-sesv2";

/** SES regions offered for domain identities. */
export const SES_REGIONS = ["us-east-1", "eu-west-1", "sa-east-1", "ap-northeast-1"] as const;
export type SesRegion = (typeof SES_REGIONS)[number];

type IdentityCommand =
  | CreateEmailIdentityCommand
  | PutEmailIdentityMailFromAttributesCommand
  | GetEmailIdentityCommand
  | DeleteEmailIdentityCommand;

/**
 * Structural subset of SESv2Client so callers inject a fake in tests
 * (mirrors the worker's SesSender pattern).
 */
export interface SesIdentityClient {
  send(command: IdentityCommand): Promise<unknown>;
}

/** Real SESv2 client; omitting credentials falls back to the SDK default provider chain. */
export function createSesv2Client(options: {
  region: string;
  accessKeyId?: string | undefined;
  secretAccessKey?: string | undefined;
}): SesIdentityClient {
  const { region, accessKeyId, secretAccessKey } = options;
  return new SESv2Client({
    region,
    ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
  });
}

export type DkimVerificationStatus =
  | "PENDING"
  | "SUCCESS"
  | "FAILED"
  | "TEMPORARY_FAILURE"
  | "NOT_STARTED";

export type MailFromVerificationStatus = "PENDING" | "SUCCESS" | "FAILED" | "TEMPORARY_FAILURE";

export interface DomainVerification {
  dkimStatus: DkimVerificationStatus;
  verifiedForSending: boolean;
  mailFromStatus: MailFromVerificationStatus;
  /** Easy DKIM CNAME tokens — the customer's DNS checklist derives from these. */
  dkimTokens: string[];
}

/**
 * Registers the domain as an SES identity (Easy DKIM) and points its custom
 * MAIL FROM at `<mailFromSubdomain>.<domain>` for SPF/DMARC alignment.
 */
export async function createDomainIdentity(
  client: SesIdentityClient,
  params: { domain: string; mailFromSubdomain: string },
): Promise<{ dkimTokens: string[] }> {
  const created = (await client.send(
    new CreateEmailIdentityCommand({ EmailIdentity: params.domain }),
  )) as CreateEmailIdentityCommandOutput;
  await client.send(
    new PutEmailIdentityMailFromAttributesCommand({
      EmailIdentity: params.domain,
      MailFromDomain: `${params.mailFromSubdomain}.${params.domain}`,
      BehaviorOnMxFailure: "USE_DEFAULT_VALUE",
    }),
  );
  return { dkimTokens: created.DkimAttributes?.Tokens ?? [] };
}

export async function getDomainVerification(
  client: SesIdentityClient,
  params: { domain: string },
): Promise<DomainVerification> {
  const out = (await client.send(
    new GetEmailIdentityCommand({ EmailIdentity: params.domain }),
  )) as GetEmailIdentityCommandOutput;
  return {
    dkimStatus: (out.DkimAttributes?.Status ?? "NOT_STARTED") as DkimVerificationStatus,
    verifiedForSending: out.VerifiedForSendingStatus ?? false,
    mailFromStatus: (out.MailFromAttributes?.MailFromDomainStatus ??
      "PENDING") as MailFromVerificationStatus,
    dkimTokens: out.DkimAttributes?.Tokens ?? [],
  };
}

export async function deleteDomainIdentity(
  client: SesIdentityClient,
  params: { domain: string },
): Promise<void> {
  await client.send(new DeleteEmailIdentityCommand({ EmailIdentity: params.domain }));
}

export type DnsRecordGroup = "verification" | "sending" | "dmarc";

export interface DnsRecord {
  group: DnsRecordGroup;
  type: "CNAME" | "MX" | "TXT";
  name: string;
  value: string;
  priority?: number;
}

/**
 * The DNS checklist for a domain identity: 3 Easy-DKIM CNAMEs (verification),
 * MAIL FROM MX + SPF TXT (sending), and a recommended p=none DMARC TXT.
 */
export function dnsRecordsForDomain(params: {
  domain: string;
  dkimTokens: string[];
  mailFromSubdomain: string;
  region: string;
}): DnsRecord[] {
  const { domain, dkimTokens, mailFromSubdomain, region } = params;
  const mailFromDomain = `${mailFromSubdomain}.${domain}`;
  return [
    ...dkimTokens.map(
      (token): DnsRecord => ({
        group: "verification",
        type: "CNAME",
        name: `${token}._domainkey.${domain}`,
        value: `${token}.dkim.amazonses.com`,
      }),
    ),
    {
      group: "sending",
      type: "MX",
      name: mailFromDomain,
      value: `feedback-smtp.${region}.amazonses.com`,
      priority: 10,
    },
    {
      group: "sending",
      type: "TXT",
      name: mailFromDomain,
      value: '"v=spf1 include:amazonses.com ~all"',
    },
    {
      group: "dmarc",
      type: "TXT",
      name: `_dmarc.${domain}`,
      value: '"v=DMARC1; p=none;"',
    },
  ];
}
