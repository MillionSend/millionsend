import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { type AcceptEmailDeps, acceptEmail } from "./accept-email.js";
import { parseSingleSender } from "./sender-address.js";

/**
 * Tag every system email carries; the value names the kind. A label only:
 * the public API accepts any tag name, so nothing may grant quota, bypass a
 * suppression or gate a send on its presence. The worker reads it to purge
 * the body after SES accepts the message and to ship the links untracked.
 */
export const SYSTEM_MAIL_TAG = "millionsend_system";

export type SystemMailKind =
  | "password_reset"
  | "email_verification"
  | "invitation"
  | "quota.warning"
  | "quota.reached"
  | "quota.paused"
  | "deliverability.warning"
  | "deliverability.paused"
  | "region.paused"
  | "region.resumed"
  | "updates.confirm";

export interface SystemMailMessage {
  /** `Name <user@domain>` or a bare address; one of the instance's sender env vars. */
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  kind: SystemMailKind;
}

export interface SenderDomainOwner {
  teamId: string;
  domainId: string;
}

/**
 * The team whose verified `domains` row names the sender's exact host — the
 * inverse of verifySenderDomain, and the whole of how an instance designates
 * where its own account mail is logged: verifying the sender's domain in a
 * team is the designation. Exact host, as everywhere: owning `example.com`
 * does not cover `mail.example.com`.
 *
 * Cloud refuses the same (name, region) in two teams, so the answer is
 * single-valued there. Self-host may hold one name in several teams; the
 * oldest verified row wins, which is also the row a later re-key demotes last.
 */
export async function findSenderDomainOwner(
  db: Db,
  from: string,
): Promise<SenderDomainOwner | null> {
  const sender = parseSingleSender(from);
  if (!sender) return null;
  const d = schema.domains;
  const [row] = await db
    .select({ teamId: d.teamId, domainId: d.id })
    .from(d)
    .where(and(eq(d.name, sender.domain), eq(d.status, "verified")))
    .orderBy(sql`${d.verifiedAt} asc nulls last`, asc(d.createdAt))
    .limit(1);
  return row ?? null;
}

/** The accept pipeline refused the message; the reason is acceptEmail's. */
export class SystemMailRefused extends Error {
  constructor(readonly reason: string) {
    super(`system mail refused: ${reason}`);
    this.name = "SystemMailRefused";
  }
}

export interface SystemSendDeps extends AcceptEmailDeps {
  /** Today's SESv2 Simple send, for senders no team owns. */
  raw(message: SystemMailMessage): Promise<void>;
}

const warnedSenders = new Set<string>();

/**
 * One account email (password reset, invitation, owner notification…).
 *
 * When a team owns the sender's verified domain the message rides the same
 * accept pipeline as customer mail into that team — emails row, quota
 * counters, SES events by tag, webhooks — under plan `scale`: the limit is
 * null while `accepted` still counts, and a parked password reset would
 * expire before the quota freed. Topic-less, so a recipient's one-click
 * unsubscribe never blocks account mail (the hosted page promises exactly
 * that) while hard bounces, complaints and manual suppressions still apply.
 *
 * No owner: the raw SES path, byte for byte what every instance did before
 * a team verified the domain. A refusal (all suppressed) throws and never
 * falls back — the suppression list is the point. A failure inside accept
 * (keyring, database, queue) falls back to raw so account mail outlives an
 * outage of the pipeline it normally rides.
 */
export async function sendSystemMail(
  deps: SystemSendDeps,
  message: SystemMailMessage,
): Promise<"pipeline" | "raw"> {
  const owner = await findSenderDomainOwner(deps.db, message.from);
  if (!owner) {
    if (!warnedSenders.has(message.from)) {
      warnedSenders.add(message.from);
      console.warn(
        `system mail: no team holds a verified domain for ${message.from}; account emails are sent raw and not logged. Verify its domain in a team to log them there.`,
      );
    }
    await deps.raw(message);
    return "raw";
  }
  let result: Awaited<ReturnType<typeof acceptEmail>>;
  try {
    result = await acceptEmail(
      deps,
      { teamId: owner.teamId, plan: "scale", apiKeyId: null },
      {
        from: message.from,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
        domainId: owner.domainId,
        tags: { [SYSTEM_MAIL_TAG]: message.kind },
      },
    );
  } catch (err) {
    console.error(`system mail: accept failed for ${message.kind}, sending raw`, err);
    await deps.raw(message);
    return "raw";
  }
  if (!result.ok) throw new SystemMailRefused(result.reason);
  return "pipeline";
}
