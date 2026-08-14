export {
  createSesAccountClient,
  getAccountOverview,
  type SesAccountClient,
  type SesAccountOverview,
} from "./account.js";
export {
  createDomainIdentity,
  createSesv2Client,
  type DkimVerificationStatus,
  type DnsRecord,
  type DnsRecordGroup,
  type DomainVerification,
  deleteDomainIdentity,
  dnsRecordsForDomain,
  getDomainVerification,
  type MailFromVerificationStatus,
  SES_REGIONS,
  type SesIdentityClient,
  type SesRegion,
} from "./domain-identity.js";
export {
  type ParsedSesEvent,
  parseSesEvent,
  type SesEventType,
} from "./ses-events.js";
export {
  type CertFetcher,
  canonicalString,
  createCachingCertFetcher,
  isAllowedCertUrl,
  isAllowedSnsUrl,
  type SnsMessage,
  snsMessageSchema,
  type VerifyOptions,
  type VerifyResult,
  verifySnsMessage,
} from "./sns-verify.js";
