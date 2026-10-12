import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, desc, eq, gt, isNotNull, ne, type SQL, sql } from "drizzle-orm";
import type { Keyring } from "../crypto/keyring.js";
import { type InboxActor, recordInboxActivity } from "../inboxes/activity.js";
import type { VerificationCodeWire } from "../inboxes/types.js";
import { escapeLike } from "../segment-filter.js";
import { openReceivedExtracted } from "./message.js";

const NONE: VerificationCodeWire = {
  object: "verification_code",
  status: "none",
  kind: null,
  code: null,
  url: null,
  link_domain_matches_sender: null,
  email_id: null,
  from: null,
  received_at: null,
  sender_trust: null,
};

/**
 * A sender filter: an address matches exactly, a domain (or "*@domain")
 * matches itself and its subdomains.
 */
export function receivedFromMatches(
  column: SQL | typeof schema.receivedEmails.from,
  from: string,
): SQL {
  const value = from.trim().toLowerCase().replace(/^\*@/, "");
  if (value.includes("@")) return sql`lower(${column}) = ${value}`;
  const domain = sql`split_part(lower(${column}), '@', 2)`;
  return sql`(${domain} = ${value} or ${domain} like ${`%.${escapeLike(value)}`} escape '\\')`;
}

/**
 * The newest delivered code or sign-in link of an inbox, within maxAgeMs:
 * never from held mail, from a sender that failed authentication, or from
 * an inbox with extract_codes off. A served value writes code.read; the
 * activity row names the email, never the value.
 */
export async function latestVerificationCode(
  db: Db,
  keyring: Keyring,
  p: {
    teamId: string;
    inboxId: string;
    from: string | null;
    maxAgeMs: number;
    actor: InboxActor;
    now?: Date | undefined;
  },
): Promise<VerificationCodeWire> {
  const now = p.now ?? new Date();
  const i = schema.inboxes;
  const [inbox] = await db
    .select({ safety: i.safety })
    .from(i)
    .where(and(eq(i.id, p.inboxId), eq(i.teamId, p.teamId)));
  if (!inbox?.safety.extract_codes) return NONE;
  const r = schema.receivedEmails;
  const m = schema.receivedEmailInboxes;
  const [row] = await db
    .select({
      id: r.id,
      teamId: r.teamId,
      extracted: r.extracted,
      from: r.from,
      createdAt: r.createdAt,
      senderTrust: m.senderTrust,
      threadId: m.threadId,
    })
    .from(m)
    .innerJoin(r, eq(r.id, m.receivedEmailId))
    .where(
      and(
        eq(m.inboxId, p.inboxId),
        eq(m.teamId, p.teamId),
        isNotNull(m.deliveredAt),
        ne(m.senderTrust, "failed"),
        gt(r.createdAt, new Date(now.getTime() - p.maxAgeMs)),
        sql`cardinality(${r.extractedKinds}) > 0`,
        ...(p.from ? [receivedFromMatches(r.from, p.from)] : []),
      ),
    )
    .orderBy(desc(r.createdAt), desc(r.id))
    .limit(1);
  const extracted = row ? await openReceivedExtracted(row, keyring) : null;
  if (!row || !extracted) return NONE;
  const base = {
    ...NONE,
    email_id: row.id,
    from: row.from,
    received_at: row.createdAt.toISOString(),
    sender_trust: row.senderTrust,
  };
  const code = extracted.code;
  const link = extracted.link;
  let found: VerificationCodeWire;
  if (code && "value" in code) {
    found = { ...base, status: "found", kind: "otp", code: code.value };
  } else if (link && "url" in link) {
    found = {
      ...base,
      status: "found",
      kind: "link",
      url: link.url,
      link_domain_matches_sender: link.linkDomainMatchesSender,
    };
  } else if (code || link) {
    return { ...base, status: "ambiguous" };
  } else {
    return NONE;
  }
  await recordInboxActivity(db, {
    teamId: p.teamId,
    inboxId: p.inboxId,
    actor: p.actor,
    action: "code.read",
    threadId: row.threadId,
    emailId: row.id,
  });
  return found;
}
