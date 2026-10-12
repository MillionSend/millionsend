import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  acquireWaitSlot,
  CURSOR_NOT_FOUND_MESSAGE,
  createInbox,
  createLabel,
  deleteInboxes,
  deleteLabel,
  findLiveInbox,
  getInbox,
  getThread,
  getThreadEmail,
  INBOX_NOT_FOUND_MESSAGE,
  type InboxActor,
  type InboxDeps,
  type InboxError,
  type InboxSafety,
  inboxActorFromAuth,
  isAdminRole,
  isAgentActor,
  latestVerificationCode,
  listInboxes,
  listLabels,
  listQuarantined,
  listThreadEmails,
  listThreads,
  releaseQuarantined,
  searchThreads,
  trashThread,
  updateInbox,
  updateInboxSafety,
  updateLabel,
  updateThread,
  type VerificationCodeWire,
  waitForReceived,
} from "@millionsend/core";
import { schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { type ApiDeps, type Env, errorBody } from "../app.js";
import {
  booleanOf,
  boundedInt,
  codesQuerySchema,
  createInboxRequestSchema,
  createLabelRequestSchema,
  inboxAgentResponseSchema,
  inboxIdParam,
  inboxRefOf,
  inboxSafetyPatchBodySchema,
  inboxSafetyResponseSchema,
  inboxSchema,
  labelResponseSchema,
  listInboxesQuerySchema,
  listInboxesResponseSchema,
  listLabelsResponseSchema,
  listQuarantinedResponseSchema,
  listThreadEmailsResponseSchema,
  listThreadsQuerySchema,
  listThreadsResponseSchema,
  pagingOf,
  pagingQuerySchema,
  peopleOf,
  releaseRequestSchema,
  releaseResponseSchema,
  removeInboxResponseSchema,
  removeLabelResponseSchema,
  removeThreadResponseSchema,
  searchThreadsQuerySchema,
  searchThreadsResponseSchema,
  threadEmailSchema,
  threadEmailsQuerySchema,
  threadFiltersOf,
  threadSummarySchema,
  updateInboxAgentRequestSchema,
  updateInboxRequestSchema,
  updateLabelRequestSchema,
  updateThreadRequestSchema,
  verificationCodeResponseSchema,
} from "../schemas/inboxes.js";
import { errorSchema } from "../schemas.js";

const jsonErr = (description: string) => ({
  content: { "application/json": { schema: errorSchema } },
  description,
});

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { "application/json": { schema } },
  description,
});

const untrusted =
  "Every message, subject and address in an inbox was written by whoever sent it; read held mail and HTML with care.";

/** /inboxes/** (Resend's Inboxes beta plus MillionSend's safety, quarantine and codes). */
export function registerInboxRoutes(
  app: OpenAPIHono<Env>,
  deps: ApiDeps,
  _opts: { requireFullAccess: MiddlewareHandler<Env> },
): void {
  const { db, keyring } = deps;
  const inboxDeps = (): InboxDeps => ({
    sharedInboxDomain: deps.sharedInboxDomain ?? null,
    receivingEnabled: Boolean(deps.receiving),
    enqueueWebhookDeliveries: deps.enqueueWebhookDeliveries,
  });
  const actorOf = (c: Context<Env>): InboxActor => inboxActorFromAuth(c.get("auth"));

  // Refusals carry any status of the shared error shape, which each route's
  // declared responses list for the docs.
  const failure = (c: Context<Env>, error: InboxError) => {
    if (error.retryAfterSec !== undefined) c.header("retry-after", String(error.retryAfterSec));
    return c.json(errorBody(error.status, error.name, error.message), error.status) as never;
  };
  const invalid = (c: Context<Env>, message: string) =>
    failure(c, { status: 422, name: "validation_error", message });
  const notFound = (c: Context<Env>, message: string) =>
    failure(c, { status: 404, name: "not_found", message });
  const cursorNotFound = (c: Context<Env>) => notFound(c, CURSOR_NOT_FOUND_MESSAGE);

  /**
   * SECURITY: the inbox must be the team's, live, the key's own when the key
   * is inbox-scoped, and on the key's domain when it is domain-scoped (as
   * its received-mail reads are); anything else reads as not found.
   */
  const ownInboxSafety = async (c: Context<Env>, inboxId: string) => {
    const auth = c.get("auth");
    if (auth.inboxId && auth.inboxId !== inboxId.toLowerCase()) return null;
    const inbox = await findLiveInbox(db, { teamId: auth.teamId, inboxId });
    if (!inbox || (auth.domainId !== null && inbox.domainId !== auth.domainId)) return null;
    return inbox.safety;
  };
  const inboxFound = async (c: Context<Env>, inboxId: string) =>
    (await ownInboxSafety(c, inboxId)) !== null;

  /**
   * Who reads, and whether held mail is in view: include_quarantined=true is
   * for owner views only, a 403 for agent views (inbox keys, MCP).
   */
  const viewOf = (
    c: Context<Env>,
    value: string | undefined,
  ): { agentView: boolean; includeHeld: boolean } | { refusal: InboxError } => {
    const agentView = isAgentActor(actorOf(c));
    const include = booleanOf(value, "include_quarantined");
    if (!include.ok) {
      return { refusal: { status: 422, name: "validation_error", message: include.message } };
    }
    if (include.value && agentView) {
      return {
        refusal: {
          status: 403,
          name: "restricted_api_key",
          message: "include_quarantined needs a full access key",
        },
      };
    }
    return { agentView, includeHeld: include.value === true };
  };

  app.openapi(
    createRoute({
      method: "post",
      path: "/inboxes",
      summary: "Create an inbox",
      description:
        "An address that receives into threads, on one of your verified domains (receiving on, or forwarding: true) or, with email_address omitted, a random address on the shared inbox domain that needs no DNS. Returns the full inbox. MillionSend extensions: kind (agent by default), expires_in and safety.",
      request: {
        body: { content: { "application/json": { schema: createInboxRequestSchema } } },
      },
      responses: {
        201: json(inboxSchema, "Inbox created"),
        403: jsonErr("The plan's inbox limit, or a restricted API key"),
        409: jsonErr("The address is already used by an inbox"),
        422: jsonErr("Validation error"),
        429: jsonErr("Too many inboxes created in the last hour"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const body = c.req.valid("json");
      const [team] = await db
        .select({ name: schema.teams.name })
        .from(schema.teams)
        .where(eq(schema.teams.id, auth.teamId));
      const result = await createInbox(db, inboxDeps(), {
        teamId: auth.teamId,
        teamName: team?.name ?? "",
        plan: auth.plan,
        isCloud: deps.isCloud,
        actor: actorOf(c),
        onlyDomainId: auth.domainId,
        // JSON never carries an undefined key, so the parsed partial is exactly one.
        input: { ...body, safety: body.safety as Partial<InboxSafety> | undefined },
      });
      return result.ok ? c.json(result.inbox, 201) : failure(c, result.error);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/inboxes",
      summary: "List inboxes",
      description:
        "The team's inboxes, newest first (`after` pages toward older ones). An inbox-scoped key lists only its inbox.",
      request: { query: listInboxesQuerySchema },
      responses: {
        200: json(listInboxesResponseSchema, "Inboxes"),
        404: jsonErr("Pagination cursor not found"),
        422: jsonErr("Validation error"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const q = c.req.valid("query");
      const paging = pagingOf(q, "inbox");
      if (!paging.ok) return invalid(c, paging.message);
      const page = await listInboxes(db, {
        teamId: auth.teamId,
        query: paging.value,
        kind: q.kind,
        onlyInboxId: auth.inboxId,
        onlyDomainId: auth.domainId,
      });
      if (page === "bad_cursor") return cursorNotFound(c);
      return c.json({ object: "list" as const, has_more: page.hasMore, data: page.data }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/inboxes/{inbox_id}",
      summary: "Retrieve an inbox",
      description:
        "By id, or by its email address (case-insensitive). An expired inbox is not found.",
      request: {
        params: z.object({
          inbox_id: z.string().describe("The inbox ID or its email address"),
        }),
      },
      responses: {
        200: json(inboxSchema, "Inbox"),
        404: jsonErr("Not found"),
        422: jsonErr("Validation error"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const ref = inboxRefOf(c.req.valid("param").inbox_id);
      if (!ref.ok) return invalid(c, ref.message);
      const inbox = await getInbox(db, {
        teamId: auth.teamId,
        idOrEmail: ref.value,
        onlyInboxId: auth.inboxId,
      });
      return inbox && (auth.domainId === null || inbox.domain_id === auth.domainId)
        ? c.json(inbox, 200)
        : notFound(c, INBOX_NOT_FOUND_MESSAGE);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/inboxes/{inbox_id}",
      summary: "Update an inbox",
      description:
        "Its name or from_name; MillionSend extension: expires_in, a new lifetime counted from now. Returns the full inbox.",
      request: {
        params: inboxIdParam,
        body: { content: { "application/json": { schema: updateInboxRequestSchema } } },
      },
      responses: {
        200: json(inboxSchema, "Inbox updated"),
        404: jsonErr("Not found"),
        422: jsonErr("Validation error"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const { inbox_id } = c.req.valid("param");
      const body = c.req.valid("json");
      if (
        body.name === undefined &&
        body.from_name === undefined &&
        body.expires_in === undefined
      ) {
        return invalid(c, "Provide at least one of name, from_name or expires_in");
      }
      if (!(await inboxFound(c, inbox_id))) return notFound(c, INBOX_NOT_FOUND_MESSAGE);
      const result = await updateInbox(db, inboxDeps(), {
        teamId: auth.teamId,
        inboxId: inbox_id,
        actor: actorOf(c),
        patch: body,
        // An API key carries no role (only owners and admins mint full-access keys); an MCP call does.
        mayShorten: auth.role === undefined || isAdminRole(auth.role),
      });
      return result.ok ? c.json(result.inbox, 200) : failure(c, result.error);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/inboxes/{inbox_id}",
      summary: "Delete an inbox",
      description:
        "Its threads, drafts, labels and the messages only it received go with it, and its address stops receiving. Its inbox-scoped API keys are revoked. Owners and admins only.",
      request: { params: inboxIdParam },
      responses: {
        200: json(removeInboxResponseSchema, "Inbox deleted"),
        403: jsonErr("Restricted API key or role"),
        404: jsonErr("Not found"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const { inbox_id } = c.req.valid("param");
      if (!(await inboxFound(c, inbox_id))) return notFound(c, INBOX_NOT_FOUND_MESSAGE);
      const deleted = await deleteInboxes(db, inboxDeps(), {
        teamId: auth.teamId,
        inboxIds: [inbox_id],
        actor: actorOf(c),
        reason: "deleted",
      });
      return deleted === 0
        ? notFound(c, INBOX_NOT_FOUND_MESSAGE)
        : c.json(
            { object: "inbox" as const, id: inbox_id.toLowerCase(), deleted: true as const },
            200,
          );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/inboxes/{inbox_id}/agent",
      summary: "Retrieve an inbox's agent settings",
      description:
        "Resend's hosted-agent settings. MillionSend runs no agent of its own, so an inbox never has one.",
      request: { params: inboxIdParam },
      responses: {
        200: json(inboxAgentResponseSchema, "No hosted agent"),
        404: jsonErr("Not found"),
      },
    }),
    async (c) => {
      if (!(await inboxFound(c, c.req.valid("param").inbox_id))) {
        return notFound(c, INBOX_NOT_FOUND_MESSAGE);
      }
      return c.json(
        { object: "inbox_agent" as const, instructions: null, tone: null, enabled_actions: [] },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/inboxes/{inbox_id}/agent",
      summary: "Update an inbox's agent settings",
      description: "Always 422: MillionSend runs no hosted agent.",
      request: {
        params: inboxIdParam,
        body: { content: { "application/json": { schema: updateInboxAgentRequestSchema } } },
      },
      responses: { 404: jsonErr("Not found"), 422: jsonErr("Not supported") },
    }),
    async (c) => {
      if (!(await inboxFound(c, c.req.valid("param").inbox_id))) {
        return notFound(c, INBOX_NOT_FOUND_MESSAGE);
      }
      return invalid(
        c,
        "Hosted agent settings are not supported; MillionSend runs no agent of its own",
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/inboxes/{inbox_id}/safety",
      summary: "Retrieve an inbox's safety rules",
      description:
        "MillionSend extension: who may write in, screening, code extraction, what the inbox may send and where it forwards.",
      request: { params: inboxIdParam },
      responses: {
        200: json(inboxSafetyResponseSchema, "Safety rules"),
        404: jsonErr("Not found"),
      },
    }),
    async (c) => {
      const { inbox_id } = c.req.valid("param");
      const safety = await ownInboxSafety(c, inbox_id);
      if (!safety) return notFound(c, INBOX_NOT_FOUND_MESSAGE);
      return c.json(
        { object: "inbox_safety" as const, inbox_id: inbox_id.toLowerCase(), ...safety },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/inboxes/{inbox_id}/safety",
      summary: "Update an inbox's safety rules",
      description:
        "MillionSend extension: any subset of the rules, merged over the stored ones. Owners and admins only; inbox-scoped keys and MCP can't change them.",
      request: {
        params: inboxIdParam,
        body: { content: { "application/json": { schema: inboxSafetyPatchBodySchema } } },
      },
      responses: {
        200: json(inboxSafetyResponseSchema, "Safety rules"),
        403: jsonErr("Restricted API key or role"),
        404: jsonErr("Not found"),
        422: jsonErr("Validation error"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const { inbox_id } = c.req.valid("param");
      if (!(await inboxFound(c, inbox_id))) return notFound(c, INBOX_NOT_FOUND_MESSAGE);
      const result = await updateInboxSafety(db, inboxDeps(), {
        teamId: auth.teamId,
        inboxId: inbox_id,
        actor: actorOf(c),
        patch: c.req.valid("json") as Partial<InboxSafety>,
      });
      if (!result.ok) return failure(c, result.error);
      return c.json(
        { object: "inbox_safety" as const, inbox_id: inbox_id.toLowerCase(), ...result.safety },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/inboxes/{inbox_id}/labels",
      summary: "List an inbox's labels",
      description: "Oldest first, every label (at most 100), unpaged.",
      request: { params: inboxIdParam },
      responses: {
        200: json(listLabelsResponseSchema, "Labels"),
        404: jsonErr("Not found"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const { inbox_id } = c.req.valid("param");
      if (!(await inboxFound(c, inbox_id))) return notFound(c, INBOX_NOT_FOUND_MESSAGE);
      return c.json(
        {
          object: "list" as const,
          data: await listLabels(db, { teamId: auth.teamId, inboxId: inbox_id }),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/inboxes/{inbox_id}/labels",
      summary: "Create a label",
      description:
        "A named, colored tag of one inbox: at most 100, names unique regardless of case. A color is picked when omitted.",
      request: {
        params: inboxIdParam,
        body: { content: { "application/json": { schema: createLabelRequestSchema } } },
      },
      responses: {
        201: json(labelResponseSchema, "Label created"),
        404: jsonErr("Not found"),
        422: jsonErr("Validation error, a duplicate name or the 100-label cap"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const { inbox_id } = c.req.valid("param");
      if (!(await inboxFound(c, inbox_id))) return notFound(c, INBOX_NOT_FOUND_MESSAGE);
      const body = c.req.valid("json");
      const result = await createLabel(db, inboxDeps(), {
        teamId: auth.teamId,
        inboxId: inbox_id,
        actor: actorOf(c),
        name: body.name,
        color: body.color,
      });
      if (!result.ok) return failure(c, result.error);
      return c.json({ object: "inbox_label" as const, ...result.label }, 201);
    },
  );

  const labelParams = inboxIdParam.extend({ label_id: z.uuid().describe("The label ID") });

  app.openapi(
    createRoute({
      method: "patch",
      path: "/inboxes/{inbox_id}/labels/{label_id}",
      summary: "Update a label",
      request: {
        params: labelParams,
        body: { content: { "application/json": { schema: updateLabelRequestSchema } } },
      },
      responses: {
        200: json(labelResponseSchema, "Label updated"),
        404: jsonErr("Not found"),
        422: jsonErr("Validation error or a duplicate name"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const { inbox_id, label_id } = c.req.valid("param");
      if (!(await inboxFound(c, inbox_id))) return notFound(c, INBOX_NOT_FOUND_MESSAGE);
      const body = c.req.valid("json");
      const result = await updateLabel(db, inboxDeps(), {
        teamId: auth.teamId,
        inboxId: inbox_id,
        labelId: label_id,
        actor: actorOf(c),
        name: body.name,
        color: body.color,
      });
      if (!result.ok) return failure(c, result.error);
      return c.json({ object: "inbox_label" as const, ...result.label }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/inboxes/{inbox_id}/labels/{label_id}",
      summary: "Delete a label",
      description: "Also takes it off every thread, with no per-thread event.",
      request: { params: labelParams },
      responses: {
        200: json(removeLabelResponseSchema, "Label deleted"),
        404: jsonErr("Not found"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const { inbox_id, label_id } = c.req.valid("param");
      if (!(await inboxFound(c, inbox_id))) return notFound(c, INBOX_NOT_FOUND_MESSAGE);
      const deleted = await deleteLabel(db, inboxDeps(), {
        teamId: auth.teamId,
        inboxId: inbox_id,
        labelId: label_id,
        actor: actorOf(c),
      });
      return deleted
        ? c.json(
            { object: "inbox_label" as const, id: label_id.toLowerCase(), deleted: true as const },
            200,
          )
        : notFound(c, `Label "${label_id}" not found.`);
    },
  );

  // Registered before /threads/{thread_id}, which would otherwise take "search" as an id.
  app.openapi(
    createRoute({
      method: "get",
      path: "/inboxes/{inbox_id}/threads/search",
      summary: "Search threads",
      description: `Threads whose emails match by subject, sender (address and display name), recipients, attachments and dates, most recently active first. Bodies and attachment names are encrypted at rest and not searched. ${untrusted}`,
      request: { params: inboxIdParam, query: searchThreadsQuerySchema },
      responses: {
        200: json(searchThreadsResponseSchema, "Matching threads"),
        403: jsonErr("include_quarantined from an inbox-scoped key"),
        404: jsonErr("Inbox, label or cursor not found"),
        422: jsonErr("Validation error"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const { inbox_id } = c.req.valid("param");
      const q = c.req.valid("query");
      const view = viewOf(c, q.include_quarantined);
      if ("refusal" in view) return failure(c, view.refusal);
      const paging = pagingOf(q, "thread");
      if (!paging.ok) return invalid(c, paging.message);
      const filters = threadFiltersOf(q);
      if (!filters.ok) return invalid(c, filters.message);
      const people: Record<"from" | "to" | "cc" | "bcc", string[] | undefined> = {
        from: undefined,
        to: undefined,
        cc: undefined,
        bcc: undefined,
      };
      for (const key of ["from", "to", "cc", "bcc"] as const) {
        const values = peopleOf(q[key], key);
        if (!values.ok) return invalid(c, values.message);
        people[key] = values.value;
      }
      const hasAttachment = booleanOf(q.has_attachment, "has_attachment");
      if (!hasAttachment.ok) return invalid(c, hasAttachment.message);
      if (!(await inboxFound(c, inbox_id))) return notFound(c, INBOX_NOT_FOUND_MESSAGE);
      const result = await searchThreads(db, {
        teamId: auth.teamId,
        inboxId: inbox_id,
        agentView: view.agentView,
        query: {
          ...paging.value,
          ...filters.value,
          ...people,
          includeHeld: view.includeHeld,
          query: q.query || undefined,
          hasAttachment: hasAttachment.value,
          startDate: q.start_date || undefined,
          endDate: q.end_date || undefined,
        },
      });
      if ("error" in result) return failure(c, result.error);
      return c.json({ object: "list" as const, has_more: result.hasMore, data: result.data }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/inboxes/{inbox_id}/threads",
      summary: "List threads",
      description: `Conversations of the inbox, most recently active first (\`after\` pages toward older ones). Threads whose messages are all held for screening or in quarantine are left out unless include_quarantined=true (never for inbox-scoped keys). ${untrusted}`,
      request: { params: inboxIdParam, query: listThreadsQuerySchema },
      responses: {
        200: json(listThreadsResponseSchema, "Threads"),
        403: jsonErr("include_quarantined from an inbox-scoped key"),
        404: jsonErr("Inbox, label or cursor not found"),
        422: jsonErr("Validation error"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const { inbox_id } = c.req.valid("param");
      const q = c.req.valid("query");
      const view = viewOf(c, q.include_quarantined);
      if ("refusal" in view) return failure(c, view.refusal);
      const paging = pagingOf(q, "thread");
      if (!paging.ok) return invalid(c, paging.message);
      const filters = threadFiltersOf(q);
      if (!filters.ok) return invalid(c, filters.message);
      if (!(await inboxFound(c, inbox_id))) return notFound(c, INBOX_NOT_FOUND_MESSAGE);
      const result = await listThreads(db, {
        teamId: auth.teamId,
        inboxId: inbox_id,
        agentView: view.agentView,
        query: { ...paging.value, ...filters.value, includeHeld: view.includeHeld },
      });
      if ("error" in result) return failure(c, result.error);
      return c.json({ object: "list" as const, has_more: result.hasMore, data: result.data }, 200);
    },
  );

  const threadParams = inboxIdParam.extend({ thread_id: z.uuid().describe("The thread ID") });

  /** "Inbox not found." or "Thread not found." for a thread the view can't see. */
  const threadMissing = async (c: Context<Env>, inboxId: string) =>
    (await inboxFound(c, inboxId))
      ? notFound(c, "Thread not found.")
      : notFound(c, INBOX_NOT_FOUND_MESSAGE);

  app.openapi(
    createRoute({
      method: "get",
      path: "/inboxes/{inbox_id}/threads/{thread_id}",
      summary: "Retrieve a thread",
      description:
        "The thread's subject, folder, labels and read state; its emails are listed apart.",
      request: { params: threadParams },
      responses: {
        200: json(threadSummarySchema, "Thread"),
        404: jsonErr("Not found"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const { inbox_id, thread_id } = c.req.valid("param");
      if (!(await inboxFound(c, inbox_id))) return notFound(c, INBOX_NOT_FOUND_MESSAGE);
      const thread = await getThread(db, {
        teamId: auth.teamId,
        inboxId: inbox_id,
        threadId: thread_id,
        agentView: isAgentActor(actorOf(c)),
      });
      return thread ? c.json(thread, 200) : threadMissing(c, inbox_id);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/inboxes/{inbox_id}/threads/{thread_id}",
      summary: "Update a thread",
      description:
        "Mark every message read or unread, move it to inbox, archive, spam or trash (moving out of trash restores it), or apply a label.",
      request: {
        params: threadParams,
        body: { content: { "application/json": { schema: updateThreadRequestSchema } } },
      },
      responses: {
        200: json(threadSummarySchema, "Thread updated"),
        404: jsonErr("Inbox, thread or label not found"),
        422: jsonErr("Validation error"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const { inbox_id, thread_id } = c.req.valid("param");
      const body = c.req.valid("json");
      if (body.read === undefined && body.folder === undefined && body.label_id === undefined) {
        return invalid(c, "Provide at least one of read, folder or label_id");
      }
      if (!(await inboxFound(c, inbox_id))) return notFound(c, INBOX_NOT_FOUND_MESSAGE);
      const result = await updateThread(db, inboxDeps(), {
        teamId: auth.teamId,
        inboxId: inbox_id,
        threadId: thread_id,
        actor: actorOf(c),
        read: body.read,
        folder: body.folder,
        labelId: body.label_id,
      });
      return result.ok ? c.json(result.thread, 200) : failure(c, result.error);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/inboxes/{inbox_id}/threads/{thread_id}",
      summary: "Delete a thread",
      description:
        "Moves it to trash, where it is deleted after 30 days; moving it out of trash restores it. deleted is false when it was in trash already.",
      request: { params: threadParams },
      responses: {
        200: json(removeThreadResponseSchema, "Thread moved to trash"),
        404: jsonErr("Not found"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const { inbox_id, thread_id } = c.req.valid("param");
      if (!(await inboxFound(c, inbox_id))) return notFound(c, INBOX_NOT_FOUND_MESSAGE);
      const result = await trashThread(db, inboxDeps(), {
        teamId: auth.teamId,
        inboxId: inbox_id,
        threadId: thread_id,
        actor: actorOf(c),
      });
      if (!result.ok) return failure(c, result.error);
      return c.json(
        { object: "inbox_thread" as const, id: thread_id.toLowerCase(), deleted: result.deleted },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/inboxes/{inbox_id}/threads/{thread_id}/emails",
      summary: "List a thread's emails",
      description: `Received and sent messages of the thread, oldest first (\`after\` pages toward newer ones), with their bodies. Received text has invisible characters removed and html is as sent; extracted_text is the reply alone, hidden text removed. Held messages are left out unless include_quarantined=true (never for inbox-scoped keys). ${untrusted}`,
      request: { params: threadParams, query: threadEmailsQuerySchema },
      responses: {
        200: json(listThreadEmailsResponseSchema, "Emails"),
        403: jsonErr("include_quarantined from an inbox-scoped key"),
        404: jsonErr("Inbox, thread or cursor not found"),
        422: jsonErr("Validation error"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const { inbox_id, thread_id } = c.req.valid("param");
      const q = c.req.valid("query");
      const view = viewOf(c, q.include_quarantined);
      if ("refusal" in view) return failure(c, view.refusal);
      const paging = pagingOf(q, "email");
      if (!paging.ok) return invalid(c, paging.message);
      if (!(await inboxFound(c, inbox_id))) return notFound(c, INBOX_NOT_FOUND_MESSAGE);
      const result = await listThreadEmails(db, keyring, {
        teamId: auth.teamId,
        inboxId: inbox_id,
        threadId: thread_id,
        query: paging.value,
        ...view,
      });
      if ("error" in result) return failure(c, result.error);
      return c.json({ object: "list" as const, has_more: result.hasMore, data: result.data }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/inboxes/{inbox_id}/threads/{thread_id}/emails/{email_id}",
      summary: "Retrieve a thread email",
      description: `One message of the thread. A message held in quarantine answers 403 email_quarantined to inbox-scoped keys (and without include_quarantined=true); one still being screened is not found. ${untrusted}`,
      request: {
        params: threadParams.extend({ email_id: z.uuid().describe("The email ID") }),
        query: z.object({ include_quarantined: threadEmailsQuerySchema.shape.include_quarantined }),
      },
      responses: {
        200: json(threadEmailSchema, "Email"),
        403: jsonErr("Quarantined, or include_quarantined from an inbox-scoped key"),
        404: jsonErr("Not found"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const { inbox_id, thread_id, email_id } = c.req.valid("param");
      const view = viewOf(c, c.req.valid("query").include_quarantined);
      if ("refusal" in view) return failure(c, view.refusal);
      if (!(await inboxFound(c, inbox_id))) return notFound(c, INBOX_NOT_FOUND_MESSAGE);
      const email = await getThreadEmail(db, keyring, {
        teamId: auth.teamId,
        inboxId: inbox_id,
        threadId: thread_id,
        emailId: email_id,
        ...view,
      });
      return "error" in email ? failure(c, email.error) : c.json(email, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/inboxes/{inbox_id}/quarantine",
      summary: "List quarantined emails",
      description:
        "MillionSend extension: the inbox's held messages, newest first, metadata only. Not for inbox-scoped keys.",
      request: { params: inboxIdParam, query: pagingQuerySchema },
      responses: {
        200: json(listQuarantinedResponseSchema, "Held messages"),
        403: jsonErr("Restricted API key"),
        404: jsonErr("Inbox or cursor not found"),
        422: jsonErr("Validation error"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const { inbox_id } = c.req.valid("param");
      const paging = pagingOf(c.req.valid("query"), "email");
      if (!paging.ok) return invalid(c, paging.message);
      if (!(await inboxFound(c, inbox_id))) return notFound(c, INBOX_NOT_FOUND_MESSAGE);
      const page = await listQuarantined(db, {
        teamId: auth.teamId,
        inboxId: inbox_id,
        query: paging.value,
      });
      if (page === "bad_cursor") return cursorNotFound(c);
      return c.json({ object: "list" as const, has_more: page.hasMore, data: page.data }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/inboxes/{inbox_id}/quarantine/{email_id}/release",
      summary: "Release a quarantined email",
      description:
        "MillionSend extension: delivers a held message to the inbox, as if it had passed screening; it is never screened again. trust_sender also adds the sender to the allowlist. Not for inbox-scoped keys.",
      request: {
        params: inboxIdParam.extend({ email_id: z.uuid().describe("The received email's ID") }),
        body: {
          content: { "application/json": { schema: releaseRequestSchema } },
          required: false,
        },
      },
      responses: {
        200: json(releaseResponseSchema, "Released"),
        403: jsonErr("Restricted API key"),
        404: jsonErr("Not found or not quarantined"),
        422: jsonErr("Validation error, or the allowlist is full"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const { inbox_id, email_id } = c.req.valid("param");
      if (!(await inboxFound(c, inbox_id))) return notFound(c, INBOX_NOT_FOUND_MESSAGE);
      const body = (c.req.valid("json") as { trust_sender?: boolean } | undefined) ?? {};
      const result = await releaseQuarantined(
        db,
        {
          enqueueWebhookDeliveries: deps.enqueueWebhookDeliveries,
          enqueueInboxForward: deps.enqueueInboxForward,
        },
        {
          teamId: auth.teamId,
          receivedEmailId: email_id,
          inboxId: inbox_id,
          actor: actorOf(c),
          trustSender: body.trust_sender === true,
        },
      );
      if (!result.ok) {
        return result.reason === "allowlist_full"
          ? invalid(c, "The inbox allowlist is full; remove an entry to trust this sender")
          : notFound(c, "No quarantined email with this id in the inbox.");
      }
      return c.json(
        {
          object: "inbox_release" as const,
          inbox_id: inbox_id.toLowerCase(),
          email_id: email_id.toLowerCase(),
          released_at: result.releasedAt.toISOString(),
          trusted_sender: result.trustedSender,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/inboxes/{inbox_id}/codes/latest",
      summary: "Retrieve the latest verification code",
      description:
        "MillionSend extension: the newest code or sign-in link in delivered mail, never from held mail or senders that failed authentication; links are never fetched. wait > 0 long-polls until one arrives (status timeout when none did). Always 200; status none when there is nothing.",
      request: { params: inboxIdParam, query: codesQuerySchema },
      responses: {
        200: json(verificationCodeResponseSchema, "The latest code, or a status saying why none"),
        404: jsonErr("Not found"),
        422: jsonErr("Validation error"),
        429: jsonErr("Too many waits at once"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const { inbox_id } = c.req.valid("param");
      const q = c.req.valid("query");
      const wait = boundedInt(q.wait, "wait", 0, 50, 0);
      if (!wait.ok) return invalid(c, wait.message);
      const maxAge = boundedInt(q.max_age, "max_age", 60, 86_400, 600);
      if (!maxAge.ok) return invalid(c, maxAge.message);
      if (!(await inboxFound(c, inbox_id))) return notFound(c, INBOX_NOT_FOUND_MESSAGE);
      const read = () =>
        latestVerificationCode(db, keyring, {
          teamId: auth.teamId,
          inboxId: inbox_id,
          from: q.from || null,
          maxAgeMs: maxAge.value * 1000,
          actor: actorOf(c),
        });
      if (wait.value === 0) return c.json(await read(), 200);
      const release = acquireWaitSlot(auth.teamId);
      if (!release) {
        c.header("retry-after", "1");
        return failure(c, {
          status: 429,
          name: "too_many_waits",
          message: "Too many requests are waiting for mail; retry in a second",
        });
      }
      try {
        const [found] = await waitForReceived<VerificationCodeWire>({
          deadlineMs: Date.now() + wait.value * 1000,
          signal: c.req.raw.signal,
          poll: async () => {
            const code = await read();
            return code.status === "none" ? [] : [code];
          },
        });
        return c.json(
          found ?? {
            object: "verification_code" as const,
            status: "timeout" as const,
            kind: null,
            code: null,
            url: null,
            link_domain_matches_sender: null,
            email_id: null,
            from: null,
            received_at: null,
            sender_trust: null,
          },
          200,
        );
      } finally {
        release();
      }
    },
  );
}
