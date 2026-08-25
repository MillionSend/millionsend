export {
  createSesAccountClient,
  getAccountOverview,
  type SesAccountClient,
  type SesAccountOverview,
} from "./account.js";
export {
  checkDnsRecords,
  type DnsCheckRecord,
  type DnsResolver,
  nodeDnsResolver,
} from "./dns-check.js";
export {
  applyDomainConfiguration,
  type DomainConfiguration,
  domainConfigurationSetName,
  ensureDomainConfigurationSet,
  type SesConfigClient,
  type TlsMode,
} from "./domain-config.js";
export {
  createDomainIdentity,
  createSesv2Client,
  DKIM_SELECTOR,
  type DkimVerificationStatus,
  type DnsRecord,
  type DnsRecordGroup,
  type DomainVerification,
  deleteDomainIdentity,
  dnsRecordsForDomain,
  generateDkimKeyPair,
  getDomainVerification,
  type MailFromVerificationStatus,
  SES_REGIONS,
  type SesIdentityClient,
  type SesRegion,
} from "./domain-identity.js";
export {
  computeDomainVerification,
  type DomainVerificationResult,
  type TrackedDnsRecord,
} from "./domain-verification.js";
export {
  createSesSendClient,
  type SesSendClient,
  type SimpleEmail,
  sendSimpleEmail,
} from "./send.js";
export {
  type ParsedSesEvent,
  parseSesEvent,
  type SesEventType,
} from "./ses-events.js";
export {
  httpsOrigin,
  runSetup,
  runTeardown,
  SES_EVENT_TYPES,
  SES_IAM_POLICY,
  SES_IAM_POLICY_JSON,
  SETUP_NAMES,
  type SetupClients,
  type SetupResult,
  setupEnvEntries,
  setupPlan,
  snsTopicPolicy,
  teardownPlan,
  upsertEnv,
} from "./setup.js";
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
