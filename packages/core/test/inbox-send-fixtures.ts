import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { createTransport, type SendMailOptions } from "nodemailer";
import { EnvKeyring } from "../src/crypto/keyring.js";
import { msgIds } from "../src/inboxes/compose.js";
import { deriveInboxKeys, type InboxKeys } from "../src/inboxes/keys.js";
import { defaultSafety, type InboxSafety } from "../src/inboxes/safety.js";
import type { InboxSendDeps } from "../src/inboxes/send.js";
import {
  parseReceivedMetadata,
  receivedAttachmentId,
  sealReceivedAttachments,
  sealReceivedRaw,
} from "../src/receiving/message.js";
import { QUOTA_COLUMNS } from "../src/team-plan.js";

/** A team with an owner login, a verified receiving domain and the send deps an inbox send needs. */
export interface World {
  db: Db;
  teamId: string;
  domainId: string;
  domain: string;
  owner: string;
  sharedDomain: string;
  keys: InboxKeys;
  deps: InboxSendDeps;
  enqueuedEmails: string[];
  enqueuedHooks: string[];
}

const transport = createTransport({ streamTransport: true, buffer: true });

export const mime = async (options: SendMailOptions): Promise<Buffer> =>
  (await transport.sendMail(options)).message as Buffer;

export async function seedWorld(db: Db, slug: string): Promise<World> {
  const teamId = await createTeam(db, slug);
  await db.update(schema.teams).set({ plan: "pro" }).where(eq(schema.teams.id, teamId));
  const domain = `${slug}.acme.test`;
  const [d] = await db
    .insert(schema.domains)
    .values({
      teamId,
      name: domain,
      region: "us-east-1",
      status: "verified",
      receivingEnabled: true,
    })
    .returning({ id: schema.domains.id });
  if (!d) throw new Error("domain insert failed");
  const owner = `owner@${slug}.example`;
  const userId = randomUUID();
  await db.insert(schema.user).values({ id: userId, name: "Owner", email: owner });
  await db.insert(schema.teamMembers).values({ teamId, userId, role: "owner" });
  const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
  const keys = deriveInboxKeys(randomBytes(32));
  const enqueuedEmails: string[] = [];
  const enqueuedHooks: string[] = [];
  const sharedDomain = "agents.example";
  return {
    db,
    teamId,
    domainId: d.id,
    domain,
    owner,
    sharedDomain,
    keys,
    enqueuedEmails,
    enqueuedHooks,
    deps: {
      db,
      keyring,
      isCloud: true,
      enqueueEmailSend: async (id) => {
        enqueuedEmails.push(id);
      },
      enqueueWebhookDeliveries: async (rows) => {
        enqueuedHooks.push(...rows.map((r) => r.id));
      },
      inboxKeys: keys,
      sharedInboxDomain: sharedDomain,
    },
  };
}

export async function billing(w: World) {
  const [row] = await w.db
    .select(QUOTA_COLUMNS)
    .from(schema.teams)
    .where(eq(schema.teams.id, w.teamId));
  if (!row) throw new Error("no team");
  return row;
}

export type InboxRow = typeof schema.inboxes.$inferSelect;

export async function addInbox(
  w: World,
  opts: {
    local: string;
    kind?: "agent" | "human";
    shared?: boolean;
    safety?: Partial<InboxSafety>;
    fromName?: string;
    firstSentAt?: Date;
  },
): Promise<InboxRow> {
  const kind = opts.kind ?? "agent";
  const shared = opts.shared ?? false;
  let sharedDomainId: string | null = null;
  let domain = w.domain;
  if (shared) {
    domain = `${w.teamId.slice(0, 8)}.${w.sharedDomain}`;
    const [existing] = await w.db
      .select({ id: schema.sharedInboxDomains.id })
      .from(schema.sharedInboxDomains)
      .where(eq(schema.sharedInboxDomains.teamId, w.teamId));
    sharedDomainId =
      existing?.id ??
      (
        await w.db
          .insert(schema.sharedInboxDomains)
          .values({ teamId: w.teamId, name: domain })
          .returning({ id: schema.sharedInboxDomains.id })
      )[0]?.id ??
      null;
  }
  const [row] = await w.db
    .insert(schema.inboxes)
    .values({
      teamId: w.teamId,
      kind,
      emailAddress: `${opts.local}@${domain}`,
      localPart: opts.local,
      domainId: shared ? null : w.domainId,
      sharedDomainId,
      name: opts.local,
      fromName: opts.fromName ?? null,
      safety: { ...defaultSafety(kind, shared), ...opts.safety },
      firstSentAt: opts.firstSentAt ?? null,
    })
    .returning();
  if (!row) throw new Error("inbox insert failed");
  return row;
}

export async function addThread(w: World, inboxId: string, subject = "Question"): Promise<string> {
  const [row] = await w.db
    .insert(schema.inboxThreads)
    .values({ teamId: w.teamId, inboxId, subject })
    .returning({ id: schema.inboxThreads.id });
  if (!row) throw new Error("thread insert failed");
  return row.id;
}

/** A received message in an inbox's thread, as ingest stores it. */
export async function receive(
  w: World,
  opts: {
    inbox: InboxRow;
    threadId: string;
    message?: SendMailOptions;
    senderTrust?: (typeof schema.senderTrustEnum.enumValues)[number];
    verdict?: (typeof schema.inboxScreeningVerdictEnum.enumValues)[number];
    automated?: string | null;
    extractedKinds?: ("code" | "link")[];
    virusVerdict?: "pass" | "fail" | null;
  },
): Promise<{ id: string; messageId: string }> {
  const raw = await mime({
    from: '"Ada Lovelace" <ada@sender.example>',
    to: opts.inbox.emailAddress,
    subject: "Question",
    text: "Hello there",
    html: "<p>Hello there</p>",
    messageId: `<${randomUUID()}@sender.example>`,
    ...opts.message,
  });
  const metadata = await parseReceivedMetadata(raw);
  const id = randomUUID();
  const owner = { teamId: w.teamId, rowId: id };
  const sealed = await sealReceivedRaw(raw, w.deps.keyring, owner);
  const attachments = metadata.attachments.map((a) => ({
    ...a,
    id: receivedAttachmentId(id, a.index),
  }));
  const verdict = opts.verdict ?? "clean";
  const delivered = verdict === "clean" || verdict === "suspicious" || verdict === "released";
  const messageId = metadata.messageId ?? `<${id}@received.invalid>`;
  await w.db.insert(schema.receivedEmails).values({
    id,
    teamId: w.teamId,
    domainIds: opts.inbox.domainId ? [opts.inbox.domainId] : [],
    rawSha256: createHash("sha256").update(raw).digest("hex"),
    messageId,
    from: metadata.from ?? "",
    fromName: "Ada Lovelace",
    to: metadata.to,
    cc: metadata.cc,
    replyTo: metadata.replyTo,
    receivedFor: [opts.inbox.emailAddress],
    subject: metadata.subject,
    envelope: { mailFrom: "bounce@sender.example", clientIp: "192.0.2.1", helo: "mx", tls: null },
    authentication: { spf: "pass", dkim: "pass", dmarc: "pass", arc: "none" },
    sizeBytes: raw.length,
    attachmentCount: attachments.length,
    rawCiphertext: sealed.ciphertext,
    rawIv: sealed.iv,
    rawWrappedDek: sealed.wrappedDek,
    rawKeyVersion: sealed.keyVersion,
    attachments: await sealReceivedAttachments(attachments, w.deps.keyring, owner),
    inReplyTo: msgIds(opts.message?.inReplyTo)[0] ?? null,
    references: msgIds(opts.message?.references),
    automated: opts.automated ?? null,
    senderTrust: opts.senderTrust ?? "external",
    extractedKinds: opts.extractedKinds ?? [],
    virusVerdict: opts.virusVerdict ?? null,
    catchAll: false,
    announcedAt: new Date(),
  });
  await w.db.insert(schema.receivedEmailInboxes).values({
    receivedEmailId: id,
    inboxId: opts.inbox.id,
    teamId: w.teamId,
    threadId: opts.threadId,
    address: opts.inbox.emailAddress,
    senderTrust: opts.senderTrust ?? "external",
    verdict,
    quarantineReason: verdict === "quarantined" ? "injection" : null,
    deliveredAt: delivered ? new Date() : null,
    quarantinedAt: verdict === "quarantined" ? new Date() : null,
  });
  return { id, messageId };
}

/** A team past the content monitor's new tier, where send_policy "open" stands. */
export async function establish(w: World): Promise<void> {
  await w.db
    .insert(schema.teamMonitor)
    .values({
      teamId: w.teamId,
      sentTotal: 100_000,
      firstSendAt: new Date(Date.now() - 200 * 86_400_000),
    })
    .onConflictDoNothing();
}
