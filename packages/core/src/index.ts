export type { SegmentCondition, SegmentFilter } from "@millionsend/db/schema";
export {
  type AcceptEmailAuth,
  type AcceptEmailDeps,
  type AcceptEmailPayload,
  type AcceptEmailResult,
  acceptEmail,
  type SenderDomainVerdict,
  senderDomain,
  verifySenderDomain,
} from "./accept-email.js";
export { type ApiKeyAuth, authenticateApiKey } from "./api-key-auth.js";
export {
  type ApiKeyMode,
  extractTokenPrefix,
  type GeneratedApiKey,
  generateApiKey,
  hashApiKey,
  verifyApiKey,
} from "./api-keys.js";
export {
  BOUNCE_GUIDANCE_KEYS,
  type BounceCategory,
  type BounceGuidance,
  parseSmtpDiagnostic,
  type ResolveBounceInput,
  resolveBounceGuidance,
  resolveComplaintGuidance,
} from "./bounce-guidance.js";
export { canonicalBodyHash, canonicalStringify } from "./canonical-json.js";
export {
  decryptEmailBody,
  decryptPayload,
  type EmailBody,
  type EncryptedBody,
  encryptEmailBody,
  encryptPayload,
} from "./crypto/envelope.js";
export { EnvKeyring, type Keyring } from "./crypto/keyring.js";
export {
  broadcastSendSpacingMs,
  type DeliverabilityEvaluation,
  type DeliverabilityHealth,
  type DeliverabilityReason,
  type DeliverabilityStatus,
  evaluateDeliverability,
  fetchDeliverabilityHealth,
  GUARDRAIL_WINDOW_DAYS,
  MIN_GUARDRAIL_VOLUME,
  PAUSE_BOUNCE_RATE,
  PAUSE_COMPLAINT_RATE,
  THROTTLED_BROADCAST_RATE_PER_SECOND,
  WARN_BOUNCE_RATE,
  WARN_COMPLAINT_RATE,
} from "./deliverability.js";
export {
  combineRecordStatus,
  type DomainStatus,
  type LiveDnsStatus,
  type RecordStatus,
  recordCheck,
  type SesGate,
  sesGateFromRecordStatus,
  strictDomainStatus,
} from "./domain-status.js";
export { firstRow, resultRows } from "./driver-result.js";
export {
  beginIdempotent,
  completeIdempotent,
  type IdempotencyBegin,
  purgeExpiredIdempotencyKeys,
  releaseIdempotent,
} from "./idempotency.js";
export { getInstanceSettings, type InstanceSettings } from "./instance-settings.js";
export { type RewriteOptions, rewriteForTracking } from "./link-tracking.js";
export { PLAN_DAILY_LIMIT, type Plan } from "./plans.js";
export { type QuotaResult, releaseDailyQuota, reserveDailyQuota } from "./quota.js";
export {
  SegmentFilterError,
  segmentFilterSchema,
  segmentWhere,
} from "./segment-filter.js";
export { parseSingleSender } from "./sender-address.js";
export { isBlockedIp, type PostJsonOptions, type PostJsonResult, postJson } from "./ssrf.js";
export { applyStatusCas, type EmailStatus, transitionQueueState } from "./status.js";
export { extractAddrSpec, findSuppressed, hashRecipient } from "./suppressions.js";
export { INVITE_TTL_MS, signInviteToken, verifyInviteToken } from "./team-invitations.js";
export { isSubscribedToTopic } from "./topics.js";
export {
  deriveTrackingKey,
  makeClickToken,
  makeOpenToken,
  verifyClickToken,
  verifyOpenToken,
} from "./tracking.js";
export {
  buildUnsubscribeHeaders,
  buildUnsubscribeUrl,
  deriveUnsubscribeKey,
  makeUnsubscribeToken,
  verifyUnsubscribeToken,
} from "./unsubscribe.js";
export { DAY_MS, utcDay } from "./utc-day.js";
export {
  buildWebhookPayload,
  decryptWebhookSecret,
  encryptWebhookSecret,
  enqueueWebhookDeliveries,
  generateWebhookSecret,
  isWebhookEventType,
  signWebhook,
  verifyWebhookSignature,
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RETRY_SCHEDULE_MS,
  type WebhookEmailFacts,
  type WebhookEventType,
  type WebhookPayload,
  type WebhookSignatureHeaders,
} from "./webhooks.js";
