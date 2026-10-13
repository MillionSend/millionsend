import { randomUUID } from "node:crypto";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, isNotNull } from "drizzle-orm";
import { createSemaphore } from "../concurrency.js";
import type { Keyring } from "../crypto/keyring.js";
import { visibleLine } from "../customer-text.js";
import { sha256Hex } from "../hash.js";
import { type InboxKeys, secretMac } from "../inboxes/keys.js";
import { routableAddress } from "../sender-address.js";
import { enqueueTeamWebhookEvents, type WebhookEnqueue } from "../webhooks.js";
import { automatedReason } from "./automated.js";
import type { VirusResult } from "./clamd.js";
import {
  type AfterCommit,
  afterCommit,
  announceIfVisible,
  bumpInboxReceived,
  markDelivered,
  markQuarantined,
  runAfterCommit,
} from "./delivery.js";
import { decideScreening } from "./inbound-rules.js";
import {
  findInboxesForRecipients,
  type InboxTarget,
  resolveThread,
  teamMemberEmails,
} from "./inbox-routing.js";
import {
  parseReceivedMetadata,
  RECEIVED_EMAIL_META_COLUMNS,
  type ReceivedAttachment,
  type ReceivedEmailMeta,
  type ReceivedMetadata,
  receivedAttachmentId,
  receivedEmailEventData,
  sealReceivedAttachments,
  sealReceivedExtracted,
  sealReceivedRaw,
} from "./message.js";
import { type DeliverEnvelope, MAX_RECEIVED_MESSAGE_BYTES, type SmtpReply } from "./protocol.js";
import { hasForwardMarker } from "./quotes.js";
import {
  chargeReceived,
  findReceivingDomains,
  type ReceivingDomain,
  receivingRule,
} from "./rcpt.js";
import { type ReceivedRead, readReceived } from "./read.js";
import { spamVerdict } from "./spam.js";
import { allowlisted, senderTrust } from "./trust.js";

export interface IngestDeps {
  db: Db;
  keyring: Keyring;
  isCloud: boolean;
  /**
   * Hands the webhook delivery rows to the queue once their transaction
   * committed. Optional: without it the rows still land and the
   * webhooks.reconcile sweep sends them.
   */
  enqueueWebhookDeliveries?: WebhookEnqueue | undefined;
  now?: (() => Date) | undefined;
  /**
   * Verifies thread tokens and keys received secrets (core deriveInboxKeys).
   * Every server passes it; without it replies thread by message-id only and
   * no received secret is recorded.
   */
  inboxKeys?: InboxKeys | undefined;
  /** clamd's scan (CLAMAV_HOST); omitted, nothing is scanned. */
  scanVirus?: ((raw: Buffer) => Promise<VirusResult>) | undefined;
  /** A scan that could not run; the message is delivered by the other rules. */
  reportScanFailure?: ((reason: string) => void) | undefined;
  /** An inbound judge runs in the worker (ABUSE_JUDGE): without one, mail that would wait for it is delivered. */
  judgeAvailable?: boolean | undefined;
  enqueueScreening?:
    | ((p: { receivedEmailId: string; inboxId: string }) => Promise<void>)
    | undefined;
  enqueueInboxForward?:
    | ((p: { receivedEmailId: string; inboxId: string }) => Promise<void>)
    | undefined;
  /** This instance's MX host: a HELO naming it is forged. */
  mxHost?: string | undefined;
}

/** A team's copy of the message: stored now, or already stored by an earlier attempt. */
export interface StoredReceivedEmail {
  teamId: string;
  id: string;
  duplicate: boolean;
}

/**
 * What /deliver answers. A refusal carries the SMTP reply the MX relays: 5xx
 * is permanent (MX_DELIVER_PERMANENT_STATUS), 4xx temporary
 * (MX_DELIVER_TEMPORARY_STATUS) and the sender retries.
 */
export type IngestResult =
  | { ok: true; stored: StoredReceivedEmail[] }
  | ({ ok: false } & SmtpReply);

/** The refusal for a message over MAX_RECEIVED_MESSAGE_BYTES, wherever it is caught. */
export const MESSAGE_TOO_LARGE: SmtpReply = {
  code: 552,
  enhanced: "5.3.4",
  message: "Message exceeds the maximum size",
};
const NO_RECIPIENT: SmtpReply = {
  code: 554,
  enhanced: "5.1.1",
  message: "No recipient address on this message receives mail here",
};
const ALL_SUSPENDED: SmtpReply = {
  code: 554,
  enhanced: "5.7.1",
  message: "Recipient account is not accepting mail",
};
const OVER_QUOTA: SmtpReply = {
  code: 452,
  enhanced: "4.2.2",
  message: "Recipient account is over its receiving limit, try again later",
};

/** clamd scans in flight per process: each holds a message on the wire for up to its timeout. */
const virusSlot = createSemaphore(2);

/** Thrown inside a team's transaction to roll it back when its allowance is spent. */
class QuotaSpent extends Error {}

interface TeamDelivery {
  domain: ReceivingDomain;
  domainIds: Set<string>;
  recipients: string[];
  /** Recipients that landed in an inbox, one entry per inbox. */
  inboxTargets: { address: string; inbox: InboxTarget }[];
  /** At least one recipient landed without an inbox. */
  catchAll: boolean;
}

/** What every team's copy shares: read once per message. */
interface MessageFacts {
  raw: Buffer;
  envelope: DeliverEnvelope;
  now: Date;
  metadata: ReceivedMetadata;
  rawSha256: string;
  read: ReceivedRead;
  virus: VirusResult | null;
  /** The envelope sender as stored, "" for <>. */
  mailFrom: string;
  forwardedContent: boolean;
}

/**
 * Stores an inbound message the MX accepted, one row per team its envelope
 * reaches, and a membership per inbox it lands in. Recipients are re-checked
 * here (the MX's RCPT answers may be cached): routed domain → team → inbox,
 * and dropped when they reach neither an inbox nor a catch-all domain; each
 * team's row holds only that team's envelope recipients. Idempotent per
 * (team, sha256 of the raw bytes): a retry stores nothing twice, counts
 * nothing twice and emits no second webhook. Recipients a later delivery
 * adds (a sender splitting its recipients over transactions) are merged into
 * the row. When a team's allowance is spent the whole delivery answers 452
 * so the sender retries; teams already stored dedupe on that retry.
 *
 * email.received fires once the row is visible: a catch-all row not held
 * for a virus, or its first delivered membership; mail waiting for the
 * judge or held in quarantine announces itself on delivery or release.
 *
 * The sha256 covers the exact bytes the MX sent: the MX must not prepend
 * anything per attempt (a Received line with a timestamp), or retries stop
 * deduplicating.
 */
export async function ingestReceivedEmail(
  deps: IngestDeps,
  input: { raw: Buffer; envelope: DeliverEnvelope },
): Promise<IngestResult> {
  const now = deps.now?.() ?? new Date();
  if (input.raw.length > MAX_RECEIVED_MESSAGE_BYTES) return { ok: false, ...MESSAGE_TOO_LARGE };

  const recipients = new Map<string, string>();
  for (const recipient of input.envelope.recipients) {
    const parsed = routableAddress(recipient);
    if (parsed) recipients.set(parsed.address, parsed.domain);
  }
  const domains = await findReceivingDomains(deps.db, [...new Set(recipients.values())]);
  const byName = new Map(domains.map((d) => [d.name, d]));
  const targets = await findInboxesForRecipients(deps.db, domains, [...recipients.keys()], now);
  const teams = new Map<string, TeamDelivery>();
  let suspended = false;
  for (const [address, name] of recipients) {
    const domain = byName.get(name);
    if (!domain) continue;
    if (domain.suspendedAt) {
      suspended = true;
      continue;
    }
    const inbox = targets.get(address);
    // A stale RCPT answer: the address has no inbox and its domain no catch-all.
    if (!inbox && !domain.catchAll) continue;
    const delivery = teams.get(domain.teamId) ?? {
      domain,
      domainIds: new Set<string>(),
      recipients: [],
      inboxTargets: [],
      catchAll: false,
    };
    if (domain.domainId) delivery.domainIds.add(domain.domainId);
    delivery.recipients.push(address);
    if (inbox) {
      if (inbox.domainId) delivery.domainIds.add(inbox.domainId);
      if (!delivery.inboxTargets.some((t) => t.inbox.id === inbox.id)) {
        delivery.inboxTargets.push({ address: address.toLowerCase(), inbox });
      }
    } else {
      delivery.catchAll = true;
    }
    teams.set(domain.teamId, delivery);
  }
  if (teams.size === 0) return { ok: false, ...(suspended ? ALL_SUSPENDED : NO_RECIPIENT) };

  const metadata = await parseReceivedMetadata(input.raw);
  let virus: VirusResult | null = null;
  const scan = deps.scanVirus;
  if (scan) {
    virus = await virusSlot(() => scan(input.raw));
    if (virus.verdict === "processing_failed") deps.reportScanFailure?.(virus.reason);
  }
  const from = metadata.from ?? routableAddress(input.envelope.mailFrom)?.address ?? "";
  const read = readReceived({
    subject: metadata.subject,
    html: metadata.html,
    text: metadata.text,
    bodyTruncated: metadata.bodyTruncated,
    fromDomain: from ? from.slice(from.lastIndexOf("@") + 1) : null,
  });
  const facts: MessageFacts = {
    raw: input.raw,
    envelope: input.envelope,
    now,
    metadata,
    rawSha256: sha256Hex(input.raw),
    read,
    virus,
    mailFrom: routableAddress(input.envelope.mailFrom)?.address ?? "",
    forwardedContent:
      metadata.attachments.some((a) => a.contentType === "message/rfc822") ||
      hasForwardMarker(read.extracted.text),
  };
  const stored: StoredReceivedEmail[] = [];
  let quotaSpent = false;
  for (const delivery of teams.values()) {
    const outcome = await storeForTeam(deps, facts, delivery);
    if (outcome) stored.push(outcome);
    else quotaSpent = true;
  }
  return quotaSpent ? { ok: false, ...OVER_QUOTA } : { ok: true, stored };
}

/** One team's row; null when the team's receiving allowance refused it (nothing written). */
async function storeForTeam(
  deps: IngestDeps,
  facts: MessageFacts,
  delivery: TeamDelivery,
): Promise<StoredReceivedEmail | null> {
  const { metadata, envelope, now, read } = facts;
  const teamId = delivery.domain.teamId;
  const id = randomUUID();
  const owner = { teamId, rowId: id };
  const attachments = metadata.attachments.map((a) => ({
    ...a,
    id: receivedAttachmentId(id, a.index),
  }));
  const from = metadata.from ?? routableAddress(envelope.mailFrom)?.address ?? "";
  const memberEmails = await teamMemberEmails(deps.db, teamId);
  const auth = {
    authentication: envelope.auth,
    authDetail: envelope.authDetail ?? null,
    mailFrom: facts.mailFrom,
    from,
    fromFields: metadata.fromFields,
    fromMailboxes: metadata.fromMailboxes,
  };
  // The row's tier: team owners only, no allowlist, no thread proof.
  const rowTier = senderTrust({ ...auth, owners: memberEmails, allowlist: [] });
  const spam = spamVerdict({
    tier: rowTier,
    authentication: envelope.auth,
    helo: envelope.helo,
    mxHost: deps.mxHost,
    recipientDomains: [...new Set(delivery.recipients.map((a) => a.slice(a.lastIndexOf("@") + 1)))],
    mailFrom: facts.mailFrom,
    report: (metadata.automatedHeaders["content-type"] ?? "")
      .toLowerCase()
      .startsWith("multipart/report"),
    hasDate: metadata.hasDate,
    hasMessageId: metadata.messageId !== null,
    from,
    fromName: metadata.fromName,
    replyTo: metadata.replyTo,
    hiddenText: read.hiddenText,
    links: read.links,
    attachmentNames: metadata.attachments.map((a) => a.filename),
  });
  // Sealed and keyed before the transaction: a KMS round-trip must not hold row locks.
  const [raw, sealedAttachments, extracted] = await Promise.all([
    sealReceivedRaw(facts.raw, deps.keyring, owner),
    sealReceivedAttachments(attachments, deps.keyring, owner),
    sealReceivedExtracted(read.extracted, deps.keyring, owner),
  ]);
  const keys = deps.inboxKeys;
  const secrets = keys
    ? read.secrets.map((s) => ({ kind: s.kind, mac: secretMac(keys, teamId, s.value) }))
    : [];
  const r = schema.receivedEmails;
  const after = afterCommit();
  let outcome: StoredReceivedEmail;
  try {
    outcome = await deps.db.transaction(async (raw2) => {
      const tx = raw2 as unknown as Db;
      const [row] = await tx
        .insert(r)
        .values({
          id,
          teamId,
          domainIds: [...delivery.domainIds],
          rawSha256: facts.rawSha256,
          messageId: metadata.messageId ?? `<${id}@received.invalid>`,
          from,
          to: metadata.to,
          cc: metadata.cc,
          bcc: metadata.bcc,
          replyTo: metadata.replyTo,
          receivedFor: delivery.recipients,
          subject: metadata.subject,
          envelope: {
            mailFrom: facts.mailFrom,
            clientIp: envelope.clientIp,
            helo: visibleLine(envelope.helo, 255),
            tls: envelope.tls,
          },
          authentication: envelope.auth,
          authDetail: envelope.authDetail ?? null,
          sizeBytes: facts.raw.length,
          attachmentCount: attachments.length,
          rawCiphertext: raw.ciphertext,
          rawIv: raw.iv,
          rawWrappedDek: raw.wrappedDek,
          rawKeyVersion: raw.keyVersion,
          attachments: sealedAttachments,
          fromName: metadata.fromName,
          inReplyTo: metadata.inReplyTo,
          references: metadata.references,
          fromFields: metadata.fromFields,
          fromMailboxes: metadata.fromMailboxes,
          automated: automatedReason({
            headers: metadata.automatedHeaders,
            mailFrom: facts.mailFrom,
            from,
            subject: metadata.subject,
          }),
          senderTrust: rowTier,
          spamVerdict: spam.verdict,
          spamScore: spam.score,
          spamReasons: spam.reasons,
          virusVerdict: facts.virus?.verdict ?? null,
          virusSignature:
            facts.virus?.verdict === "fail" ? visibleLine(facts.virus.signature, 200) : null,
          hiddenText: read.hiddenText,
          extractedKinds: read.kinds,
          extracted,
          catchAll: delivery.catchAll,
          createdAt: now,
        })
        .onConflictDoNothing({ target: [r.teamId, r.rawSha256] })
        .returning(RECEIVED_EMAIL_META_COLUMNS);
      if (row) {
        const rule = receivingRule(delivery.domain, deps.isCloud, now);
        if (!(await chargeReceived(tx, { teamId, rule, now }))) throw new QuotaSpent();
        if (secrets.length > 0) {
          await tx
            .insert(schema.receivedSecrets)
            .values(
              secrets.map((s) => ({
                teamId,
                mac: s.mac,
                receivedEmailId: id,
                kind: s.kind,
                createdAt: now,
              })),
            )
            .onConflictDoNothing();
        }
        for (const target of delivery.inboxTargets) {
          await admit(tx, deps, { row, target, attachments, facts, memberEmails, after });
        }
        await announceIfVisible(tx, { row, attachments, now, after });
        return { teamId, id, duplicate: false };
      }
      // A retry, or the same message in another SMTP transaction: one row,
      // nothing counted again. Locked, so concurrent deliveries widening it
      // each announce only the recipients they added.
      const [stored] = await tx
        .select(RECEIVED_EMAIL_META_COLUMNS)
        .from(r)
        .where(and(eq(r.teamId, teamId), eq(r.rawSha256, facts.rawSha256)))
        .for("update");
      if (!stored) throw new Error("received_emails conflict row not found");
      const added = delivery.recipients.filter((a) => !stored.receivedFor.includes(a));
      if (added.length === 0) return { teamId, id: stored.id, duplicate: true };
      const [widened] = await tx
        .update(r)
        .set({
          receivedFor: [...stored.receivedFor, ...added],
          domainIds: [...new Set([...stored.domainIds, ...delivery.domainIds])],
          catchAll: stored.catchAll || delivery.catchAll,
        })
        .where(eq(r.id, stored.id))
        .returning(RECEIVED_EMAIL_META_COLUMNS);
      if (!widened) throw new Error("received_emails update returned no row");
      // Same bytes, same parse: the stored row's attachment ids, without opening its seal.
      const files = metadata.attachments.map((a) => ({
        ...a,
        id: receivedAttachmentId(stored.id, a.index),
      }));
      const lowered = new Set(added.map((a) => a.toLowerCase()));
      for (const target of delivery.inboxTargets) {
        if (lowered.has(target.address)) {
          await admit(tx, deps, {
            row: widened,
            target,
            attachments: files,
            facts,
            memberEmails,
            after,
          });
        }
      }
      // A row announced before names only what this delivery added; one
      // becoming visible now is announced whole.
      if (stored.announcedAt) {
        await announceAdded(tx, { row: widened, added, files, now, after });
      } else {
        await announceIfVisible(tx, { row: widened, attachments: files, now, after });
      }
      return { teamId, id: stored.id, duplicate: true };
    });
  } catch (err) {
    if (err instanceof QuotaSpent) return null;
    throw err;
  }
  await runAfterCommit(deps, after);
  return outcome;
}

/** email.received for recipients added to an announced row, naming only them. */
async function announceAdded(
  tx: Db,
  p: {
    row: ReceivedEmailMeta;
    added: string[];
    files: ReceivedAttachment[];
    now: Date;
    after: AfterCommit;
  },
): Promise<void> {
  const m = schema.receivedEmailInboxes;
  const inboxIds = (
    await tx
      .select({ inboxId: m.inboxId })
      .from(m)
      .where(and(eq(m.receivedEmailId, p.row.id), isNotNull(m.deliveredAt)))
  ).map((x) => x.inboxId);
  await enqueueTeamWebhookEvents(tx, {
    teamId: p.row.teamId,
    events: [
      {
        type: "email.received",
        occurredAt: p.now,
        data: receivedEmailEventData({ ...p.row, receivedFor: p.added }, p.files),
        inboxIds,
      },
    ],
    enqueue: async (rows) => {
      p.after.deliveries.push(...rows);
    },
  });
}

/**
 * One recipient's inbox: the thread it continues (token, our SES id, then a
 * message-id it quotes) or a new one, the sender's tier under this inbox's
 * owners and allowlist, then deliver, spam, hold for the judge or quarantine.
 */
async function admit(
  tx: Db,
  deps: IngestDeps,
  p: {
    row: ReceivedEmailMeta;
    target: { address: string; inbox: InboxTarget };
    attachments: ReceivedAttachment[];
    facts: MessageFacts;
    memberEmails: string[];
    after: AfterCommit;
  },
): Promise<void> {
  const { row, facts } = p;
  const { inbox } = p.target;
  const now = facts.now;
  const m = schema.receivedEmailInboxes;
  const [member] = await tx
    .select({ inboxId: m.inboxId })
    .from(m)
    .where(and(eq(m.receivedEmailId, row.id), eq(m.inboxId, inbox.id)));
  if (member) return;
  const resolved = await resolveThread(tx, deps.inboxKeys, {
    teamId: row.teamId,
    inboxId: inbox.id,
    refs: [...(row.inReplyTo ? [row.inReplyTo] : []), ...row.references],
  });
  const owners = [...p.memberEmails, ...inbox.safety.owner_addresses];
  const tier = senderTrust({
    authentication: row.authentication,
    authDetail: row.authDetail,
    mailFrom: facts.mailFrom,
    from: row.from,
    fromFields: row.fromFields,
    fromMailboxes: row.fromMailboxes,
    owners,
    allowlist: inbox.safety.allowlist,
    thread: resolved
      ? { proven: resolved.proof !== null, participants: resolved.participants }
      : null,
  });
  const decision = decideScreening({
    kind: inbox.kind,
    safety: inbox.safety,
    tier,
    listed:
      owners.includes(row.from.toLowerCase()) || allowlisted(row.from, inbox.safety.allowlist),
    spam: row.spamVerdict,
    virus: row.virusVerdict,
    judgeAvailable: deps.judgeAvailable ?? false,
    forwardedContent: facts.forwardedContent,
  });
  let threadId = resolved?.threadId;
  if (!threadId) {
    const [thread] = await tx
      .insert(schema.inboxThreads)
      .values({
        teamId: row.teamId,
        inboxId: inbox.id,
        // markDelivered names it after the first message delivered into it,
        // so a held message's subject never reaches an agent through the thread.
        subject: "",
        folder: decision.action === "spam" ? "spam" : "inbox",
        lastMessageAt: now,
        createdAt: now,
      })
      .returning({ id: schema.inboxThreads.id });
    if (!thread) throw new Error("inbox thread insert returned no row");
    threadId = thread.id;
  }
  await tx.insert(m).values({
    receivedEmailId: row.id,
    inboxId: inbox.id,
    teamId: row.teamId,
    threadId,
    address: p.target.address,
    senderTrust: tier,
    threadProof: resolved?.proof ?? null,
    verdict: "pending",
    createdAt: now,
  });
  await bumpInboxReceived(tx, inbox.id, now);
  const key = { receivedEmailId: row.id, inboxId: inbox.id };
  if (decision.action === "judge") {
    p.after.screens.push(key);
  } else if (decision.action === "quarantine") {
    await markQuarantined(tx, {
      row,
      key,
      reason: decision.reason ?? "unscreened",
      now,
      after: p.after,
    });
  } else {
    await markDelivered(tx, {
      row,
      key,
      from: "pending",
      set: { verdict: decision.verdict },
      spam: decision.action === "spam",
      forwardTo: inbox.safety.forward_to,
      attachments: p.attachments,
      now,
      after: p.after,
    });
  }
}
