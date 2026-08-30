export type { ContactActivityType, SegmentCondition, SegmentFilter } from "@millionsend/db/schema";
export {
  type AcceptEmailAuth,
  type AcceptEmailDeps,
  type AcceptEmailPayload,
  type AcceptEmailResult,
  acceptEmail,
  estimateAttachmentBytes,
  MAX_ATTACHMENT_BYTES,
  QUOTA_BACKLOG_DAYS,
  type SenderDomainVerdict,
  senderDomain,
  verifySenderDomain,
} from "./accept-email.js";
export { type ApiKeyAuth, authenticateApiKey } from "./api-key-auth.js";
export {
  extractTokenPrefix,
  type GeneratedApiKey,
  generateApiKey,
  hashApiKey,
  MAX_ACTIVE_API_KEYS,
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
export { type ContactActivityRow, recordContactActivity } from "./contact-activities.js";
export {
  BOUND_ENVELOPE_VERSION_OFFSET,
  decryptEmailBody,
  decryptPayload,
  type EmailAttachment,
  type EmailBody,
  type EncryptedBody,
  type EnvelopeBinding,
  type EnvelopeKind,
  type EnvelopeOwner,
  encryptEmailBody,
  encryptPayload,
  openAttachments,
  sealAttachments,
} from "./crypto/envelope.js";
export { type DekContext, EnvKeyring, type Keyring } from "./crypto/keyring.js";
export {
  CompositeKeyring,
  KMS_KEY_VERSION,
  type KmsDekClient,
  KmsKeyring,
} from "./crypto/kms-keyring.js";
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
  createFixedWindowLimiter,
  DOMAIN_CREATE_LIMIT_PER_HOUR,
  failQueuedEmailsForDomain,
  isIdentitySharedByOtherDomains,
  isReservedSenderDomain,
  PLATFORM_DOMAIN,
} from "./domain-lifecycle.js";
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
export {
  ADMIN_MCP_SCOPES,
  ALL_TEAMS_GRANT,
  apiBaseUrl,
  MCP_RESOURCE_PATH,
  MCP_SCOPES,
  type McpScope,
  mcpResourceUrl,
} from "./oauth-scopes.js";
export {
  effectivePlan,
  fetchEffectivePlan,
  PLAN_DAILY_LIMIT,
  PLAN_DOMAIN_LIMIT,
  PLAN_GRACE_DAYS,
  type Plan,
} from "./plans.js";
export { type QuotaResult, releaseDailyQuota, reserveDailyQuota } from "./quota.js";
export { parseScheduledAt, SCHEDULED_AT_FORMS } from "./scheduled-at.js";
export {
  SegmentFilterError,
  segmentContactsWhere,
  segmentFilterSchema,
  segmentWhere,
} from "./segment-filter.js";
export { formatMailbox, type Mailbox, parseMailbox, parseSingleSender } from "./sender-address.js";
export {
  isBlockedIp,
  type PostFailureCode,
  type PostJsonOptions,
  type PostJsonResult,
  postFailureCode,
  postJson,
} from "./ssrf.js";
export { applyStatusCas, type EmailStatus, transitionQueueState } from "./status.js";
export {
  clearUnsubscribeSuppression,
  extractAddrSpec,
  findSuppressed,
  hashRecipient,
  normalizeAddress,
} from "./suppressions.js";
export { INVITE_TTL_MS, signInviteToken, verifyInviteToken } from "./team-invitations.js";
export { findTopicOptOuts, isSubscribedToTopic } from "./topics.js";
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
  substituteUnsubscribeUrl,
  UNSUBSCRIBE_URL_TOKENS,
  verifyUnsubscribeToken,
} from "./unsubscribe.js";
export { isLoopbackUrl } from "./url.js";
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
