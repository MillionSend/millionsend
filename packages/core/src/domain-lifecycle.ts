import { type Db, schema } from "@millionsend/db";
import { and, asc, eq, inArray, isNull, ne } from "drizzle-orm";
import { parseSingleSender } from "./sender-address.js";

/** Consumer mailbox providers no tenant can own; refused on every deployment. */
const PUBLIC_MAILBOX_DOMAINS = [
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
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
] as const;

/** The hosted product's own domain; a cloud tenant must never hold its SES identity. */
export const PLATFORM_DOMAIN = "millionsend.com";

/** Creates per team per hour before the dashboard/API answer 429. */
export const DOMAIN_CREATE_LIMIT_PER_HOUR = 10;

/**
 * Whether `name` (or a subdomain of it) may not be registered as a sender
 * identity: public mailbox providers everywhere, plus in cloud the platform
 * domain and the operator's AUTH_EMAIL_FROM / ONBOARDING_EMAIL_FROM /
 * NOTIFICATIONS_EMAIL_FROM domains —
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
  },
): boolean {
  // Consumer mailbox providers are refused to everyone — nobody owns them.
  const reserved: string[] = [...PUBLIC_MAILBOX_DOMAINS];
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
 * be deleted, with a `failed` event carrying the reason. Must run in the
 * same transaction as the row delete: emails.domain_id is ON DELETE SET
 * NULL, so afterwards the rows can no longer be found by domain, and a
 * still-queued row would make the worker retry a sender that no longer
 * exists. Claimed rows (sent_at set) are left to the send handler.
 */
export async function failQueuedEmailsForDomain(
  db: Db,
  params: { teamId: string; domainId: string },
): Promise<number> {
  const e = schema.emails;
  const failed = await db
    .update(e)
    .set({ latestStatus: "failed" })
    .where(
      and(
        eq(e.teamId, params.teamId),
        eq(e.domainId, params.domainId),
        inArray(e.latestStatus, ["queued", "queued_quota"]),
        isNull(e.sentAt),
      ),
    )
    .returning({ id: e.id });
  if (failed.length > 0) {
    const occurredAt = new Date();
    await db.insert(schema.emailEvents).values(
      failed.map((row) => ({
        emailId: row.id,
        type: "failed" as const,
        occurredAt,
        data: { reason: "domain_deleted" },
      })),
    );
  }
  return failed.length;
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
