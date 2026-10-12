import { randomUUID } from "node:crypto";
import type { Db } from "@millionsend/db";
import { keysetCursorWhere, schema } from "@millionsend/db";
import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { recordAudit } from "../audit.js";
import { decryptPayload, type EmailAttachment, encryptPayload } from "../crypto/envelope.js";
import type { Keyring } from "../crypto/keyring.js";
import { isUniqueViolation } from "../driver-result.js";
import type { QuotaTeamRow } from "../plans.js";
import {
  enqueueTeamWebhookEvents,
  type TeamWebhookEvent,
  type WebhookEnqueue,
} from "../webhooks.js";
import {
  canApprove,
  encodeInboxActor,
  type InboxActor,
  isAgentActor,
  recordInboxActivity,
  webhookSource,
} from "./activity.js";
import { addressKey, forwardSubject, replySubject } from "./compose.js";
import { draftDeletedEvent, draftEvent, draftSentEvent } from "./events.js";
import { DRAFT_APPROVAL_TTL, findLiveInbox, RECIPIENTS_PER_SEND_MAX } from "./limits.js";
import {
  deferredEnqueue,
  dispatchSend,
  forwardFiles,
  type HoldSpec,
  type InboxSendDeps,
  inboxFrom,
  inboxSendDomain,
  isOutcome,
  loadThreadTarget,
  mailboxes,
  type PreparedSend,
  refused,
  type SendOutcome,
  subjectProblem,
  targetParentHeaders,
  untrustedReplyTos,
  withIdempotency,
} from "./send.js";
import { getThread } from "./threads.js";
import {
  type DraftListItemWire,
  type DraftStatus,
  type DraftWire,
  EMAIL_QUARANTINED_MESSAGE,
  INBOX_NOT_FOUND_MESSAGE,
  type InboxError,
  type ListQuery,
  type ThreadSummaryWire,
} from "./types.js";
import { draftListItemWire, draftWire } from "./wire.js";

type DraftRow = typeof schema.inboxDrafts.$inferSelect;

/** What a draft's sealed body holds: the parts, and how a held forward carries its original. */
interface DraftBody {
  html: string | null;
  text: string | null;
  forwardMode?: "attachment" | undefined;
}

const t = schema.inboxDrafts;
const UNSENT: DraftStatus[] = ["draft", "pending_approval"];

const fail = (status: InboxError["status"], name: string, message: string) => ({
  ok: false as const,
  error: { status, name, message },
});
const draftNotFound = () => fail(404, "not_found", "Draft not found.");
const invalid = (message: string) => fail(422, "validation_error", message);

/** 409s keep Resend's validation_error name: its own for them is undocumented. */
function finished(row: DraftRow): { ok: false; error: InboxError } | null {
  if (row.status === "sent") return fail(409, "validation_error", "This draft was already sent");
  if (row.status === "rejected") return fail(409, "validation_error", "This draft was rejected");
  if (row.status === "expired")
    return fail(409, "validation_error", "This draft expired unapproved");
  return null;
}

async function sealBody(keyring: Keyring, teamId: string, rowId: string, body: DraftBody) {
  return encryptPayload(Buffer.from(JSON.stringify(body), "utf8"), keyring, {
    teamId,
    rowId,
    kind: "inbox_draft",
  });
}

/** The sealed body, or null once the content purge emptied it. */
async function openBody(keyring: Keyring, row: DraftRow): Promise<DraftBody | null> {
  if (!row.bodyCiphertext || !row.bodyIv || !row.bodyWrappedDek || row.bodyKeyVersion === null) {
    return null;
  }
  const plain = await decryptPayload(
    {
      ciphertext: row.bodyCiphertext,
      iv: row.bodyIv,
      wrappedDek: row.bodyWrappedDek,
      keyVersion: row.bodyKeyVersion,
    },
    keyring,
    { teamId: row.teamId, rowId: row.id, kind: "inbox_draft" },
  );
  return JSON.parse(plain.toString("utf8")) as DraftBody;
}

const bodyColumns = (sealed: Awaited<ReturnType<typeof sealBody>>) => ({
  bodyCiphertext: sealed.ciphertext,
  bodyIv: sealed.iv,
  bodyWrappedDek: sealed.wrappedDek,
  bodyKeyVersion: sealed.keyVersion,
  bodyPurgedAt: null,
});

const wireOf = (row: DraftRow, body: DraftBody | null): DraftWire =>
  draftWire(row, { html: body?.html ?? null, text: body?.text ?? null });

/** A draft of the team by id, its body opened; null when there is none. */
export async function loadDraftWire(
  db: Db,
  keyring: Keyring,
  p: { teamId: string; draftId: string },
): Promise<DraftWire | null> {
  const [row] = await db
    .select()
    .from(t)
    .where(and(eq(t.id, p.draftId), eq(t.teamId, p.teamId)));
  return row ? wireOf(row, await openBody(keyring, row)) : null;
}

async function draftRow(
  db: Db,
  p: { teamId: string; inboxId: string; draftId: string },
): Promise<DraftRow | null> {
  const [row] = await db
    .select()
    .from(t)
    .where(and(eq(t.id, p.draftId), eq(t.teamId, p.teamId), eq(t.inboxId, p.inboxId)));
  return row ?? null;
}

const threadOf = (db: Db, row: Pick<DraftRow, "teamId" | "inboxId" | "threadId">) =>
  row.threadId
    ? getThread(db, {
        teamId: row.teamId,
        inboxId: row.inboxId,
        threadId: row.threadId,
        agentView: false,
      })
    : Promise.resolve(null);

/** Validated draft fields: recipients as mailboxes, absent parts null. */
function draftFields(input: {
  to?: unknown;
  cc?: unknown;
  bcc?: unknown;
  subject?: unknown;
  html?: unknown;
  text?: unknown;
}):
  | {
      to: string[] | null;
      cc: string[];
      bcc: string[];
      subject: string | null;
      html: string | null;
      text: string | null;
    }
  | string {
  const list = (v: unknown) =>
    v === undefined || v === null
      ? []
      : typeof v === "string" || (Array.isArray(v) && v.every((x) => typeof x === "string"))
        ? mailboxes(v as string | string[])
        : null;
  const to = input.to === undefined || input.to === null ? null : list(input.to);
  const cc = list(input.cc);
  const bcc = list(input.bcc);
  if ((input.to !== undefined && input.to !== null && to === null) || !cc || !bcc) {
    return "to, cc and bcc must be email addresses";
  }
  const text = (v: unknown) =>
    typeof v === "string" ? v : v === undefined || v === null ? null : undefined;
  const subject = text(input.subject);
  const html = text(input.html);
  const plain = text(input.text);
  if (subject === undefined || html === undefined || plain === undefined) {
    return "subject, html and text must be strings or null";
  }
  if (subject !== null) {
    const issue = subjectProblem(subject);
    if (issue) return issue;
  }
  return { to, cc, bcc, subject, html, text: plain };
}

type Fields = Exclude<ReturnType<typeof draftFields>, string>;

function fieldsProblem(f: Fields): string | null {
  const any = (v: string | null) => v !== null && v.trim() !== "";
  if (
    (f.to ?? []).length === 0 &&
    f.cc.length === 0 &&
    f.bcc.length === 0 &&
    !any(f.subject) &&
    !any(f.html) &&
    !any(f.text)
  ) {
    return "A draft needs at least one of to, cc, bcc, subject, text or html";
  }
  const total = new Set([...(f.to ?? []), ...f.cc, ...f.bcc].map(addressKey)).size;
  if (total > RECIPIENTS_PER_SEND_MAX) {
    return `to, cc and bcc together cannot exceed ${RECIPIENTS_PER_SEND_MAX} recipients`;
  }
  return null;
}

/** Writes a draft event once the draft and thread are read; rows wait for the caller's commit. */
async function emitDraftEvent(
  db: Db,
  p: {
    teamId: string;
    events: (thread: ThreadSummaryWire | null) => TeamWebhookEvent[];
    row: Pick<DraftRow, "teamId" | "inboxId" | "threadId">;
    enqueue: WebhookEnqueue;
  },
): Promise<void> {
  await enqueueTeamWebhookEvents(db, {
    teamId: p.teamId,
    events: p.events(await threadOf(db, p.row)),
    enqueue: p.enqueue,
  });
}

export async function createDraft(
  db: Db,
  deps: InboxSendDeps,
  p: {
    teamId: string;
    inboxId: string;
    actor: InboxActor;
    input: {
      to?: string | string[] | null | undefined;
      cc?: string | string[] | null | undefined;
      bcc?: string | string[] | null | undefined;
      subject?: string | null | undefined;
      html?: string | null | undefined;
      text?: string | null | undefined;
      thread_id?: string | undefined;
      reply_to_email_id?: string | undefined;
    };
  },
): Promise<{ ok: true; draft: DraftWire; created: boolean } | { ok: false; error: InboxError }> {
  const fields = draftFields(p.input);
  if (typeof fields === "string") return invalid(fields);
  const problem = fieldsProblem(fields);
  if (problem) return invalid(problem);
  const threadId = p.input.thread_id ?? null;
  const targetId = p.input.reply_to_email_id ?? null;
  if ((threadId === null) !== (targetId === null)) {
    return invalid("thread_id and reply_to_email_id must be set together");
  }
  const now = new Date();
  const inbox = await findLiveInbox(db, { teamId: p.teamId, inboxId: p.inboxId, now });
  if (!inbox) return fail(404, "not_found", INBOX_NOT_FOUND_MESSAGE);
  if (threadId && targetId) {
    const target = await loadThreadTarget(db, {
      teamId: p.teamId,
      inboxId: p.inboxId,
      threadId,
      emailId: targetId,
    });
    if (!target) return fail(404, "not_found", "Email not found.");
    if (target.direction === "inbound" && target.deliveredAt === null && isAgentActor(p.actor)) {
      return target.verdict === "pending"
        ? fail(404, "not_found", "Email not found.")
        : fail(403, "email_quarantined", EMAIL_QUARANTINED_MESSAGE);
    }
    const existing = await unsentReplyDraft(db, inbox.id, targetId);
    if (existing) {
      return {
        ok: true,
        created: false,
        draft: wireOf(existing, await openBody(deps.keyring, existing)),
      };
    }
  }
  const id = randomUUID();
  const sealed = await sealBody(deps.keyring, p.teamId, id, {
    html: fields.html,
    text: fields.text,
  });
  const queued = deferredEnqueue();
  let row: DraftRow;
  try {
    row = await db.transaction(async (txDb) => {
      const tx = txDb as unknown as Db;
      const [inserted] = await tx
        .insert(t)
        .values({
          id,
          teamId: p.teamId,
          inboxId: inbox.id,
          type: threadId ? "reply" : "standalone",
          threadId,
          replyToEmailId: targetId,
          to: fields.to,
          cc: fields.cc,
          bcc: fields.bcc,
          subject: fields.subject,
          ...bodyColumns(sealed),
          createdBy: encodeInboxActor(p.actor),
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!inserted) throw new Error("draft insert returned no row");
      await recordInboxActivity(tx, {
        teamId: p.teamId,
        inboxId: inbox.id,
        actor: p.actor,
        action: "draft.created",
        threadId,
        draftId: id,
      });
      const draft = wireOf(inserted, { html: fields.html, text: fields.text });
      await emitDraftEvent(tx, {
        teamId: p.teamId,
        row: inserted,
        enqueue: queued.enqueue,
        events: (thread) => [
          draftEvent("inbox.draft.created", {
            source: webhookSource(p.actor),
            inboxId: inbox.id,
            draft,
            thread,
            occurredAt: now,
          }),
        ],
      });
      return inserted;
    });
  } catch (err) {
    // A concurrent create won the one unsent reply draft per target.
    if (targetId && isUniqueViolation(err)) {
      const existing = await unsentReplyDraft(db, inbox.id, targetId);
      if (existing) {
        return {
          ok: true,
          created: false,
          draft: wireOf(existing, await openBody(deps.keyring, existing)),
        };
      }
    }
    throw err;
  }
  await queued.flush(deps.enqueueWebhookDeliveries);
  return { ok: true, created: true, draft: wireOf(row, { html: fields.html, text: fields.text }) };
}

async function unsentReplyDraft(
  db: Db,
  inboxId: string,
  targetId: string,
): Promise<DraftRow | null> {
  const [row] = await db
    .select()
    .from(t)
    .where(
      and(
        eq(t.inboxId, inboxId),
        eq(t.replyToEmailId, targetId),
        eq(t.type, "reply"),
        eq(t.forward, false),
        inArray(t.status, UNSENT),
      ),
    );
  return row ?? null;
}

/** Unsent drafts, most recently updated first; `after` pages toward older ones. */
export async function listDrafts(
  db: Db,
  p: { teamId: string; inboxId: string; query: ListQuery },
): Promise<{ data: DraftListItemWire[]; hasMore: boolean } | "bad_cursor"> {
  const unsent = and(eq(t.teamId, p.teamId), eq(t.inboxId, p.inboxId), inArray(t.status, UNSENT));
  const limit = p.query.limit ?? 20;
  const cursorId = p.query.before ?? p.query.after;
  if (cursorId) {
    const [cursor] = await db
      .select({ id: t.id })
      .from(t)
      .where(and(unsent, eq(t.id, cursorId)));
    if (!cursor) return "bad_cursor";
  }
  const towardNewer = p.query.before !== undefined;
  const rows = await db
    .select()
    .from(t)
    .where(
      and(
        unsent,
        cursorId
          ? keysetCursorWhere(t.updatedAt, t.id, cursorId, towardNewer ? "after" : "before")
          : undefined,
      ),
    )
    .orderBy(...(towardNewer ? [asc(t.updatedAt), asc(t.id)] : [desc(t.updatedAt), desc(t.id)]))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  if (towardNewer) page.reverse();
  // The body is sealed and listing opens no seal, so no snippet.
  return { data: page.map((row) => draftListItemWire(row, null)), hasMore: rows.length > limit };
}

export async function getDraft(
  db: Db,
  keyring: Keyring,
  p: { teamId: string; inboxId: string; draftId: string },
): Promise<DraftWire | null> {
  const row = await draftRow(db, p);
  return row ? wireOf(row, await openBody(keyring, row)) : null;
}

const PATCH_KEYS = ["to", "cc", "bcc", "subject", "html", "text"] as const;

/**
 * Resend's PATCH: a given field replaces the stored one (null clears it), and
 * html or text replace the whole body, the part left out becoming null. An
 * agent's edit sends a pending draft back to draft; a person's keeps it pending.
 */
export async function updateDraft(
  db: Db,
  deps: InboxSendDeps,
  p: {
    teamId: string;
    inboxId: string;
    draftId: string;
    actor: InboxActor;
    patch: Record<string, unknown>;
  },
): Promise<{ ok: true; draft: DraftWire } | { ok: false; error: InboxError }> {
  const given = PATCH_KEYS.filter((k) => k in p.patch);
  if (given.length === 0)
    return invalid("Provide at least one of to, cc, bcc, subject, html or text");
  const row = await draftRow(db, p);
  if (!row) return draftNotFound();
  const done = finished(row);
  if (done) return done;
  const stored = await openBody(deps.keyring, row);
  const bodyGiven = "html" in p.patch || "text" in p.patch;
  const merged = draftFields({
    to: "to" in p.patch ? p.patch.to : row.to,
    cc: "cc" in p.patch ? p.patch.cc : row.cc,
    bcc: "bcc" in p.patch ? p.patch.bcc : row.bcc,
    subject: "subject" in p.patch ? p.patch.subject : row.subject,
    html: bodyGiven ? (p.patch.html ?? null) : (stored?.html ?? null),
    text: bodyGiven ? (p.patch.text ?? null) : (stored?.text ?? null),
  });
  if (typeof merged === "string") return invalid(merged);
  const problem = fieldsProblem(merged);
  if (problem) return invalid(problem);
  const now = new Date();
  const backToDraft = row.status === "pending_approval" && !canApprove(p.actor);
  const body: DraftBody = {
    html: merged.html,
    text: merged.text,
    ...(stored?.forwardMode ? { forwardMode: stored.forwardMode } : {}),
  };
  const sealed =
    bodyGiven || !stored ? await sealBody(deps.keyring, row.teamId, row.id, body) : null;
  const queued = deferredEnqueue();
  const updated = await db.transaction(async (txDb) => {
    const tx = txDb as unknown as Db;
    const [next] = await tx
      .update(t)
      .set({
        to: merged.to,
        cc: merged.cc,
        bcc: merged.bcc,
        subject: merged.subject,
        ...(sealed ? bodyColumns(sealed) : {}),
        ...(backToDraft ? { status: "draft" as const, approvalReasons: [], expiresAt: null } : {}),
        updatedAt: now,
        version: sql`${t.version} + 1`,
      })
      .where(and(eq(t.id, row.id), eq(t.version, row.version), inArray(t.status, UNSENT)))
      .returning();
    if (!next) return null;
    await recordInboxActivity(tx, {
      teamId: row.teamId,
      inboxId: row.inboxId,
      actor: p.actor,
      action: "draft.updated",
      threadId: row.threadId,
      draftId: row.id,
    });
    const draft = wireOf(next, body);
    await emitDraftEvent(tx, {
      teamId: row.teamId,
      row: next,
      enqueue: queued.enqueue,
      events: (thread) => [
        draftEvent("inbox.draft.updated", {
          source: webhookSource(p.actor),
          inboxId: row.inboxId,
          draft,
          thread,
          occurredAt: now,
        }),
      ],
    });
    return draft;
  });
  if (!updated)
    return fail(409, "validation_error", "This draft changed while it was being updated");
  await queued.flush(deps.enqueueWebhookDeliveries);
  return { ok: true, draft: updated };
}

export async function deleteDraft(
  db: Db,
  deps: InboxSendDeps,
  p: { teamId: string; inboxId: string; draftId: string; actor: InboxActor },
): Promise<{ ok: true } | { ok: false; error: InboxError }> {
  const row = await draftRow(db, p);
  if (!row) return draftNotFound();
  if (row.status === "sent") return fail(409, "validation_error", "This draft was already sent");
  const now = new Date();
  const queued = deferredEnqueue();
  const deleted = await db.transaction(async (txDb) => {
    const tx = txDb as unknown as Db;
    const [gone] = await tx
      .delete(t)
      .where(and(eq(t.id, row.id), eq(t.version, row.version)))
      .returning({ id: t.id });
    if (!gone) return false;
    await recordInboxActivity(tx, {
      teamId: row.teamId,
      inboxId: row.inboxId,
      actor: p.actor,
      action: "draft.deleted",
      threadId: row.threadId,
      draftId: row.id,
    });
    await emitDraftEvent(tx, {
      teamId: row.teamId,
      row,
      enqueue: queued.enqueue,
      events: (thread) => [
        draftDeletedEvent({
          source: webhookSource(p.actor),
          inboxId: row.inboxId,
          draftId: row.id,
          thread,
          occurredAt: now,
        }),
      ],
    });
    return true;
  });
  if (!deleted)
    return fail(409, "validation_error", "This draft changed while it was being deleted");
  await queued.flush(deps.enqueueWebhookDeliveries);
  return { ok: true };
}

class DraftRaced extends Error {}

/**
 * A pending draft goes out only on an approver's send; then the inbox's
 * rails are skipped (team gates still apply). An agent's send of a plain
 * draft runs the rails and may hold it for approval (202).
 */
export async function sendDraft(
  db: Db,
  deps: InboxSendDeps,
  p: {
    teamId: string;
    billing: QuotaTeamRow;
    actor: InboxActor;
    inboxId: string;
    draftId: string;
    idempotencyKey?: string | null | undefined;
  },
): Promise<SendOutcome> {
  const request = {
    route: "POST /inboxes/{inbox_id}/drafts/{draft_id}/send",
    params: { inboxId: p.inboxId, draftId: p.draftId },
  };
  let approvedPending = false;
  const outcome = await withIdempotency(
    db,
    deps,
    { teamId: p.teamId, key: p.idempotencyKey, request },
    async (complete) => {
      const now = new Date();
      const row = await draftRow(db, p);
      if (!row) return refused(404, "not_found", "Draft not found.");
      const done = finished(row);
      if (done) return { kind: "refused", error: done.error };
      if (row.status === "pending_approval" && !canApprove(p.actor)) {
        return refused(
          403,
          "approval_required",
          "A person must approve this draft before it is sent",
        );
      }
      const inbox = await findLiveInbox(db, { teamId: p.teamId, inboxId: p.inboxId, now });
      if (!inbox) return refused(404, "not_found", INBOX_NOT_FOUND_MESSAGE);
      const body = await openBody(deps.keyring, row);
      if (!body)
        return refused(422, "validation_error", "This draft's content is no longer stored");
      if ([...(row.to ?? []), ...row.cc, ...row.bcc].length === 0) {
        return refused(
          422,
          "validation_error",
          "A draft needs at least one recipient before it is sent",
        );
      }
      const domainId = await inboxSendDomain(db, p.teamId, inbox);
      if (isOutcome(domainId)) return domainId;
      const target =
        row.threadId && row.replyToEmailId
          ? await loadThreadTarget(db, {
              teamId: p.teamId,
              inboxId: inbox.id,
              threadId: row.threadId,
              emailId: row.replyToEmailId,
            })
          : null;
      const [thread] = row.threadId
        ? await db
            .select({ subject: schema.inboxThreads.subject })
            .from(schema.inboxThreads)
            .where(eq(schema.inboxThreads.id, row.threadId))
        : [];
      let attachments: EmailAttachment[] = [];
      let forwardedSecret = false;
      if (row.forward) {
        if (!target)
          return refused(422, "validation_error", "The forwarded email is no longer stored");
        const files = await forwardFiles(db, deps, {
          teamId: p.teamId,
          target,
          mode: body.forwardMode ?? "inline",
        });
        if (isOutcome(files)) return files;
        attachments = files;
        forwardedSecret = target.direction === "inbound" && target.row.extractedKinds.length > 0;
      }
      const subject =
        row.subject ??
        (row.forward
          ? forwardSubject(thread?.subject ?? null)
          : row.type === "reply"
            ? replySubject(thread?.subject ?? null)
            : "");
      const approved = canApprove(p.actor);
      approvedPending = approved && row.status === "pending_approval";
      const hold: HoldSpec = {
        type: row.type,
        forward: row.forward,
        targetId: row.replyToEmailId,
        draftId: row.id,
        ...(body.forwardMode ? { forwardMode: body.forwardMode } : {}),
      };
      const prepared: PreparedSend = {
        teamId: p.teamId,
        billing: p.billing,
        actor: p.actor,
        inbox,
        threadId: row.threadId,
        from: inboxFrom(inbox),
        domainId,
        to: row.to ?? [],
        cc: row.cc,
        bcc: row.bcc,
        subject,
        html: body.html,
        text: body.text,
        attachments,
        headers: target && !row.forward ? targetParentHeaders(target) : {},
        approved,
        requiresApproval: false,
        replyTarget:
          target && !row.forward
            ? { automated: target.direction === "inbound" ? target.row.automated : null }
            : null,
        untrustedReplyTo: target && !row.forward ? untrustedReplyTos(target) : [],
        forwardedSecret,
        hold,
        now,
      };
      try {
        return await dispatchSend(db, deps, prepared, {
          complete,
          onSent: async (tx, emailId, threadId) => {
            const [sent] = await tx
              .update(t)
              .set({
                status: "sent",
                emailId,
                approvalReasons: [],
                expiresAt: null,
                ...(approvedPending
                  ? { decidedBy: encodeInboxActor(p.actor), decidedAt: now }
                  : {}),
                updatedAt: now,
                version: sql`${t.version} + 1`,
              })
              .where(and(eq(t.id, row.id), eq(t.version, row.version), inArray(t.status, UNSENT)))
              .returning();
            if (!sent) throw new DraftRaced();
            for (const action of approvedPending
              ? (["draft.approved", "draft.sent"] as const)
              : (["draft.sent"] as const)) {
              await recordInboxActivity(tx, {
                teamId: p.teamId,
                inboxId: inbox.id,
                actor: p.actor,
                action,
                threadId,
                emailId,
                draftId: row.id,
              });
            }
            const summary = threadId
              ? await getThread(tx, {
                  teamId: p.teamId,
                  inboxId: inbox.id,
                  threadId,
                  agentView: false,
                })
              : null;
            if (!summary) return;
            await enqueueTeamWebhookEvents(tx, {
              teamId: p.teamId,
              events: [
                draftSentEvent({
                  source: webhookSource(p.actor),
                  inboxId: inbox.id,
                  draft: wireOf(sent, body),
                  thread: summary,
                  emailId,
                  occurredAt: now,
                }),
              ],
              // Committed with the send; the reconcile sweep delivers it with the rest.
              enqueue: async () => {},
            });
          },
        });
      } catch (err) {
        if (err instanceof DraftRaced) {
          return refused(409, "validation_error", "This draft changed while it was being sent");
        }
        throw err;
      }
    },
  );
  if (outcome.kind === "sent" && approvedPending && p.actor.kind === "user") {
    await recordAudit(db, {
      teamId: p.teamId,
      actor: { userId: p.actor.userId },
      action: "inbox.draft_approved",
      target: { type: "inbox_draft", id: p.draftId },
    });
  }
  return outcome;
}

/** Approvers only: the draft is kept as rejected and reads as deleted to webhooks. */
export async function rejectDraft(
  db: Db,
  deps: InboxSendDeps,
  p: { teamId: string; inboxId: string; draftId: string; actor: InboxActor },
): Promise<{ ok: true; draft: DraftWire } | { ok: false; error: InboxError }> {
  if (!canApprove(p.actor)) {
    return fail(
      403,
      "restricted_api_key",
      "Only a person or a team-wide API key can reject drafts",
    );
  }
  const row = await draftRow(db, p);
  if (!row) return draftNotFound();
  const done = finished(row);
  if (done) return done;
  const now = new Date();
  const queued = deferredEnqueue();
  const rejected = await db.transaction(async (txDb) => {
    const tx = txDb as unknown as Db;
    const [next] = await tx
      .update(t)
      .set({
        status: "rejected",
        decidedBy: encodeInboxActor(p.actor),
        decidedAt: now,
        expiresAt: null,
        updatedAt: now,
        version: sql`${t.version} + 1`,
      })
      .where(and(eq(t.id, row.id), eq(t.version, row.version), inArray(t.status, UNSENT)))
      .returning();
    if (!next) return null;
    await recordInboxActivity(tx, {
      teamId: row.teamId,
      inboxId: row.inboxId,
      actor: p.actor,
      action: "draft.rejected",
      threadId: row.threadId,
      draftId: row.id,
    });
    await emitDraftEvent(tx, {
      teamId: row.teamId,
      row,
      enqueue: queued.enqueue,
      events: (thread) => [
        draftDeletedEvent({
          source: webhookSource(p.actor),
          inboxId: row.inboxId,
          draftId: row.id,
          thread,
          occurredAt: now,
        }),
      ],
    });
    return next;
  });
  if (!rejected)
    return fail(409, "validation_error", "This draft changed while it was being rejected");
  await queued.flush(deps.enqueueWebhookDeliveries);
  return { ok: true, draft: wireOf(rejected, await openBody(deps.keyring, rejected)) };
}

/** Drafts expired per run of the hourly sweep; the next run takes the rest. */
const EXPIRE_BATCH = 500;

/** Pending drafts nobody approved within DRAFT_APPROVAL_TTL: expired, and deleted to webhooks. */
export async function expireDrafts(db: Db, deps: InboxSendDeps, now: Date): Promise<number> {
  const queued = deferredEnqueue();
  const expired = await db.transaction(async (txDb) => {
    const tx = txDb as unknown as Db;
    const due = await tx
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.status, "pending_approval"), lte(t.expiresAt, now)))
      .orderBy(asc(t.expiresAt))
      .limit(EXPIRE_BATCH);
    if (due.length === 0) return 0;
    const rows = await tx
      .update(t)
      .set({ status: "expired", updatedAt: now, version: sql`${t.version} + 1` })
      .where(
        and(
          inArray(
            t.id,
            due.map((d) => d.id),
          ),
          eq(t.status, "pending_approval"),
        ),
      )
      .returning();
    const system: InboxActor = { kind: "system" };
    for (const row of rows) {
      await recordInboxActivity(tx, {
        teamId: row.teamId,
        inboxId: row.inboxId,
        actor: system,
        action: "draft.expired",
        threadId: row.threadId,
        draftId: row.id,
      });
      await emitDraftEvent(tx, {
        teamId: row.teamId,
        row,
        enqueue: queued.enqueue,
        events: (thread) => [
          draftDeletedEvent({
            source: "system",
            inboxId: row.inboxId,
            draftId: row.id,
            thread,
            occurredAt: now,
          }),
        ],
      });
    }
    return rows.length;
  });
  await queued.flush(deps.enqueueWebhookDeliveries);
  return expired;
}

/** A held send as the draft a person approves; the reply draft of its target is reused. */
export interface HeldDraft {
  teamId: string;
  inboxId: string;
  actor: InboxActor;
  spec: HoldSpec;
  threadId: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: { html: string | null; text: string | null };
  reasons: string[];
  now: Date;
}

/**
 * Keeps a held send as a pending_approval draft, in one transaction with its
 * email.drafted activity, its event and the caller's `complete` (the
 * idempotency record of "draft:<id>").
 */
export async function draftForHeldSend(
  db: Db,
  deps: InboxSendDeps,
  held: HeldDraft,
  complete: ((tx: Db, recorded: string) => Promise<void>) | undefined,
): Promise<DraftWire> {
  const { spec, now } = held;
  const body: DraftBody = {
    html: held.body.html,
    text: held.body.text,
    ...(spec.forwardMode ? { forwardMode: spec.forwardMode } : {}),
  };
  const pending = {
    status: "pending_approval" as const,
    approvalReasons: held.reasons,
    expiresAt: new Date(now.getTime() + DRAFT_APPROVAL_TTL),
    updatedAt: now,
  };
  const reuse = async (): Promise<DraftRow | null> => {
    if (spec.draftId)
      return draftRow(db, { teamId: held.teamId, inboxId: held.inboxId, draftId: spec.draftId });
    if (spec.type === "reply" && !spec.forward && spec.targetId) {
      return unsentReplyDraft(db, held.inboxId, spec.targetId);
    }
    return null;
  };
  for (let attempt = 0; ; attempt++) {
    const existing = await reuse();
    const id = existing?.id ?? randomUUID();
    const sealed = spec.draftId ? null : await sealBody(deps.keyring, held.teamId, id, body);
    const queued = deferredEnqueue();
    try {
      const draft = await db.transaction(async (txDb) => {
        const tx = txDb as unknown as Db;
        let row: DraftRow | undefined;
        if (existing) {
          [row] = await tx
            .update(t)
            .set({
              ...(spec.draftId
                ? {}
                : {
                    to: held.to,
                    cc: held.cc,
                    bcc: held.bcc,
                    subject: held.subject,
                    ...(sealed ? bodyColumns(sealed) : {}),
                  }),
              ...pending,
              version: sql`${t.version} + 1`,
            })
            .where(
              and(
                eq(t.id, existing.id),
                eq(t.version, existing.version),
                inArray(t.status, UNSENT),
              ),
            )
            .returning();
          if (!row) throw new DraftRaced();
        } else {
          if (!sealed) throw new Error("a new held draft has no sealed body");
          [row] = await tx
            .insert(t)
            .values({
              id,
              teamId: held.teamId,
              inboxId: held.inboxId,
              type: spec.type,
              forward: spec.forward,
              threadId: spec.type === "reply" ? held.threadId : null,
              replyToEmailId: spec.type === "reply" ? spec.targetId : null,
              to: held.to,
              cc: held.cc,
              bcc: held.bcc,
              subject: held.subject,
              ...bodyColumns(sealed),
              createdBy: encodeInboxActor(held.actor),
              createdAt: now,
              ...pending,
            })
            .returning();
          if (!row) throw new Error("draft insert returned no row");
        }
        const stored = row;
        await recordInboxActivity(tx, {
          teamId: held.teamId,
          inboxId: held.inboxId,
          actor: held.actor,
          action: "email.drafted",
          threadId: stored.threadId,
          draftId: stored.id,
          decision: { result: "draft", reasons: held.reasons },
        });
        const wire = wireOf(stored, spec.draftId ? await openBody(deps.keyring, stored) : body);
        await emitDraftEvent(tx, {
          teamId: held.teamId,
          row: stored,
          enqueue: queued.enqueue,
          events: (thread) => [
            draftEvent(existing ? "inbox.draft.updated" : "inbox.draft.created", {
              source: webhookSource(held.actor),
              inboxId: held.inboxId,
              draft: wire,
              thread,
              occurredAt: now,
            }),
          ],
        });
        await complete?.(tx, `draft:${stored.id}`);
        return wire;
      });
      await queued.flush(deps.enqueueWebhookDeliveries);
      return draft;
    } catch (err) {
      // Lost a race for the one unsent reply draft of the target: hold into the winner's.
      if (attempt < 2 && (err instanceof DraftRaced || isUniqueViolation(err))) continue;
      throw err;
    }
  }
}
