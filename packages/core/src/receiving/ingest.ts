import { randomUUID } from "node:crypto";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { sql } from "drizzle-orm";
import type { Keyring } from "../crypto/keyring.js";
import { visibleLine } from "../customer-text.js";
import { sha256Hex } from "../hash.js";
import { routableAddress } from "../sender-address.js";
import {
  enqueueTeamWebhookEvents,
  type QueuedWebhookDelivery,
  type WebhookEnqueue,
} from "../webhooks.js";
import {
  parseReceivedMetadata,
  type ReceivedMetadata,
  receivedAttachmentId,
  receivedEmailEventData,
  sealReceivedAttachments,
  sealReceivedRaw,
} from "./message.js";
import { type DeliverEnvelope, MAX_RECEIVED_MESSAGE_BYTES, type SmtpReply } from "./protocol.js";
import {
  chargeReceived,
  findReceivingDomains,
  type ReceivingDomain,
  receivingRule,
} from "./rcpt.js";

export interface IngestDeps {
  db: Db;
  keyring: Keyring;
  isCloud: boolean;
  /**
   * Hands the email.received delivery rows to the webhook queue once their
   * transaction committed. Optional: without it the rows still land and the
   * webhooks.reconcile sweep sends them.
   */
  enqueueWebhookDeliveries?: WebhookEnqueue | undefined;
  now?: (() => Date) | undefined;
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

/** Thrown inside a team's transaction to roll it back when its allowance is spent. */
class QuotaSpent extends Error {}

interface TeamDelivery {
  domain: ReceivingDomain;
  domainIds: Set<string>;
  recipients: string[];
}

/**
 * Stores an inbound message the MX accepted, one row per team its envelope
 * reaches. Recipients are re-checked here (the MX's RCPT answers may be
 * cached), routed by domain to team, and each team's row holds only that
 * team's envelope recipients. Idempotent per (team, sha256 of the raw
 * bytes): a retry stores nothing twice, counts nothing twice and emits no
 * second webhook, and recipients a retry adds are merged into the row. When a
 * team's allowance is spent the whole delivery answers 452 so the sender
 * retries; teams already stored dedupe on that retry.
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
  const teams = new Map<string, TeamDelivery>();
  let suspended = false;
  for (const [address, name] of recipients) {
    const domain = byName.get(name);
    if (!domain) continue;
    if (domain.suspendedAt) {
      suspended = true;
      continue;
    }
    const delivery = teams.get(domain.teamId) ?? {
      domain,
      domainIds: new Set<string>(),
      recipients: [],
    };
    delivery.domainIds.add(domain.domainId);
    delivery.recipients.push(address);
    teams.set(domain.teamId, delivery);
  }
  if (teams.size === 0) return { ok: false, ...(suspended ? ALL_SUSPENDED : NO_RECIPIENT) };

  const metadata = await parseReceivedMetadata(input.raw);
  const rawSha256 = sha256Hex(input.raw);
  const stored: StoredReceivedEmail[] = [];
  let quotaSpent = false;
  for (const delivery of teams.values()) {
    const outcome = await storeForTeam(deps, { ...input, now, metadata, rawSha256, delivery });
    if (outcome) stored.push(outcome);
    else quotaSpent = true;
  }
  return quotaSpent ? { ok: false, ...OVER_QUOTA } : { ok: true, stored };
}

/** One team's row; null when the team's receiving allowance refused it (nothing written). */
async function storeForTeam(
  deps: IngestDeps,
  input: {
    raw: Buffer;
    envelope: DeliverEnvelope;
    now: Date;
    metadata: ReceivedMetadata;
    rawSha256: string;
    delivery: TeamDelivery;
  },
): Promise<StoredReceivedEmail | null> {
  const { metadata, delivery, envelope } = input;
  const teamId = delivery.domain.teamId;
  const id = randomUUID();
  const owner = { teamId, rowId: id };
  const attachments = metadata.attachments.map((a) => ({
    ...a,
    id: receivedAttachmentId(id, a.index),
  }));
  // Sealed before the transaction: a KMS round-trip must not hold row locks.
  const [raw, sealedAttachments] = await Promise.all([
    sealReceivedRaw(input.raw, deps.keyring, owner),
    sealReceivedAttachments(attachments, deps.keyring, owner),
  ]);
  const r = schema.receivedEmails;
  const deliveries: QueuedWebhookDelivery[] = [];
  let outcome: StoredReceivedEmail;
  try {
    outcome = await deps.db.transaction(async (tx) => {
      const db = tx as unknown as Db;
      const [row] = await db
        .insert(r)
        .values({
          id,
          teamId,
          domainIds: [...delivery.domainIds],
          rawSha256: input.rawSha256,
          messageId: metadata.messageId ?? `<${id}@received.invalid>`,
          from: metadata.from ?? routableAddress(envelope.mailFrom)?.address ?? "",
          to: metadata.to,
          cc: metadata.cc,
          bcc: metadata.bcc,
          replyTo: metadata.replyTo,
          receivedFor: delivery.recipients,
          subject: metadata.subject,
          envelope: {
            mailFrom: routableAddress(envelope.mailFrom)?.address ?? "",
            clientIp: envelope.clientIp,
            helo: visibleLine(envelope.helo, 255),
            tls: envelope.tls,
          },
          authentication: envelope.auth,
          sizeBytes: input.raw.length,
          attachmentCount: attachments.length,
          rawCiphertext: raw.ciphertext,
          rawIv: raw.iv,
          rawWrappedDek: raw.wrappedDek,
          rawKeyVersion: raw.keyVersion,
          attachments: sealedAttachments,
        })
        .onConflictDoUpdate({
          target: [r.teamId, r.rawSha256],
          // A retry, or the same message in another SMTP transaction to more
          // of this team's addresses: keep one row and widen its recipients.
          set: {
            receivedFor: sql`(select jsonb_agg(distinct x) from jsonb_array_elements_text(${r.receivedFor} || excluded.received_for) as x)`,
            domainIds: sql`(select array_agg(distinct x) from unnest(${r.domainIds} || excluded.domain_ids) as x)`,
          },
        })
        .returning();
      if (!row) throw new Error("received_emails insert returned no row");
      if (row.id !== id) return { teamId, id: row.id, duplicate: true };
      const rule = receivingRule(delivery.domain, deps.isCloud, input.now);
      if (!(await chargeReceived(db, { teamId, rule, now: input.now }))) throw new QuotaSpent();
      await enqueueTeamWebhookEvents(db, {
        teamId,
        events: [
          {
            type: "email.received",
            occurredAt: row.createdAt,
            data: receivedEmailEventData(row, attachments),
          },
        ],
        enqueue: async (rows) => {
          deliveries.push(...rows);
        },
      });
      return { teamId, id, duplicate: false };
    });
  } catch (err) {
    if (err instanceof QuotaSpent) return null;
    throw err;
  }
  if (deliveries.length > 0 && deps.enqueueWebhookDeliveries) {
    // The rows are committed; a queue hiccup only delays them to the sweep.
    await deps.enqueueWebhookDeliveries(deliveries).catch((err: unknown) => {
      console.warn("receiving: webhook enqueue failed; the reconcile sweep will send", err);
    });
  }
  return outcome;
}
