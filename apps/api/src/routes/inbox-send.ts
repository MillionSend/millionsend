import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  CURSOR_NOT_FOUND_MESSAGE,
  createDraft,
  deleteDraft,
  findLiveInbox,
  forwardInThread,
  forwardReceivedEmail,
  getDraft,
  INBOX_NOT_FOUND_MESSAGE,
  type InboxError,
  type InboxSendDeps,
  inboxActorFromAuth,
  isOutcome,
  listDrafts,
  receivedAnswerDomain,
  receivedEmailScope,
  refused as refusedOutcome,
  rejectDraft,
  replyInThread,
  replyToReceivedEmail,
  type SendOutcome,
  sendDraft,
  updateDraft,
} from "@millionsend/core";
import { schema } from "@millionsend/db";
import { and, eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { type ApiDeps, type Env, errorBody, RESTRICTED_DOMAIN_MESSAGE } from "../app.js";
import {
  createDraftRequestSchema,
  deleteDraftResponseSchema,
  draftSchema,
  inboxForwardRequestSchema,
  inboxReplyRequestSchema,
  listDraftsResponseSchema,
  receivingForwardRequestSchema,
  receivingReplyRequestSchema,
  receivingSendResponseSchema,
  sendDraftResponseSchema,
  sentEmailSchema,
  updateDraftRequestSchema,
} from "../schemas/inbox-send.js";
import { errorSchema, listQuerySchema } from "../schemas.js";

const jsonErr = (description: string) => ({
  content: { "application/json": { schema: errorSchema } },
  description,
});

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { "application/json": { schema } },
  description,
});

const errors = {
  403: jsonErr("Restricted API key, the inbox's rules, or held mail"),
  404: jsonErr("Not found"),
  409: jsonErr("Idempotency conflict, or a draft already sent"),
  422: jsonErr("Validation error"),
  429: jsonErr("The inbox's daily send limit"),
};

const threadEmailParams = z.object({
  inbox_id: z.uuid(),
  thread_id: z.uuid(),
  email_id: z.uuid(),
});
const draftParams = z.object({ inbox_id: z.uuid(), draft_id: z.uuid() });

/**
 * Replies, forwards and drafts of an inbox (Resend's Inboxes beta), the
 * reply and forward of any received email, and draft rejection. Every send
 * runs the sending inbox's rules: an email they hold comes back as a 202
 * Draft for a person to approve.
 */
export function registerInboxSendRoutes(
  app: OpenAPIHono<Env>,
  deps: ApiDeps,
  opts: { requireFullAccess: MiddlewareHandler<Env> },
): void {
  const { db } = deps;
  const sendDeps = (): InboxSendDeps => {
    if (!deps.inboxKeys) throw new Error("inboxKeys is not configured");
    return {
      ...deps,
      inboxKeys: deps.inboxKeys,
      sharedInboxDomain: deps.sharedInboxDomain ?? null,
    };
  };
  const actor = (c: Context<Env>) => inboxActorFromAuth(c.get("auth"));
  const idempotencyKey = (c: Context<Env>) => c.req.header("idempotency-key") ?? null;

  const refusal = (c: Context<Env>, e: InboxError) => {
    if (e.retryAfterSec !== undefined) c.header("retry-after", String(e.retryAfterSec));
    return c.json(errorBody(e.status, e.name, e.message), e.status);
  };

  /** SECURITY: a domain-scoped key sends only from the inboxes of its domain. */
  const outsideKeyDomain = async (c: Context<Env>, inboxId: string) => {
    const auth = c.get("auth");
    if (auth.domainId === null) return false;
    const inbox = await findLiveInbox(db, { teamId: auth.teamId, inboxId });
    return inbox !== null && inbox.domainId !== auth.domainId;
  };
  const restrictedDomain = (c: Context<Env>) =>
    c.json(errorBody(403, "restricted_api_key", RESTRICTED_DOMAIN_MESSAGE), 403);

  /** 200 with the sent email, 202 with the Draft a held send became, or the refusal. */
  const sentOr202 = <T>(
    c: Context<Env>,
    outcome: SendOutcome,
    sent: (o: SendOutcome & { kind: "sent" }) => T,
  ) => {
    if (outcome.kind === "refused") return refusal(c, outcome.error);
    if (outcome.kind === "draft") return c.json(outcome.draft, 202);
    return c.json(sent(outcome), 200);
  };

  app.openapi(
    createRoute({
      method: "post",
      path: "/inboxes/{inbox_id}/threads/{thread_id}/emails/{email_id}/reply",
      summary: "Reply to a thread email",
      description:
        "Replies from the inbox address in the thread, with In-Reply-To and References set: to the email's Reply-To or sender (or, for an email the inbox sent, its recipients), plus everyone else on it with `reply_all`. Bcc is never copied. Accepts an `Idempotency-Key`. When the inbox's rules hold the reply (or `requires_approval` is true) it is kept as a draft for a person to approve and the answer is 202 with the Draft.",
      request: {
        params: threadEmailParams,
        body: { content: { "application/json": { schema: inboxReplyRequestSchema } } },
      },
      responses: {
        200: json(sentEmailSchema, "Sent"),
        202: json(draftSchema, "Held for approval"),
        ...errors,
      },
    }),
    async (c) => {
      const { inbox_id, thread_id, email_id } = c.req.valid("param");
      if (await outsideKeyDomain(c, inbox_id)) return restrictedDomain(c);
      const auth = c.get("auth");
      const outcome = await replyInThread(db, sendDeps(), {
        teamId: auth.teamId,
        billing: auth.billing,
        actor: actor(c),
        inboxId: inbox_id,
        threadId: thread_id,
        emailId: email_id,
        body: c.req.valid("json"),
        idempotencyKey: idempotencyKey(c),
      });
      return sentOr202(c, outcome, (o) => o.email);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/inboxes/{inbox_id}/threads/{thread_id}/emails/{email_id}/forward",
      summary: "Forward a thread email",
      description:
        'Forwards the email from the inbox address, quoted under "---------- Forwarded message ---------" with its From, Date, Subject and To, after an optional note. Its attachments go along within 10 MiB. An email that carries malware is never forwarded. Accepts an `Idempotency-Key`; a forward the inbox\'s rules hold answers 202 with the Draft.',
      request: {
        params: threadEmailParams,
        body: { content: { "application/json": { schema: inboxForwardRequestSchema } } },
      },
      responses: {
        200: json(sentEmailSchema, "Sent"),
        202: json(draftSchema, "Held for approval"),
        ...errors,
      },
    }),
    async (c) => {
      const { inbox_id, thread_id, email_id } = c.req.valid("param");
      if (await outsideKeyDomain(c, inbox_id)) return restrictedDomain(c);
      const auth = c.get("auth");
      const outcome = await forwardInThread(db, sendDeps(), {
        teamId: auth.teamId,
        billing: auth.billing,
        actor: actor(c),
        inboxId: inbox_id,
        threadId: thread_id,
        emailId: email_id,
        body: c.req.valid("json"),
        idempotencyKey: idempotencyKey(c),
      });
      return sentOr202(c, outcome, (o) => o.email);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/inboxes/{inbox_id}/drafts",
      summary: "Create a draft",
      description:
        "A standalone draft, or with `thread_id` and `reply_to_email_id` a reply draft in that thread. One unsent reply draft per email: creating another answers 200 with the existing one. A reply draft copies no recipients; set `to` before sending. Nothing is sent until POST /inboxes/{inbox_id}/drafts/{draft_id}/send.",
      request: {
        params: z.object({ inbox_id: z.uuid() }),
        body: { content: { "application/json": { schema: createDraftRequestSchema } } },
      },
      responses: {
        200: json(draftSchema, "The existing reply draft"),
        201: json(draftSchema, "Created"),
        ...errors,
      },
    }),
    async (c) => {
      const { inbox_id } = c.req.valid("param");
      if (await outsideKeyDomain(c, inbox_id)) return restrictedDomain(c);
      const auth = c.get("auth");
      const result = await createDraft(db, sendDeps(), {
        teamId: auth.teamId,
        inboxId: inbox_id,
        actor: actor(c),
        input: c.req.valid("json"),
      });
      if (!result.ok) return refusal(c, result.error);
      return result.created ? c.json(result.draft, 201) : c.json(result.draft, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/inboxes/{inbox_id}/drafts",
      summary: "List drafts",
      description:
        "Unsent drafts (draft and pending_approval), most recently updated first; `after` pages toward older ones.",
      request: { params: z.object({ inbox_id: z.uuid() }), query: listQuerySchema },
      responses: { 200: json(listDraftsResponseSchema, "Drafts"), ...errors },
    }),
    async (c) => {
      const { inbox_id } = c.req.valid("param");
      const auth = c.get("auth");
      const inbox = await findLiveInbox(db, { teamId: auth.teamId, inboxId: inbox_id });
      if (!inbox) return c.json(errorBody(404, "not_found", INBOX_NOT_FOUND_MESSAGE), 404);
      if (auth.domainId !== null && inbox.domainId !== auth.domainId) return restrictedDomain(c);
      const page = await listDrafts(db, {
        teamId: auth.teamId,
        inboxId: inbox_id,
        query: c.req.valid("query"),
      });
      if (page === "bad_cursor")
        return c.json(errorBody(404, "not_found", CURSOR_NOT_FOUND_MESSAGE), 404);
      return c.json({ object: "list" as const, has_more: page.hasMore, data: page.data }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/inboxes/{inbox_id}/drafts/{draft_id}",
      summary: "Retrieve a draft",
      description: "One draft with its body, also after it was sent (status sent, email_id set).",
      request: { params: draftParams },
      responses: { 200: json(draftSchema, "Draft"), ...errors },
    }),
    async (c) => {
      const { inbox_id, draft_id } = c.req.valid("param");
      if (await outsideKeyDomain(c, inbox_id)) return restrictedDomain(c);
      const auth = c.get("auth");
      const draft = await getDraft(db, deps.keyring, {
        teamId: auth.teamId,
        inboxId: inbox_id,
        draftId: draft_id,
      });
      if (!draft) return c.json(errorBody(404, "not_found", "Draft not found."), 404);
      return c.json(draft, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/inboxes/{inbox_id}/drafts/{draft_id}",
      summary: "Update a draft",
      description:
        "Each given field replaces the stored one; null clears it. Setting html or text replaces the whole body: the part left out becomes null. A sent draft, or one that changed during the request, answers 409. An edit by an agent sends a draft waiting for approval back to draft.",
      request: {
        params: draftParams,
        body: { content: { "application/json": { schema: updateDraftRequestSchema } } },
      },
      responses: { 200: json(draftSchema, "Draft"), ...errors },
    }),
    async (c) => {
      const { inbox_id, draft_id } = c.req.valid("param");
      if (await outsideKeyDomain(c, inbox_id)) return restrictedDomain(c);
      const auth = c.get("auth");
      const result = await updateDraft(db, sendDeps(), {
        teamId: auth.teamId,
        inboxId: inbox_id,
        draftId: draft_id,
        actor: actor(c),
        patch: c.req.valid("json"),
      });
      if (!result.ok) return refusal(c, result.error);
      return c.json(result.draft, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/inboxes/{inbox_id}/drafts/{draft_id}",
      summary: "Delete a draft",
      description: "Removes an unsent draft; a sent one answers 409.",
      request: { params: draftParams },
      responses: { 200: json(deleteDraftResponseSchema, "Deleted"), ...errors },
    }),
    async (c) => {
      const { inbox_id, draft_id } = c.req.valid("param");
      if (await outsideKeyDomain(c, inbox_id)) return restrictedDomain(c);
      const auth = c.get("auth");
      const result = await deleteDraft(db, sendDeps(), {
        teamId: auth.teamId,
        inboxId: inbox_id,
        draftId: draft_id,
        actor: actor(c),
      });
      if (!result.ok) return refusal(c, result.error);
      return c.json({ object: "inbox_draft" as const, id: draft_id, deleted: true as const }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/inboxes/{inbox_id}/drafts/{draft_id}/send",
      summary: "Send a draft",
      description:
        "Sends the draft from the inbox address; takes no body and accepts an `Idempotency-Key`. A draft waiting for approval goes out only when a person or a team-wide full access key sends it (403 approval_required otherwise), and their send skips the inbox's rules but never the team's limits. An agent's send of a draft runs the rules and may hold it (202).",
      request: { params: draftParams },
      responses: {
        200: json(sendDraftResponseSchema, "Sent"),
        202: json(draftSchema, "Held for approval"),
        ...errors,
      },
    }),
    async (c) => {
      const { inbox_id, draft_id } = c.req.valid("param");
      if (await outsideKeyDomain(c, inbox_id)) return restrictedDomain(c);
      const auth = c.get("auth");
      const outcome = await sendDraft(db, sendDeps(), {
        teamId: auth.teamId,
        billing: auth.billing,
        actor: actor(c),
        inboxId: inbox_id,
        draftId: draft_id,
        idempotencyKey: idempotencyKey(c),
      });
      return sentOr202(c, outcome, (o) => ({
        object: "inbox_draft" as const,
        id: draft_id,
        thread_id: o.threadId,
        email_id: o.email.id,
      }));
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/inboxes/{inbox_id}/drafts/{draft_id}/reject",
      summary: "Reject a draft",
      description:
        "MillionSend extension: a person or a team-wide full access key turns down a draft waiting for approval. It stays readable with status rejected; webhooks report it deleted.",
      request: { params: draftParams },
      responses: { 200: json(draftSchema, "Rejected"), ...errors },
    }),
    async (c) => {
      const { inbox_id, draft_id } = c.req.valid("param");
      if (await outsideKeyDomain(c, inbox_id)) return restrictedDomain(c);
      const auth = c.get("auth");
      const result = await rejectDraft(db, sendDeps(), {
        teamId: auth.teamId,
        inboxId: inbox_id,
        draftId: draft_id,
        actor: actor(c),
      });
      if (!result.ok) return refusal(c, result.error);
      return c.json(result.draft, 200);
    },
  );

  /**
   * SECURITY: a domain-scoped key answers only from its own domain, so the
   * sender the answer would use is resolved first and checked.
   */
  const receivedOutsideKeyDomain = async (
    c: Context<Env>,
    id: string,
    body: { from?: string | undefined; inbox_id?: string | undefined },
  ): Promise<SendOutcome | "restricted" | null> => {
    const auth = c.get("auth");
    if (auth.domainId === null) return null;
    const r = schema.receivedEmails;
    const [visible] = await db
      .select({ id: r.id })
      .from(r)
      .where(
        and(
          eq(r.id, id),
          receivedEmailScope({ teamId: auth.teamId, domainId: auth.domainId, held: "include" }),
        ),
      );
    if (!visible) return refusedOutcome(404, "not_found", "Email not found.");
    const domainId = await receivedAnswerDomain(db, {
      teamId: auth.teamId,
      actor: actor(c),
      receivedEmailId: id,
      from: body.from,
      inboxId: body.inbox_id,
    });
    if (isOutcome(domainId)) return domainId;
    return domainId === auth.domainId ? null : "restricted";
  };

  const receivingSent = (o: SendOutcome & { kind: "sent" }) => ({
    object: "email" as const,
    id: o.email.id,
    thread_id: o.threadId,
    inbox_id: o.inboxId,
  });

  app.openapi(
    createRoute({
      method: "post",
      path: "/emails/receiving/{id}/reply",
      summary: "Reply to a received email",
      description:
        "MillionSend extension: replies server-side, threaded with In-Reply-To and References. It goes out from the inbox the email reached (`inbox_id` picks one), else from the first address it was received for, or from `from`. A reply from an inbox runs its rules and may be held as a draft (202). Accepts an `Idempotency-Key`. Needs a full access key.",
      middleware: [opts.requireFullAccess],
      request: {
        params: z.object({ id: z.uuid() }),
        body: { content: { "application/json": { schema: receivingReplyRequestSchema } } },
      },
      responses: {
        200: json(receivingSendResponseSchema, "Sent"),
        202: json(draftSchema, "Held for approval"),
        ...errors,
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const scoped = await receivedOutsideKeyDomain(c, id, body);
      if (scoped === "restricted") return restrictedDomain(c);
      if (scoped) return sentOr202(c, scoped, receivingSent);
      const auth = c.get("auth");
      const outcome = await replyToReceivedEmail(db, sendDeps(), {
        teamId: auth.teamId,
        billing: auth.billing,
        actor: actor(c),
        receivedEmailId: id,
        body,
        idempotencyKey: idempotencyKey(c),
      });
      return sentOr202(c, outcome, receivingSent);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/emails/receiving/{id}/forward",
      summary: "Forward a received email",
      description:
        "MillionSend extension: forwards server-side, inline under a note (default) or with the original attached as forwarded_message.eml (`mode: attachment`), within 10 MiB. An email that carries malware is never forwarded. Sender rules and the 202 draft answer are those of the reply. Accepts an `Idempotency-Key`. Needs a full access key.",
      middleware: [opts.requireFullAccess],
      request: {
        params: z.object({ id: z.uuid() }),
        body: { content: { "application/json": { schema: receivingForwardRequestSchema } } },
      },
      responses: {
        200: json(receivingSendResponseSchema, "Sent"),
        202: json(draftSchema, "Held for approval"),
        ...errors,
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const scoped = await receivedOutsideKeyDomain(c, id, body);
      if (scoped === "restricted") return restrictedDomain(c);
      if (scoped) return sentOr202(c, scoped, receivingSent);
      const auth = c.get("auth");
      const outcome = await forwardReceivedEmail(db, sendDeps(), {
        teamId: auth.teamId,
        billing: auth.billing,
        actor: actor(c),
        receivedEmailId: id,
        body,
        idempotencyKey: idempotencyKey(c),
      });
      return sentOr202(c, outcome, receivingSent);
    },
  );
}
