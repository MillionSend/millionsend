import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { Keyring } from "../crypto/keyring.js";
import {
  openReceivedExtracted,
  RECEIVED_EMAIL_META_COLUMNS,
  type ReceivedEmailMeta,
} from "../receiving/message.js";
import { replyWithSignature } from "../receiving/read.js";
import { endpointsTake, type WebhookEventType } from "../webhooks.js";
import type { InboxActor } from "./activity.js";
import { keysetRows } from "./inbox-common.js";
import { releaseRights, screensOnRelease } from "./release-rules.js";
import type {
  InboxKind,
  ListQuery,
  QuarantinedItemWire,
  QuarantineReason,
  SenderTrust,
} from "./types.js";
import { hiddenTextRemoved } from "./wire.js";

/**
 * Held mail, newest first: an inbox's quarantined memberships, or with
 * inboxId null the virus-held catch-all rows, which belong to no inbox.
 * Metadata only; `from` is the bare address.
 */
export async function listQuarantined(
  db: Db,
  p: { teamId: string; inboxId: string | null; query: ListQuery },
): Promise<{ data: QuarantinedItemWire[]; hasMore: boolean } | "bad_cursor"> {
  const r = schema.receivedEmails;
  if (p.inboxId === null) {
    const scope = and(
      eq(r.teamId, p.teamId),
      eq(r.catchAll, true),
      eq(r.virusVerdict, "fail"),
      isNull(r.releasedAt),
    );
    const page = await keysetRows({
      query: p.query,
      key: r.createdAt,
      id: r.id,
      newestFirst: true,
      cursorExists: async (id) =>
        (
          await db
            .select({ id: r.id })
            .from(r)
            .where(and(eq(r.id, id), scope))
        ).length > 0,
      cursorKey: (id) => sql`(select ${r.createdAt} from ${r} where ${r.id} = ${id}::uuid)`,
      load: (where, orderBy, take) =>
        db
          .select({
            id: r.id,
            from: r.from,
            subject: r.subject,
            createdAt: r.createdAt,
            senderTrust: r.senderTrust,
            virusSignature: r.virusSignature,
          })
          .from(r)
          .where(and(scope, where))
          .orderBy(...orderBy)
          .limit(take),
    });
    if (page === "bad_cursor") return page;
    return {
      data: page.rows.map((row) => ({
        id: row.id,
        thread_id: null,
        from: row.from,
        subject: row.subject === "" ? null : row.subject,
        received_at: row.createdAt.toISOString(),
        quarantine_reason: "virus" as const,
        sender_trust: row.senderTrust,
        injection_score: null,
        phishing_score: null,
        virus_signature: row.virusSignature,
      })),
      hasMore: page.hasMore,
    };
  }
  const inboxId = p.inboxId;
  const m = schema.receivedEmailInboxes;
  const scope = and(
    eq(m.inboxId, inboxId),
    eq(m.teamId, p.teamId),
    isNotNull(m.quarantinedAt),
    isNull(m.releasedAt),
  );
  const page = await keysetRows({
    query: p.query,
    key: m.quarantinedAt,
    id: m.receivedEmailId,
    newestFirst: true,
    cursorExists: async (id) =>
      (
        await db
          .select({ id: m.receivedEmailId })
          .from(m)
          .where(and(eq(m.receivedEmailId, id), scope))
      ).length > 0,
    cursorKey: (id) =>
      sql`(select ${m.quarantinedAt} from ${m} where ${m.receivedEmailId} = ${id}::uuid and ${m.inboxId} = ${inboxId}::uuid)`,
    load: (where, orderBy, take) =>
      db
        .select({
          id: m.receivedEmailId,
          threadId: m.threadId,
          reason: m.quarantineReason,
          senderTrust: m.senderTrust,
          injectionScore: m.injectionScore,
          phishingScore: m.phishingScore,
          from: r.from,
          subject: r.subject,
          createdAt: r.createdAt,
          virusSignature: r.virusSignature,
        })
        .from(m)
        .innerJoin(r, eq(r.id, m.receivedEmailId))
        .where(and(scope, where))
        .orderBy(...orderBy)
        .limit(take),
  });
  if (page === "bad_cursor") return page;
  return {
    data: page.rows.map((row) => ({
      id: row.id,
      thread_id: row.threadId,
      from: row.from,
      subject: row.subject === "" ? null : row.subject,
      received_at: row.createdAt.toISOString(),
      // A held membership always has its reason; unscreened covers a row written without one.
      quarantine_reason: row.reason ?? "unscreened",
      sender_trust: row.senderTrust,
      injection_score: row.injectionScore,
      phishing_score: row.phishingScore,
      virus_signature: row.virusSignature,
    })),
    hasMore: page.hasMore,
  };
}

/** What a person sees before releasing one held message. */
export interface ReleasePreview {
  subject: string | null;
  from: string;
  fromName: string | null;
  inboxAddress: string;
  inboxKind: InboxKind;
  reason: QuarantineReason;
  injectionScore: number | null;
  phishingScore: number | null;
  /** The judge's reason keys. */
  reasons: string[];
  hiddenTextRemoved: boolean;
  senderTrust: SenderTrust;
  virusSignature: string | null;
  /** The cleaned read a person sees: reply, signature, quoted history; null when withheld or gone. */
  text: string | null;
  /** The read pipeline cut the text at its caps. */
  textTruncated: boolean;
  /** This person may also trust the sender (releaseRights). */
  trustOffered: boolean;
  /** An owner or admin could trust the sender; this person can't. */
  trustNeedsAdmin: boolean;
  /** What trusting the sender changes beyond letting its mail in. */
  trustEffects: { sendWithoutApproval: boolean; codesExempt: boolean };
  /** What a release sets off. */
  releaseEffects: { replyWithoutApproval: boolean; webhooks: boolean; forwards: boolean };
  /** The judge reads it before it is released. */
  rescreenOnRelease: boolean;
}

/** What a release can fire in an inbox: markDelivered's events, then the row's announcement. */
const RELEASE_EVENTS: readonly WebhookEventType[] = [
  "inbox.thread.folder.updated",
  "inbox.thread.created",
  "inbox.email.received",
  "email.received",
];

async function reviewText(
  row: ReceivedEmailMeta & { extracted: string | null },
  keyring: Keyring,
): Promise<Pick<ReleasePreview, "text" | "textTruncated">> {
  try {
    const read = await openReceivedExtracted(row, keyring);
    if (!read) return { text: null, textTruncated: false };
    const text = [replyWithSignature(read), read.quoted].filter(Boolean).join("\n\n");
    return { text: text || null, textTruncated: read.flags.includes("truncated") };
  } catch {
    // Undecryptable (corrupt, unknown key version): reviewed without its text.
    return { text: null, textTruncated: false };
  }
}

/**
 * The release dialog's facts about one held message: why it was held, what
 * a release would set off in its inbox, its text as a person reads it, and
 * what this person may do. With inboxId null, a catch-all row held for a
 * virus, which belongs to no inbox: its release only announces it.
 */
export async function releasePreview(
  db: Db,
  keyring: Keyring,
  p: {
    teamId: string;
    inboxId: string | null;
    receivedEmailId: string;
    actor: InboxActor;
    /** The person is an owner or admin. */
    admin: boolean;
    /** A judge runs on this instance (ABUSE_JUDGE). */
    judgeConfigured: boolean;
    /** False under a support view, which reads the envelope only. */
    withText: boolean;
  },
): Promise<ReleasePreview | "not_found" | "not_quarantined"> {
  const r = schema.receivedEmails;
  const [row] = await db
    .select({ ...RECEIVED_EMAIL_META_COLUMNS, extracted: r.extracted })
    .from(r)
    .where(and(eq(r.id, p.receivedEmailId), eq(r.teamId, p.teamId)));
  if (!row) return "not_found";
  let hold: Pick<
    ReleasePreview,
    | "inboxAddress"
    | "inboxKind"
    | "reason"
    | "injectionScore"
    | "phishingScore"
    | "reasons"
    | "senderTrust"
    | "trustEffects"
    | "releaseEffects"
    | "rescreenOnRelease"
  >;
  if (p.inboxId === null) {
    if (!row.catchAll || row.virusVerdict !== "fail") return "not_found";
    if (row.releasedAt) return "not_quarantined";
    hold = {
      inboxAddress: row.receivedFor.join(", "),
      // Team keys and MCP list a released catch-all row: an agent may act on it.
      inboxKind: "agent",
      reason: "virus",
      injectionScore: null,
      phishingScore: null,
      reasons: [],
      senderTrust: row.senderTrust,
      trustEffects: { sendWithoutApproval: false, codesExempt: false },
      releaseEffects: {
        replyWithoutApproval: false,
        webhooks: await endpointsTake(db, {
          teamId: p.teamId,
          types: ["email.received"],
          inboxIds: [],
        }),
        forwards: false,
      },
      rescreenOnRelease: false,
    };
  } else {
    const m = schema.receivedEmailInboxes;
    const i = schema.inboxes;
    const [held] = await db
      .select({
        verdict: m.verdict,
        reason: m.quarantineReason,
        senderTrust: m.senderTrust,
        reasons: m.reasons,
        injectionScore: m.injectionScore,
        phishingScore: m.phishingScore,
        kind: i.kind,
        address: i.emailAddress,
        domainId: i.domainId,
        safety: i.safety,
      })
      .from(m)
      .innerJoin(i, eq(i.id, m.inboxId))
      .where(
        and(
          eq(m.receivedEmailId, p.receivedEmailId),
          eq(m.inboxId, p.inboxId),
          eq(m.teamId, p.teamId),
        ),
      );
    if (!held) return "not_found";
    if (held.verdict !== "quarantined") return "not_quarantined";
    const reason = held.reason ?? "unscreened";
    const { safety } = held;
    const agent = held.kind === "agent";
    const shared = held.domainId === null;
    const unproven = held.senderTrust === "unauthenticated" || held.senderTrust === "failed";
    hold = {
      inboxAddress: held.address,
      inboxKind: held.kind,
      reason,
      injectionScore: held.injectionScore,
      phishingScore: held.phishingScore,
      reasons: held.reasons,
      senderTrust: held.senderTrust,
      trustEffects: {
        // The allowlist steers sends from an agent inbox on the team's own domain only.
        sendWithoutApproval: agent && !shared && safety.send_policy === "allowlist",
        codesExempt: agent && !shared && safety.private_codes,
      },
      releaseEffects: {
        // Its sender joins the thread's people, whom replies reach unattended;
        // on the shared domain only once authenticated.
        replyWithoutApproval: agent && !safety.require_approval && !(shared && unproven),
        webhooks: await endpointsTake(db, {
          teamId: p.teamId,
          types: RELEASE_EVENTS,
          inboxIds: [p.inboxId],
        }),
        // Mail carrying malware is never forwarded.
        forwards: safety.forward_to.length > 0 && row.virusVerdict !== "fail",
      },
      rescreenOnRelease:
        p.judgeConfigured &&
        screensOnRelease({ reason, kind: held.kind, screening: safety.screening }),
    };
  }
  const rights = (admin: boolean) =>
    releaseRights({ reason: hold.reason, senderTrust: hold.senderTrust, actor: p.actor, admin });
  const trustOffered = rights(p.admin).trust;
  return {
    subject: row.subject === "" ? null : row.subject,
    from: row.from,
    fromName: row.fromName === "" ? null : row.fromName,
    hiddenTextRemoved: hiddenTextRemoved(row.hiddenText),
    virusSignature: row.virusSignature,
    ...(p.withText ? await reviewText(row, keyring) : { text: null, textTruncated: false }),
    ...hold,
    trustOffered,
    trustNeedsAdmin: !trustOffered && rights(true).trust,
  };
}
