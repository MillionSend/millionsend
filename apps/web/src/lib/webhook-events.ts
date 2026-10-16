/**
 * Client-safe mirror of WEBHOOK_EVENT_TYPES in packages/core/src/webhooks.ts
 * (that module pulls node:crypto and the db schema, so client components
 * cannot import it). Kept in lockstep by a parity test in
 * apps/web/test/webhooks-router.test.ts.
 */
export const WEBHOOK_EVENT_TYPES = [
  "email.scheduled",
  "email.sent",
  "email.delivered",
  "email.delivery_delayed",
  "email.bounced",
  "email.complained",
  "email.failed",
  "email.suppressed",
  "email.opened",
  "email.clicked",
  "email.prefetched",
  "email.received",
  "deliverability.warning",
  "deliverability.paused",
  "quota.warning",
  "quota.reached",
  "quota.paused",
  "contact.created",
  "contact.updated",
  "contact.deleted",
  "contact.unsubscribed",
  "contact.resubscribed",
  "contact.topic_opt_in",
  "contact.topic_opt_out",
  "suppression.added",
  "suppression.removed",
  "inbox.created",
  "inbox.updated",
  "inbox.deleted",
  "inbox.expired",
  "inbox.thread.created",
  "inbox.thread.folder.updated",
  "inbox.thread.labels.updated",
  "inbox.email.received",
  "inbox.email.sent",
  "inbox.email.quarantined",
  "inbox.draft.created",
  "inbox.draft.updated",
  "inbox.draft.sent",
  "inbox.draft.deleted",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/** Lifecycle buckets for the event picker; labels resolve via webhooks.eventGroup.*. */
export const WEBHOOK_EVENT_GROUPS = [
  "delivery",
  "engagement",
  "problems",
  "account",
  "audience",
  "receiving",
  "inboxes",
] as const;
export type WebhookEventGroup = (typeof WEBHOOK_EVENT_GROUPS)[number];

/**
 * Presentation annotation over WEBHOOK_EVENT_TYPES — never a second source
 * list. Each event's human label resolves via webhooks.eventLabel.<type>;
 * `dot` reuses the shared per-event hue tokens (tokens/colors.css --ms-dot-*).
 * Parity with WEBHOOK_EVENT_TYPES is guarded in webhooks-router.test.ts.
 */
export const WEBHOOK_EVENT_META: Record<
  WebhookEventType,
  // optIn mirrors OPT_IN_EVENT_TYPES in packages/core/src/webhooks.ts: the
  // picker leaves it unchecked under "All" because "all events" never carries it.
  { group: WebhookEventGroup; dot: string; optIn?: true }
> = {
  "email.scheduled": { group: "delivery", dot: "var(--ms-dot-queued)" },
  "email.sent": { group: "delivery", dot: "var(--ms-dot-sent)" },
  "email.delivered": { group: "delivery", dot: "var(--ms-dot-delivered)" },
  "email.delivery_delayed": { group: "delivery", dot: "var(--ms-dot-delivery-delayed)" },
  "email.opened": { group: "engagement", dot: "var(--ms-dot-opened)" },
  "email.clicked": { group: "engagement", dot: "var(--ms-dot-clicked)" },
  "email.prefetched": { group: "engagement", dot: "var(--ms-dot-queued)", optIn: true },
  "email.received": { group: "receiving", dot: "var(--ms-dot-delivered)" },
  "email.bounced": { group: "problems", dot: "var(--ms-dot-bounced)" },
  "email.complained": { group: "problems", dot: "var(--ms-dot-complained)" },
  "email.failed": { group: "problems", dot: "var(--ms-dot-failed)" },
  "email.suppressed": { group: "problems", dot: "var(--ms-dot-suppressed)" },
  "deliverability.warning": { group: "account", dot: "var(--ms-dot-account)" },
  "deliverability.paused": { group: "account", dot: "var(--ms-dot-account)" },
  "quota.warning": { group: "account", dot: "var(--ms-dot-account)" },
  "quota.reached": { group: "account", dot: "var(--ms-dot-account)" },
  "quota.paused": { group: "account", dot: "var(--ms-dot-account)" },
  "contact.created": { group: "audience", dot: "var(--ms-dot-delivered)" },
  "contact.updated": { group: "audience", dot: "var(--ms-dot-sent)" },
  "contact.deleted": { group: "audience", dot: "var(--ms-dot-failed)" },
  "contact.unsubscribed": { group: "audience", dot: "var(--ms-dot-suppressed)" },
  "contact.resubscribed": { group: "audience", dot: "var(--ms-dot-delivered)" },
  "contact.topic_opt_in": { group: "audience", dot: "var(--ms-dot-opened)" },
  "contact.topic_opt_out": { group: "audience", dot: "var(--ms-dot-queued)" },
  "suppression.added": { group: "audience", dot: "var(--ms-dot-suppressed)" },
  "suppression.removed": { group: "audience", dot: "var(--ms-dot-sent)" },
  "inbox.created": { group: "inboxes", dot: "var(--ms-dot-delivered)", optIn: true },
  "inbox.updated": { group: "inboxes", dot: "var(--ms-dot-sent)", optIn: true },
  "inbox.deleted": { group: "inboxes", dot: "var(--ms-dot-failed)", optIn: true },
  "inbox.expired": { group: "inboxes", dot: "var(--ms-dot-queued)", optIn: true },
  "inbox.thread.created": { group: "inboxes", dot: "var(--ms-dot-delivered)", optIn: true },
  "inbox.thread.folder.updated": { group: "inboxes", dot: "var(--ms-dot-sent)", optIn: true },
  "inbox.thread.labels.updated": { group: "inboxes", dot: "var(--ms-dot-opened)", optIn: true },
  "inbox.email.received": { group: "inboxes", dot: "var(--ms-dot-delivered)", optIn: true },
  "inbox.email.sent": { group: "inboxes", dot: "var(--ms-dot-sent)", optIn: true },
  "inbox.email.quarantined": { group: "inboxes", dot: "var(--ms-dot-complained)", optIn: true },
  "inbox.draft.created": { group: "inboxes", dot: "var(--ms-dot-queued)", optIn: true },
  "inbox.draft.updated": { group: "inboxes", dot: "var(--ms-dot-sent)", optIn: true },
  "inbox.draft.sent": { group: "inboxes", dot: "var(--ms-dot-delivered)", optIn: true },
  "inbox.draft.deleted": { group: "inboxes", dot: "var(--ms-dot-failed)", optIn: true },
};

/** "whsec_••••••••abcd" — scheme plus last 4, nothing recoverable. */
export function maskWebhookSecret(last4: string): string {
  return `whsec_••••••••${last4}`;
}
