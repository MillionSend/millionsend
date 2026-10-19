import { sharedInboxDomain } from "@millionsend/config";
import { type Db, schema } from "@millionsend/db";
import { and, asc, eq, isNull, ne } from "drizzle-orm";
import { parseSingleSender } from "./sender-address.js";
import { endQueuedEmails } from "./status.js";
import type { WebhookEnqueue } from "./webhooks.js";

/**
 * Consumer mailbox providers: no tenant can own one as a sender, on every
 * deployment, and no disposable-domain list can block one.
 */
export const PUBLIC_MAILBOX_DOMAINS = [
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.com.br",
  "outlook.com",
  "outlook.com.br",
  "hotmail.com",
  "hotmail.com.br",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "zoho.com",
  "mail.com",
  "yandex.com",
  "uol.com.br",
  "bol.com.br",
  "terra.com.br",
  "ig.com.br",
] as const;

/** The hosted product's own domain; a cloud tenant must never hold its SES identity. */
export const PLATFORM_DOMAIN = "millionsend.com";

/** Creates per team per hour before the dashboard/API answer 429. */
export const DOMAIN_CREATE_LIMIT_PER_HOUR = 10;

/**
 * Whether `name` (or a subdomain of it) may not be registered as a sender
 * identity: public mailbox providers and the shared inbox domain everywhere,
 * plus in cloud the platform domain and the operator's AUTH_EMAIL_FROM /
 * ONBOARDING_EMAIL_FROM / NOTIFICATIONS_EMAIL_FROM domains —
 * SES identities are account-wide, so a tenant registering them would take
 * over system mail.
 */
export function isReservedSenderDomain(
  name: string,
  opts: {
    isCloud: boolean;
    authEmailFrom?: string | null | undefined;
    onboardingEmailFrom?: string | null | undefined;
    notificationsEmailFrom?: string | null | undefined;
    isOperator?: boolean;
    /** Defaults to SHARED_INBOX_DOMAIN. */
    sharedInboxDomain?: string | null | undefined;
  },
): boolean {
  // Consumer mailbox providers are refused to everyone — nobody owns them.
  const reserved: string[] = [...PUBLIC_MAILBOX_DOMAINS];
  // The shared inbox domain's subdomains are handed to teams' inboxes; a
  // domain row there, even the operator's, would compete for their mail.
  const shared =
    opts.sharedInboxDomain === undefined ? sharedInboxDomain() : opts.sharedInboxDomain;
  if (shared) reserved.push(shared);
  // The platform domain and the system-mail domain are the operator's own, so
  // the operator may send from them (dogfooding); a tenant registering them
  // would take over account-wide system mail.
  if (opts.isCloud && !opts.isOperator) {
    reserved.push(PLATFORM_DOMAIN);
    for (const sender of [
      opts.authEmailFrom,
      opts.onboardingEmailFrom,
      opts.notificationsEmailFrom,
    ]) {
      const domain = sender ? parseSingleSender(sender)?.domain : null;
      if (domain) reserved.push(domain);
    }
  }
  return reserved.some((d) => name === d || name.endsWith(`.${d}`));
}

/**
 * Whether `teamId` is a team the instance operator (the first registered user)
 * belongs to. The operator is trusted to send from the platform's own domains;
 * a tenant is not.
 */
export async function isOperatorTeam(db: Db, teamId: string): Promise<boolean> {
  const [firstUser] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .orderBy(asc(schema.user.createdAt), asc(schema.user.id))
    .limit(1);
  if (!firstUser) return false;
  const [member] = await db
    .select({ id: schema.teamMembers.id })
    .from(schema.teamMembers)
    .where(and(eq(schema.teamMembers.teamId, teamId), eq(schema.teamMembers.userId, firstUser.id)))
    .limit(1);
  return member !== undefined;
}

/**
 * Whether another domains row (any team) still references the same SES
 * identity — identities are per (name, region) in the AWS account, so the
 * identity may only be deleted once the last row referencing it goes.
 */
export async function isIdentitySharedByOtherDomains(
  db: Db,
  domain: { id: string; name: string; region: string },
): Promise<boolean> {
  const d = schema.domains;
  const [other] = await db
    .select({ id: d.id })
    .from(d)
    .where(and(eq(d.name, domain.name), eq(d.region, domain.region), ne(d.id, domain.id)))
    .limit(1);
  return other !== undefined;
}

/**
 * Terminally fails every not-yet-claimed queued email of a domain about to
 * be deleted, with a `failed` event carrying the reason and email.failed.
 * Must run in the same transaction as the row delete: emails.domain_id is
 * ON DELETE SET NULL, so afterwards the rows can no longer be found by
 * domain, and a still-queued row would make the worker retry a sender that
 * no longer exists. Claimed rows (sent_at set) are left to the send
 * handler. `enqueue` collects the webhook rows for the caller to hand to
 * the queue once its transaction commits (webhookBatch).
 */
export async function failQueuedEmailsForDomain(
  db: Db,
  params: { teamId: string; domainId: string; enqueue: WebhookEnqueue },
): Promise<number> {
  const e = schema.emails;
  return endQueuedEmails(db, {
    status: "failed",
    where: and(eq(e.teamId, params.teamId), eq(e.domainId, params.domainId), isNull(e.sentAt)),
    data: { reason: "domain_deleted" },
    now: new Date(),
    enqueue: params.enqueue,
  });
}

/**
 * Fixed-window counter keyed by an opaque id: true once the key exceeded
 * `limit` hits inside the current window.
 */
export function createFixedWindowLimiter(
  limit: number,
  windowMs: number,
): (key: string) => boolean {
  // ponytail: per-process window; N instances allow N× the cap. Move to the
  // api_rate_limits table if that ever matters.
  const counts = new Map<string, number>();
  let window = -1;
  return (key) => {
    const current = Math.floor(Date.now() / windowMs);
    if (current !== window) {
      window = current;
      counts.clear();
    }
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    return n > limit;
  };
}
