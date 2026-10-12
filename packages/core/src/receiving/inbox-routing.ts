import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, inArray, or } from "drizzle-orm";
import type { InboxKeys } from "../inboxes/keys.js";
import { verifyThreadTokenRef } from "../inboxes/keys.js";
import { liveInbox } from "../inboxes/limits.js";
import type { InboxSafety } from "../inboxes/safety.js";
import type { InboxKind } from "../inboxes/types.js";
import type { ReceivingDomain } from "./rcpt.js";

/** The inbox an envelope recipient lands in. */
export interface InboxTarget {
  id: string;
  teamId: string;
  kind: InboxKind;
  safety: InboxSafety;
  domainId: string | null;
  sharedDomainId: string | null;
  emailAddress: string;
}

const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1);

/** The inbox key of an address: lowercase, the local part cut at its first "+" when `untagged`. */
export function inboxKey(address: string, untagged: boolean): string {
  const at = address.lastIndexOf("@");
  const local = address.slice(0, at).toLowerCase();
  const plus = local.indexOf("+");
  return `${untagged && plus > 0 ? local.slice(0, plus) : local}@${address.slice(at + 1).toLowerCase()}`;
}

/**
 * Each envelope recipient's live inbox: an exact match of its email_address
 * or receiving_address first, then the address without its +tag. Only an
 * inbox of the team that owns the recipient's domain counts, so a recipient
 * routes domain → team → inbox and nothing else (no header, no other team).
 * Keys are the addresses as given (routableAddress form).
 */
export async function findInboxesForRecipients(
  db: Db,
  domains: readonly ReceivingDomain[],
  addresses: readonly string[],
  now: Date,
): Promise<Map<string, InboxTarget>> {
  const teamOf = new Map(domains.map((d) => [d.name, d.teamId]));
  const wanted = addresses.filter((a) => teamOf.has(domainOf(a)));
  const found = new Map<string, InboxTarget>();
  if (wanted.length === 0) return found;
  const i = schema.inboxes;
  const keys = [...new Set(wanted.flatMap((a) => [inboxKey(a, false), inboxKey(a, true)]))];
  const rows = await db
    .select({
      id: i.id,
      teamId: i.teamId,
      kind: i.kind,
      safety: i.safety,
      domainId: i.domainId,
      sharedDomainId: i.sharedDomainId,
      emailAddress: i.emailAddress,
      receivingAddress: i.receivingAddress,
    })
    .from(i)
    .where(
      and(or(inArray(i.emailAddress, keys), inArray(i.receivingAddress, keys)), liveInbox(now)),
    );
  const byKey = new Map<string, InboxTarget>();
  for (const { receivingAddress, ...row } of rows) {
    byKey.set(row.emailAddress, row);
    if (receivingAddress) byKey.set(receivingAddress, row);
  }
  for (const address of wanted) {
    const team = teamOf.get(domainOf(address));
    const exact = byKey.get(inboxKey(address, false));
    const inbox = exact ?? byKey.get(inboxKey(address, true));
    if (inbox && inbox.teamId === team) found.set(address, inbox);
  }
  return found;
}

/** A thread a received message belongs to, and how sure that is. */
export interface ResolvedThread {
  threadId: string;
  /** token or ses_id prove we wrote the message replied to; null threads by message-id only. */
  proof: "token" | "ses_id" | null;
  /** Who our outbound messages in it went to (known_thread needs a proof and one of them). */
  participants: string[];
}

/**
 * Which of an inbox's threads a received message continues, from its
 * In-Reply-To and References (never its subject), in order: our signed
 * thread token, the SES message id of one of our sends from this inbox
 * (local part only, the domain varies by region), then an earlier message
 * received in this inbox, which threads but proves nothing.
 */
export async function resolveThread(
  db: Db,
  keys: InboxKeys | undefined,
  p: { teamId: string; inboxId: string; refs: readonly string[] },
): Promise<ResolvedThread | null> {
  if (p.refs.length === 0) return null;
  const t = schema.inboxThreads;
  const threadOf = async (threadId: string, proof: ResolvedThread["proof"]) => {
    const [row] = await db
      .select({ id: t.id, participants: t.participants })
      .from(t)
      .where(and(eq(t.id, threadId), eq(t.inboxId, p.inboxId), eq(t.teamId, p.teamId)));
    return row ? { threadId: row.id, proof, participants: row.participants } : null;
  };
  if (keys) {
    for (const ref of p.refs) {
      const threadId = verifyThreadTokenRef(keys, { teamId: p.teamId, inboxId: p.inboxId, ref });
      const thread = threadId ? await threadOf(threadId, "token") : null;
      if (thread) return thread;
    }
  }
  const sesIds = p.refs.flatMap((ref) => {
    const m = /^<([^@<>]{1,200})@[^<>]*\.amazonses\.com>$/i.exec(ref);
    return m?.[1] ? [m[1]] : [];
  });
  if (sesIds.length > 0) {
    const e = schema.emails;
    const sent = await db
      .select({ threadId: e.threadId })
      .from(e)
      .where(
        and(inArray(e.sesMessageId, sesIds), eq(e.teamId, p.teamId), eq(e.inboxId, p.inboxId)),
      );
    for (const row of sent) {
      const thread = row.threadId ? await threadOf(row.threadId, "ses_id") : null;
      if (thread) return thread;
    }
  }
  const r = schema.receivedEmails;
  const m = schema.receivedEmailInboxes;
  const [earlier] = await db
    .select({ threadId: m.threadId })
    .from(r)
    .innerJoin(m, and(eq(m.receivedEmailId, r.id), eq(m.inboxId, p.inboxId)))
    .where(and(eq(r.teamId, p.teamId), inArray(r.messageId, [...p.refs])))
    .orderBy(r.createdAt)
    .limit(1);
  return earlier ? threadOf(earlier.threadId, null) : null;
}

/** The login addresses of a team's members, lowercase: an inbox's owners besides its owner_addresses. */
export async function teamMemberEmails(db: Db, teamId: string): Promise<string[]> {
  const rows = await db
    .select({ email: schema.user.email })
    .from(schema.teamMembers)
    .innerJoin(schema.user, eq(schema.user.id, schema.teamMembers.userId))
    .where(eq(schema.teamMembers.teamId, teamId));
  return rows.map((r) => r.email.toLowerCase());
}
