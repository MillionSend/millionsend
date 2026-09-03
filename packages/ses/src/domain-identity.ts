import { generateKeyPairSync } from "node:crypto";
import {
  CreateEmailIdentityCommand,
  DeleteEmailIdentityCommand,
  GetEmailIdentityCommand,
  type GetEmailIdentityCommandOutput,
  PutEmailIdentityDkimSigningAttributesCommand,
  PutEmailIdentityMailFromAttributesCommand,
  SESv2Client,
} from "@aws-sdk/client-sesv2";
import type { TenantCommand } from "./tenants.js";

/** SES regions offered for domain identities. */
export const SES_REGIONS = ["us-east-1", "eu-west-1", "sa-east-1", "ap-northeast-1"] as const;
export type SesRegion = (typeof SES_REGIONS)[number];

/** Single branded BYODKIM selector: every domain publishes `millionsend._domainkey`. */
export const DKIM_SELECTOR = "millionsend";

type IdentityCommand =
  | CreateEmailIdentityCommand
  | PutEmailIdentityDkimSigningAttributesCommand
  | PutEmailIdentityMailFromAttributesCommand
  | GetEmailIdentityCommand
  | DeleteEmailIdentityCommand
  | TenantCommand;

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

/**
 * Fresh 2048-bit RSA keypair for BYODKIM. The private key is PKCS#1 DER
 * base64 — the format SES's DomainSigningPrivateKey expects (the base64 body
 * of an `openssl genrsa` PEM). The public key is SPKI DER base64, which is
 * exactly the `p=` value of the DKIM TXT record (RFC 6376 §3.6.1).
 *
 * The private key exists only to be handed to SES at identity creation:
 * callers must not persist or log it.
 */
export function generateDkimKeyPair(): { privateKeyB64: string; publicKeyB64: string } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privateKeyB64: privateKey.export({ format: "der", type: "pkcs1" }).toString("base64"),
    publicKeyB64: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
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
}

/**
 * Registers the domain as an SES identity with BYODKIM signing and points its
 * custom MAIL FROM at `<mailFromSubdomain>.<domain>` for SPF/DMARC alignment.
 *
 * With `adoptExisting`, an identity that already exists is re-keyed rather
 * than treated as an error: a partial earlier create (identity registered
 * in SES but never recorded by the caller) would otherwise make the domain
 * permanently un-creatable. Only safe when every identity in the AWS
 * account belongs to the caller's operator (self-host). In a shared cloud
 * account the AlreadyExistsException propagates instead: adopting there
 * would re-key another tenant's identity and break its DKIM.
 */
export async function createDomainIdentity(
  client: SesIdentityClient,
  params: {
    domain: string;
    mailFromSubdomain: string;
    dkim: { selector: string; privateKeyB64: string };
    adoptExisting?: boolean | undefined;
  },
): Promise<void> {
  try {
    await client.send(
      new CreateEmailIdentityCommand({
        EmailIdentity: params.domain,
        DkimSigningAttributes: {
          DomainSigningSelector: params.dkim.selector,
          DomainSigningPrivateKey: params.dkim.privateKeyB64,
        },
      }),
    );
  } catch (error) {
    if (!params.adoptExisting || (error as { name?: string }).name !== "AlreadyExistsException") {
      throw error;
    }
    await client.send(
      new PutEmailIdentityDkimSigningAttributesCommand({
        EmailIdentity: params.domain,
        SigningAttributesOrigin: "EXTERNAL",
        SigningAttributes: {
          DomainSigningSelector: params.dkim.selector,
          DomainSigningPrivateKey: params.dkim.privateKeyB64,
        },
      }),
    );
  }
  await client.send(
    new PutEmailIdentityMailFromAttributesCommand({
      EmailIdentity: params.domain,
      MailFromDomain: `${params.mailFromSubdomain}.${params.domain}`,
      BehaviorOnMxFailure: "USE_DEFAULT_VALUE",
    }),
  );
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
  type: "MX" | "TXT";
  name: string;
  value: string;
  priority?: number;
}

/**
 * The DNS checklist for a domain identity: one BYODKIM TXT (verification),
 * MAIL FROM MX + SPF TXT (sending), and a recommended p=none DMARC TXT.
 */
export function dnsRecordsForDomain(params: {
  domain: string;
  dkimSelector: string;
  dkimPublicKey: string;
  mailFromSubdomain: string;
  region: string;
}): DnsRecord[] {
  const { domain, dkimSelector, dkimPublicKey, mailFromSubdomain, region } = params;
  const mailFromDomain = `${mailFromSubdomain}.${domain}`;
  return [
    {
      group: "verification",
      type: "TXT",
      name: `${dkimSelector}._domainkey.${domain}`,
      value: `"v=DKIM1; k=rsa; p=${dkimPublicKey}"`,
    },
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
