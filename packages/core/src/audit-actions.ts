// Pure list, safe to import from client components (no db or node imports).
export const AUDIT_ACTIONS = [
  "api_key.created",
  "api_key.revoked",
  "domain.created",
  "domain.verified",
  "domain.deleted",
  "webhook.created",
  "webhook.updated",
  "webhook.deleted",
  "member.invited",
  "member.joined",
  "member.removed",
  "member.role_changed",
  "member.left",
  "invitation.revoked",
  "team.created",
  "team.deleted",
  "instance.settings_updated",
  "billing.checkout_started",
  "billing.portal_opened",
  "billing.subscription_updated",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
