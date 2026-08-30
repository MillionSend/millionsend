export {
  assertEnvConsistency,
  EMAIL_RETENTION_DAYS_DEFAULT,
  type Env,
  env,
  isCloudDeployment,
  parseCommaList,
  parseEmailFrom,
  parseSnsTopicArns,
  SES_MAX_SEND_RATE_DEFAULT,
  trackingSubdomainsSupported,
} from "./env.js";
