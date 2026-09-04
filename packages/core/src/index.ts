export type { ContactActivityType, SegmentCondition, SegmentFilter } from "@millionsend/db/schema";
export {
  type AcceptEmailAuth,
  type AcceptEmailDeps,
  type AcceptEmailPayload,
  type AcceptEmailResult,
  acceptEmail,
  estimateAttachmentBytes,
  isOnboardingSender,
  MAX_ATTACHMENT_BYTES,
  type OnboardingSenderVerdict,
  QUOTA_BACKLOG_DAYS,
  type SenderDomainVerdict,
  senderDomain,
  verifyOnboardingSender,
  verifySenderDomain,
} from "./accept-email.js";
export {
  ACCOUNT_SCORE_WINDOW_DAYS,
  type AccountScore,
  type AccountScoreInput,
  computeAccountScore,
  fetchAccountScore,
  MIN_OUTCOME_SENDS,
} from "./account-score.js";
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
  AUDIT_ACTIONS,
  type AuditAction,
  type AuditActor,
  type AuditEvent,
  apiRequestActor,
  type ParsedAuditActor,
  parseAuditActor,
  recordAudit,
} from "./audit.js";
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
  CONTACT_PROPERTY_KEY_MAX_LENGTH,
  CONTACT_PROPERTY_MAX_KEYS,
  CONTACT_PROPERTY_VALUE_MAX_LENGTH,
} from "./contact-properties.js";
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
  MIN_PAUSE_COMPLAINTS,
  MIN_PAUSE_HARD_BOUNCES,
  PAUSE_BOUNCE_RATE,
  PAUSE_COMPLAINT_RATE,
  PAUSE_WINDOW_DAYS,
  THROTTLED_BROADCAST_RATE_PER_SECOND,
  WARN_BOUNCE_RATE,
  WARN_COMPLAINT_RATE,
  type WindowCounts,
} from "./deliverability.js";
export {
  createFixedWindowLimiter,
  DOMAIN_CREATE_LIMIT_PER_HOUR,
  failQueuedEmailsForDomain,
  isIdentitySharedByOtherDomains,
  isOperatorTeam,
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
  CHECKS,
  type CheckId,
  type CheckSeverity,
  type CheckStatus,
  type EmailCheckResult,
  type EmailInsightsInput,
  evaluateEmailInsights,
  SCORE_VERSION,
  type ScoreBand,
  SHORTENER_HOSTS,
  scoreBand,
} from "./email-insights.js";
export { type EmailInsightsRow, fetchEmailInsights } from "./email-insights-lookup.js";
export { ERASED_TOMBSTONE, type EraseRecipientResult, eraseRecipient } from "./erase-recipient.js";
export { type SesEventsHealth, sesEventsHealth } from "./events-health.js";
export { EMAIL_WORDMARK_URL, escapeHtml } from "./html.js";
export {
  beginIdempotent,
  completeIdempotent,
  type IdempotencyBegin,
  purgeExpiredIdempotencyKeys,
  releaseIdempotent,
} from "./idempotency.js";
export { findInstanceOperator, isInstanceOperator } from "./instance-operator.js";
export { getInstanceSettings, type InstanceSettings } from "./instance-settings.js";
export { ANCHOR_HREF, type RewriteOptions, rewriteForTracking } from "./link-tracking.js";
export { claimNotification, clearNotifications, listTeamOwners } from "./notifications.js";
export {
  ADMIN_MCP_SCOPES,
  ALL_TEAMS_GRANT,
  apiBaseUrl,
  MCP_RESOURCE_PATH,
  MCP_SCOPES,
  type McpScope,
  mcpResourceUrl,
} from "./oauth-scopes.js";
export { isRootDomainSend, registrableDomain } from "./org-domain.js";
export {
  effectivePlan,
  PLAN_DAILY_LIMIT,
  PLAN_DOMAIN_LIMIT,
  PLAN_GRACE_DAYS,
  PLAN_TEAM_LIMIT,
  type Plan,
  QUOTA_TOLERANCE,
} from "./plans.js";
export {
  applyRegionBreakers,
  BREAKER_BOUNCE_RATE,
  BREAKER_COMPLAINT_RATE,
  BREAKER_MIN_SENT,
  BREAKER_WINDOWS_HOURS,
  evaluateRegionBreakers,
  type PausedRegion,
  pausedRegions,
  type RegionContributor,
  type RegionDecision,
  type RegionWindowCounts,
  regionPause,
  regionWindowCounts,
} from "./platform-breaker.js";
export { type QuotaResult, releaseDailyQuota, reserveDailyQuota } from "./quota.js";
export { parseScheduledAt, SCHEDULED_AT_FORMS } from "./scheduled-at.js";
export {
  SEGMENT_FILTER_MAX_CONDITIONS,
  SEGMENT_FILTER_VALUE_MAX_LENGTH,
  SegmentFilterError,
  segmentContactsWhere,
  segmentFilterSchema,
  segmentWhere,
} from "./segment-filter.js";
export { formatMailbox, type Mailbox, parseMailbox, parseSingleSender } from "./sender-address.js";
export { associateDomainTenant, markDomainTenantAssociated } from "./ses-tenant.js";
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
  suppressionHashesFor,
} from "./suppressions.js";
export {
  INVITE_EMAILS_PER_HOUR,
  INVITE_MAX_SENDS,
  INVITE_RESEND_COOLDOWN_MS,
  INVITE_TTL_MS,
  signInviteToken,
  verifyInviteToken,
} from "./team-invitations.js";
export { fetchBestOwnedPlan, fetchEffectivePlan } from "./team-plan.js";
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
export { DAY_MS, nextUtcDayStart, utcDay } from "./utc-day.js";
export {
  buildWebhookPayload,
  decryptWebhookSecret,
  encryptWebhookSecret,
  enqueueTeamWebhookDeliveries,
  enqueueWebhookDeliveries,
  generateWebhookSecret,
  isWebhookEventType,
  parseWebhookSecret,
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
