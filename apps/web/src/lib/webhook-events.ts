/**
 * Client-safe mirror of WEBHOOK_EVENT_TYPES in packages/core/src/webhooks.ts
 * (that module pulls node:crypto and the db schema, so client components
 * cannot import it). Kept in lockstep by a parity test in
 * apps/web/test/webhooks-router.test.ts.
 */
export const WEBHOOK_EVENT_TYPES = [
  "email.sent",
  "email.delivered",
  "email.delivery_delayed",
  "email.bounced",
  "email.complained",
  "email.opened",
  "email.clicked",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/** "whsec_••••••••abcd" — scheme plus last 4, nothing recoverable. */
export function maskWebhookSecret(last4: string): string {
  return `whsec_••••••••${last4}`;
}
