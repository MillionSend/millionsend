// Pure list, safe to import from client components (no db or node imports).
import type { SystemMailKind } from "./system-mail.js";

/**
 * The owner notices a person may turn off, grouped as the settings page
 * shows them. A key covers every kind it stands for: the severity steps of
 * one notice fold into one switch, as does a domain's two ways of losing
 * verification. Mail about the account itself (welcome, password, apps) and
 * the security receipts (keys, webhook secrets) are not here: always sent.
 */
export const MAIL_PREFERENCE_GROUPS = [
  { group: "domains", cloudOnly: false, keys: ["domain.verified", "domain.lost"] },
  { group: "team", cloudOnly: false, keys: ["member.joined"] },
  {
    group: "broadcasts",
    cloudOnly: false,
    keys: ["broadcast.sent", "broadcast.held_quota", "broadcast.held"],
  },
  { group: "sending", cloudOnly: false, keys: ["quota", "deliverability"] },
  {
    group: "webhooks",
    cloudOnly: false,
    keys: ["webhook.failing", "webhook.auto_disabled", "webhook.backlog"],
  },
  {
    group: "billing",
    cloudOnly: true,
    keys: [
      "billing.payment_failed",
      "billing.plan_activated",
      "billing.plan_changed",
      "billing.cancel_scheduled",
      "billing.cancel_reminder",
      "billing.downgraded",
    ],
  },
] as const;

export type MailPreferenceKey = (typeof MAIL_PREFERENCE_GROUPS)[number]["keys"][number];

export const MAIL_PREFERENCE_KEYS: readonly MailPreferenceKey[] = MAIL_PREFERENCE_GROUPS.flatMap(
  (g) => g.keys,
);

export function isMailPreferenceKey(value: unknown): value is MailPreferenceKey {
  return typeof value === "string" && (MAIL_PREFERENCE_KEYS as readonly string[]).includes(value);
}

/** The switch a kind answers to; null for mail that is always sent. */
export function mailPreferenceOf(kind: SystemMailKind): MailPreferenceKey | null {
  if (kind === "domain.lost.identity") return "domain.lost";
  if (kind.startsWith("quota.")) return "quota";
  if (kind.startsWith("deliverability.")) return "deliverability";
  return isMailPreferenceKey(kind) ? kind : null;
}
