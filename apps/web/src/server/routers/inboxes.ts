import {
  abuseJudgeConfig,
  EMAIL_METADATA_RETENTION_DAYS_DEFAULT,
  EMAIL_RETENTION_DAYS_DEFAULT,
  isCloudDeployment,
  sharedInboxDomain,
} from "@millionsend/config";
import {
  createInbox,
  createLabel,
  createSemaphore,
  DAY_MS,
  deleteDraft,
  deleteInboxes,
  deleteLabel,
  fetchEffectivePlan,
  forwardInThread,
  getDraft,
  getInbox,
  getInboxSafety,
  getInstanceSettings,
  getThread,
  INBOX_KINDS,
  type InboxSafety,
  inboxSafetyPatchSchema,
  listDrafts,
  listInboxes,
  listLabels,
  listQuarantined,
  listThreadEmails,
  listThreads,
  liveInbox,
  MOVE_FOLDERS,
  openReceivedExtracted,
  QUARANTINE_REASONS,
  rejectDraft,
  releasePreview,
  releaseQuarantined,
  replyInThread,
  searchThreads,
  sendDraft,
  sendNewFromInbox,
  THREAD_FOLDERS,
  type ThreadEmailWire,
  teamMemberEmails,
  teamSharedDomain,
  updateDraft,
  updateInbox,
  updateInboxSafety,
  updateLabel,
  updateThread,
  visibleLine,
} from "@millionsend/core";
import { LABEL_NAME_MAX } from "@millionsend/core/inbox-organize";
import { INBOX_NAME_MAX } from "@millionsend/core/inbox-username";
import { type Db, schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { and, count, desc, eq, gt, inArray, max, sql } from "drizzle-orm";
import { z } from "zod";
import { HEX_COLOR_RE } from "@/lib/hex-color";
import { fetchQuotaRow } from "../billing";
import {
  actorNames,
  inboxDeps,
  inboxFailure,
  inboxSendDeps,
  planUsage,
  releaseDeps,
  releaseFailure,
  releaseResult,
  releaser,
  sendResult,
  sharedSending,
  userActor,
} from "../inboxes";
import { getKeyring } from "../keyring";
import { beforeCursor, createdAtCursorField, cursorSchema, idPage, paginate } from "../keyset";
import { adminProcedure, receivingOnly, receivingProcedure, router } from "../trpc";
import { effectiveSetting } from "./system";

const pageInput = {
  cursor: z.uuid().optional(),
  limit: z.number().int().min(1).max(100).default(50),
};
const recipients = z.array(z.email()).max(50);
const inboxRef = { inboxId: z.uuid() };
const threadRef = { ...inboxRef, threadId: z.uuid() };
const draftRef = { ...inboxRef, draftId: z.uuid() };

/** The dashboard's lifetimes; Never is null. */
const EXPIRY_CHOICES = ["1h", "24h", "7d", "30d"] as const;

// The correlated subqueries below alias their own table and name the outer
// one in full: a one-table select renders columns unqualified, and an
// unqualified "id" inside a subquery binds to the subquery's table.

/** Message tallies the inbox list shows beside each wire item, read for one page of ids. */
async function listExtras(db: Db, teamId: string, ids: string[]) {
  const i = schema.inboxes;
  const d = schema.inboxDrafts;
  const m = schema.receivedEmailInboxes;
  const u = schema.inboxUsageDaily;
  const rows =
    ids.length === 0
      ? []
      : await db
          .select({
            id: i.id,
            forwardTo: sql<string[]>`${i.safety}->'forward_to'`,
            pendingApproval: sql<number>`(select count(*)::int from ${d} d where d.inbox_id = ${i}."id" and d.status = 'pending_approval')`,
            quarantined: sql<number>`(select count(*)::int from ${m} m where m.inbox_id = ${i}."id" and m.quarantined_at is not null and m.released_at is null)`,
            received30d: sql<number>`(select coalesce(sum(u.received), 0)::int from ${u} u where u.inbox_id = ${i}."id" and u.day > current_date - 30)`,
          })
          .from(i)
          .where(and(eq(i.teamId, teamId), inArray(i.id, ids)));
  return new Map(rows.map((row) => [row.id, row]));
}

/** A thread row's snippet: this many characters of its newest delivered message, on one line. */
const SNIPPET_CHARS = 160;
/** Seals opened at once for snippets, per process. */
const snippetSlot = createSemaphore(4);

/**
 * What a thread row shows beyond the wire item: held mail, a screening
 * warning with its scores, a draft waiting, and with `snippets` the opening
 * line of the newest delivered message.
 */
async function threadExtras<T extends { id: string }>(
  db: Db,
  teamId: string,
  items: T[],
  { snippets }: { snippets: boolean },
) {
  const th = schema.inboxThreads;
  const m = schema.receivedEmailInboxes;
  const d = schema.inboxDrafts;
  const held = sql`m.thread_id = ${th}."id" and m.quarantined_at is not null and m.released_at is null`;
  const rows =
    items.length === 0
      ? []
      : await db
          .select({
            id: th.id,
            quarantined: sql<number>`(select count(*)::int from ${m} m where ${held})`,
            quarantineReason: sql<
              string | null
            >`(select m.quarantine_reason::text from ${m} m where ${held} order by m.quarantined_at desc limit 1)`,
            injectionScore: sql<
              number | null
            >`(select max(m.injection_score)::int from ${m} m where m.thread_id = ${th}."id")`,
            phishingScore: sql<
              number | null
            >`(select max(m.phishing_score)::int from ${m} m where m.thread_id = ${th}."id")`,
            // The stored verdict, so the warning thresholds stay with the screening worker.
            suspicious: sql<boolean>`exists (select 1 from ${m} m where m.thread_id = ${th}."id" and m.verdict = 'suspicious')`,
            pendingApproval: sql<boolean>`exists (select 1 from ${d} d where d.thread_id = ${th}."id" and d.status = 'pending_approval')`,
            newestDelivered: sql<
              string | null
            >`(select m.received_email_id from ${m} m where m.thread_id = ${th}."id" and m.delivered_at is not null order by m.created_at desc, m.received_email_id desc limit 1)`,
          })
          .from(th)
          .where(
            and(
              eq(th.teamId, teamId),
              inArray(
                th.id,
                items.map((item) => item.id),
              ),
            ),
          );
  const byId = new Map(rows.map((row) => [row.id, row]));
  const lines = snippets
    ? await openingLines(
        db,
        teamId,
        rows.flatMap((row) => row.newestDelivered ?? []),
      )
    : new Map<string, string>();
  return items.map((item) => {
    const extra = byId.get(item.id);
    return {
      ...item,
      quarantined: extra?.quarantined ?? 0,
      quarantine_reason: extra?.quarantineReason ?? null,
      injection_score: extra?.injectionScore ?? null,
      phishing_score: extra?.phishingScore ?? null,
      suspicious: extra?.suspicious ?? false,
      pending_approval: extra?.pendingApproval ?? false,
      snippet: lines.get(extra?.newestDelivered ?? "") ?? null,
    };
  });
}

/**
 * The cleaned text an agent reads of each received message, as one line.
 * It opens a seal per row, so only the dashboard's thread rows ask for it,
 * never the API's. Mail carrying a code or sign-in link gets none: a list
 * shows only its kind, and reading the code is an audited read. A seal that
 * won't open, or that the content purge emptied, gives none either.
 */
async function openingLines(db: Db, teamId: string, ids: string[]): Promise<Map<string, string>> {
  const r = schema.receivedEmails;
  const rows =
    ids.length === 0
      ? []
      : await db
          .select({
            id: r.id,
            teamId: r.teamId,
            extracted: r.extracted,
            extractedKinds: r.extractedKinds,
          })
          .from(r)
          .where(and(eq(r.teamId, teamId), inArray(r.id, ids)));
  const lines = new Map<string, string>();
  await Promise.all(
    rows
      .filter((row) => row.extractedKinds.length === 0)
      .map((row) =>
        snippetSlot(async () => {
          try {
            const text = (await openReceivedExtracted(row, getKeyring()))?.text ?? "";
            const line = visibleLine(text, SNIPPET_CHARS);
            if (line) lines.set(row.id, line);
          } catch {
            // Undecryptable (corrupt ciphertext, unknown key version): the row lists without one.
          }
        }),
      ),
  );
  return lines;
}

/** The pinned rows over the list: everything received, and each catch-all domain's share. */
async function receivedOverview(db: Db, teamId: string) {
  const r = schema.receivedEmails;
  const dm = schema.domains;
  const since = new Date(Date.now() - 30 * DAY_MS);
  const [all] = await db
    .select({ received30d: count(), lastReceived: max(r.createdAt) })
    .from(r)
    .where(and(eq(r.teamId, teamId), gt(r.createdAt, since)));
  const catchAll = await db
    .select({
      domainId: dm.id,
      name: dm.name,
      received30d: sql<number>`(select count(*)::int from ${r} r where r.team_id = ${dm}."team_id" and r.catch_all and ${dm}."id" = any(r.domain_ids) and r.created_at > ${since})`,
      lastReceived:
        sql<Date | null>`(select r.created_at from ${r} r where r.team_id = ${dm}."team_id" and r.catch_all and ${dm}."id" = any(r.domain_ids) order by r.created_at desc limit 1)`.mapWith(
          r.createdAt,
        ),
    })
    .from(dm)
    .where(
      and(eq(dm.teamId, teamId), eq(dm.receivingEnabled, true), eq(dm.receivingCatchAll, true)),
    )
    .orderBy(dm.name);
  return {
    allReceived: { received30d: all?.received30d ?? 0, lastReceived: all?.lastReceived ?? null },
    catchAll,
  };
}

/**
 * Each inbound message's screening with who released it and when, named as
 * the Received page names them; both null for mail never released.
 */
async function withReleases(db: Db, teamId: string, inboxId: string, items: ThreadEmailWire[]) {
  const m = schema.receivedEmailInboxes;
  const ids = items.flatMap((item) =>
    item.direction === "inbound" && item.screening.verdict === "released" ? [item.id] : [],
  );
  const rows =
    ids.length === 0
      ? []
      : await db
          .select({ id: m.receivedEmailId, at: m.releasedAt, by: m.releasedBy })
          .from(m)
          .where(
            and(eq(m.teamId, teamId), eq(m.inboxId, inboxId), inArray(m.receivedEmailId, ids)),
          );
  const names = await actorNames(
    db,
    teamId,
    rows.map((row) => row.by ?? ""),
  );
  const released = new Map(
    rows.map((row, index) => [
      row.id,
      { released_by: names[index]?.name ?? null, released_at: row.at?.toISOString() ?? null },
    ]),
  );
  return items.map((item) =>
    item.direction === "inbound"
      ? {
          ...item,
          screening: {
            ...item.screening,
            ...(released.get(item.id) ?? { released_by: null, released_at: null }),
          },
        }
      : item,
  );
}

/** Support view: thread messages and drafts read as their envelope, never their content. */
function withoutContent<T extends { html: string | null; text: string | null }>(item: T): T {
  return {
    ...item,
    html: null,
    text: null,
    ...("extracted_text" in item ? { extracted_text: null } : {}),
  };
}

export const inboxesRouter = router({
  /** What the create dialog offers: the team's receiving domains, the shared domain, the plan's room. */
  options: receivingProcedure.query(async ({ ctx }) => {
    const dm = schema.domains;
    const domains = await ctx.db
      .select({ id: dm.id, name: dm.name })
      .from(dm)
      .where(
        and(eq(dm.teamId, ctx.teamId), eq(dm.receivingEnabled, true), eq(dm.status, "verified")),
      )
      .orderBy(dm.name);
    const shared = sharedInboxDomain();
    const subdomain = shared ? await teamSharedDomain(ctx.db, ctx.teamId) : null;
    return {
      domains,
      // The team's subdomain; the parent domain while its name review is pending.
      sharedDomain: shared ? (subdomain?.name ?? shared) : null,
      sharedSending: shared ? await sharedSending(ctx) : null,
      plan: await planUsage(ctx.db, ctx.teamId),
    };
  }),

  list: receivingProcedure
    .input(z.object({ ...pageInput, kind: z.enum(INBOX_KINDS).optional() }))
    .query(async ({ ctx, input }) => {
      const result = await listInboxes(ctx.db, {
        teamId: ctx.teamId,
        query: { limit: input.limit, after: input.cursor },
        kind: input.kind,
      });
      if (result === "bad_cursor") throw new TRPCError({ code: "NOT_FOUND" });
      const page = idPage(result);
      const extras = await listExtras(
        ctx.db,
        ctx.teamId,
        page.items.map((item) => item.id),
      );
      const first = input.cursor === undefined;
      const i = schema.inboxes;
      const kinds = first
        ? await ctx.db
            .select({ kind: i.kind, n: count() })
            .from(i)
            .where(and(eq(i.teamId, ctx.teamId), liveInbox(new Date())))
            .groupBy(i.kind)
        : [];
      return {
        nextCursor: page.nextCursor,
        items: page.items.map((item) => {
          const extra = extras.get(item.id);
          return {
            ...item,
            pending_approval: extra?.pendingApproval ?? 0,
            quarantined: extra?.quarantined ?? 0,
            received_30d: extra?.received30d ?? 0,
            forward_to: extra?.forwardTo ?? [],
          };
        }),
        // First page only, like the other lists' totals.
        counts: first
          ? {
              agent: kinds.find((k) => k.kind === "agent")?.n ?? 0,
              human: kinds.find((k) => k.kind === "human")?.n ?? 0,
            }
          : null,
        overview: first ? await receivedOverview(ctx.db, ctx.teamId) : null,
      };
    }),

  get: receivingProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
    // An expired inbox stays here, read-only, until the hourly sweep deletes
    // it; the API already answers 404 for it.
    const inbox = await getInbox(ctx.db, {
      teamId: ctx.teamId,
      idOrEmail: input.id,
      now: new Date(0),
    });
    if (!inbox) throw new TRPCError({ code: "NOT_FOUND" });
    const i = schema.inboxes;
    const u = schema.inboxUsageDaily;
    const w = schema.webhookEndpoints;
    const k = schema.apiKeys;
    const [extra] = await ctx.db
      .select({
        safety: i.safety,
        received30d: sql<number>`(select coalesce(sum(u.received), 0)::int from ${u} u where u.inbox_id = ${i}."id" and u.day > current_date - 30)`,
        webhook: sql<boolean>`exists (select 1 from ${w} w where w.team_id = ${i}."team_id" and w.status = 'enabled' and (w.inbox_ids is null or w.inbox_ids @> jsonb_build_array(${i}."id"::text)))`,
        key: sql<boolean>`exists (select 1 from ${k} k where k.inbox_id = ${i}."id" and k.revoked_at is null)`,
      })
      .from(i)
      .where(and(eq(i.id, inbox.id), eq(i.teamId, ctx.teamId)));
    if (!extra) throw new TRPCError({ code: "NOT_FOUND" });
    return {
      ...inbox,
      expired: inbox.expires_at !== null && Date.parse(inbox.expires_at) <= Date.now(),
      safety: extra.safety,
      received_30d: extra.received30d,
      channels: { webhook: extra.webhook, key: extra.key },
      sharedSending: inbox.shared ? await sharedSending(ctx) : null,
    };
  }),

  create: receivingProcedure
    .input(
      z.object({
        kind: z.enum(INBOX_KINDS),
        name: z.string().trim().max(INBOX_NAME_MAX).optional(),
        fromName: z.string().trim().max(78).optional(),
        // With domainId, the address's local part; without, the shared address's username.
        localPart: z.string().trim().toLowerCase().min(1).max(64).optional(),
        domainId: z.uuid().optional(),
        acceptFrom: z.enum(["anyone", "verified", "allowlist"]),
        expiresIn: z.enum(EXPIRY_CHOICES).nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      let emailAddress: string | undefined;
      if (input.domainId) {
        const [domain] = await ctx.db
          .select({ name: schema.domains.name, receiving: schema.domains.receivingEnabled })
          .from(schema.domains)
          .where(and(eq(schema.domains.id, input.domainId), eq(schema.domains.teamId, ctx.teamId)));
        if (!domain) throw new TRPCError({ code: "NOT_FOUND" });
        if (!domain.receiving) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "not_receiving" });
        }
        if (!input.localPart) throw new TRPCError({ code: "BAD_REQUEST" });
        emailAddress = `${input.localPart}@${domain.name}`;
      }
      const result = await createInbox(ctx.db, inboxDeps(ctx), {
        teamId: ctx.teamId,
        plan: (await fetchEffectivePlan(ctx.db, ctx.teamId)) ?? "free",
        isCloud: isCloudDeployment(),
        actor: userActor(ctx),
        input: {
          email_address: emailAddress,
          username: input.domainId ? undefined : input.localPart,
          name: input.name || undefined,
          from_name: input.fromName || undefined,
          kind: input.kind,
          expires_in: input.expiresIn,
          safety: { accept_from: input.acceptFrom },
        },
      });
      if (!result.ok) throw inboxFailure(result.error);
      return result.inbox;
    }),

  update: receivingProcedure
    .input(
      z.object({
        id: z.uuid(),
        name: z.string().trim().min(1).max(INBOX_NAME_MAX).optional(),
        fromName: z.string().trim().max(78).optional(),
        expiresIn: z.enum(EXPIRY_CHOICES).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await updateInbox(ctx.db, inboxDeps(ctx), {
        teamId: ctx.teamId,
        inboxId: input.id,
        actor: userActor(ctx),
        patch: { name: input.name, from_name: input.fromName, expires_in: input.expiresIn },
        mayShorten: ctx.role === "owner" || ctx.role === "admin",
      });
      if (!result.ok) throw inboxFailure(result.error);
      return result.inbox;
    }),

  delete: adminProcedure
    .use(receivingOnly)
    .input(z.object({ id: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const deleted = await deleteInboxes(ctx.db, inboxDeps(ctx), {
        teamId: ctx.teamId,
        inboxIds: [input.id],
        actor: userActor(ctx),
        reason: "deleted",
      });
      if (deleted === 0) throw new TRPCError({ code: "NOT_FOUND" });
      return { id: input.id };
    }),

  safety: receivingProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
    const safety = await getInboxSafety(ctx.db, { teamId: ctx.teamId, inboxId: input.id });
    if (!safety) throw new TRPCError({ code: "NOT_FOUND" });
    const members = await teamMemberEmails(ctx.db, ctx.teamId);
    const stored = await getInstanceSettings(ctx.db);
    return {
      safety,
      // forward_to may name these, besides the owner addresses.
      memberEmails: members.sort(),
      // Bodies go on the first clock and whole rows on the second, so mail lasts the shorter.
      retentionDays: Math.min(
        effectiveSetting(
          stored.emailRetentionDays,
          process.env.EMAIL_RETENTION_DAYS,
          EMAIL_RETENTION_DAYS_DEFAULT,
        ).value,
        effectiveSetting(
          null,
          process.env.EMAIL_METADATA_RETENTION_DAYS,
          EMAIL_METADATA_RETENTION_DAYS_DEFAULT,
        ).value,
      ),
    };
  }),

  updateSafety: adminProcedure
    .use(receivingOnly)
    .input(z.object({ id: z.uuid(), patch: z.record(z.string(), z.unknown()) }))
    .mutation(async ({ ctx, input }) => {
      // Parsed here rather than as the input schema, so a bad entry answers
      // with its own message instead of the schema's issue list.
      const patch = inboxSafetyPatchSchema.safeParse(input.patch);
      if (!patch.success) {
        throw new TRPCError({
          code: "UNPROCESSABLE_CONTENT",
          message: patch.error.issues[0]?.message ?? "Invalid safety rules",
        });
      }
      const result = await updateInboxSafety(ctx.db, inboxDeps(ctx), {
        teamId: ctx.teamId,
        inboxId: input.id,
        actor: userActor(ctx),
        // .partial() types an absent key as undefined; the stored rules take no such key.
        patch: Object.fromEntries(
          Object.entries(patch.data).filter(([, value]) => value !== undefined),
        ) as Partial<InboxSafety>,
        plan: (await fetchEffectivePlan(ctx.db, ctx.teamId)) ?? "free",
        isCloud: isCloudDeployment(),
      });
      if (!result.ok) throw inboxFailure(result.error);
      return result.safety;
    }),

  threads: router({
    list: receivingProcedure.input(z.object(threadListInput())).query(async ({ ctx, input }) => {
      const result = await listThreads(ctx.db, {
        teamId: ctx.teamId,
        inboxId: input.inboxId,
        query: threadQuery(input),
        agentView: false,
      });
      if ("error" in result) throw inboxFailure(result.error);
      const page = idPage(result);
      return {
        ...page,
        items: await threadExtras(ctx.db, ctx.teamId, page.items, { snippets: !ctx.supportView }),
      };
    }),

    search: receivingProcedure
      .input(z.object({ ...threadListInput(), query: z.string().trim().min(1).max(256) }))
      .query(async ({ ctx, input }) => {
        const result = await searchThreads(ctx.db, {
          teamId: ctx.teamId,
          inboxId: input.inboxId,
          query: { ...threadQuery(input), query: input.query },
          agentView: false,
        });
        if ("error" in result) throw inboxFailure(result.error);
        const page = idPage(result);
        return {
          ...page,
          items: await threadExtras(ctx.db, ctx.teamId, page.items, { snippets: !ctx.supportView }),
        };
      }),

    get: receivingProcedure.input(z.object(threadRef)).query(async ({ ctx, input }) => {
      const thread = await getThread(ctx.db, {
        teamId: ctx.teamId,
        inboxId: input.inboxId,
        threadId: input.threadId,
        agentView: false,
      });
      if (!thread) throw new TRPCError({ code: "NOT_FOUND" });
      return thread;
    }),

    emails: receivingProcedure
      .input(z.object({ ...threadRef, ...pageInput }))
      .query(async ({ ctx, input }) => {
        const envelopeOnly = Boolean(ctx.supportView);
        const result = await listThreadEmails(ctx.db, getKeyring(), {
          teamId: ctx.teamId,
          inboxId: input.inboxId,
          threadId: input.threadId,
          query: { limit: input.limit, after: input.cursor },
          agentView: false,
          includeHeld: true,
          envelopeOnly,
          // The pane renders the HTML, where a cid: reference could never load.
          inlineImages: true,
        });
        if ("error" in result) throw inboxFailure(result.error);
        const page = idPage(result);
        const items = await withReleases(ctx.db, ctx.teamId, input.inboxId, page.items);
        return { ...page, items: envelopeOnly ? items.map(withoutContent) : items };
      }),

    update: receivingProcedure
      .input(
        z.object({
          ...threadRef,
          read: z.boolean().optional(),
          folder: z.enum(MOVE_FOLDERS).optional(),
          labelId: z.uuid().optional(),
          removeLabelId: z.uuid().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const result = await updateThread(ctx.db, inboxDeps(ctx), {
          teamId: ctx.teamId,
          inboxId: input.inboxId,
          threadId: input.threadId,
          actor: userActor(ctx),
          read: input.read,
          folder: input.folder,
          labelId: input.labelId,
          removeLabelId: input.removeLabelId,
        });
        if (!result.ok) throw inboxFailure(result.error);
        return result.thread;
      }),
  }),

  labels: router({
    list: receivingProcedure
      .input(z.object(inboxRef))
      .query(({ ctx, input }) =>
        listLabels(ctx.db, { teamId: ctx.teamId, inboxId: input.inboxId }),
      ),

    create: receivingProcedure
      .input(
        z.object({
          ...inboxRef,
          name: z.string().trim().min(1).max(LABEL_NAME_MAX),
          color: z.string().regex(HEX_COLOR_RE).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const result = await createLabel(ctx.db, inboxDeps(ctx), {
          teamId: ctx.teamId,
          inboxId: input.inboxId,
          actor: userActor(ctx),
          name: input.name,
          color: input.color,
        });
        if (!result.ok) throw inboxFailure(result.error);
        return result.label;
      }),

    update: receivingProcedure
      .input(
        z.object({
          ...inboxRef,
          labelId: z.uuid(),
          name: z.string().trim().min(1).max(LABEL_NAME_MAX).optional(),
          color: z.string().regex(HEX_COLOR_RE).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const result = await updateLabel(ctx.db, inboxDeps(ctx), {
          teamId: ctx.teamId,
          inboxId: input.inboxId,
          labelId: input.labelId,
          actor: userActor(ctx),
          name: input.name,
          color: input.color?.toUpperCase(),
        });
        if (!result.ok) throw inboxFailure(result.error);
        return result.label;
      }),

    delete: receivingProcedure
      .input(z.object({ ...inboxRef, labelId: z.uuid() }))
      .mutation(async ({ ctx, input }) => {
        const deleted = await deleteLabel(ctx.db, inboxDeps(ctx), {
          teamId: ctx.teamId,
          inboxId: input.inboxId,
          labelId: input.labelId,
          actor: userActor(ctx),
        });
        if (!deleted) throw new TRPCError({ code: "NOT_FOUND" });
        return { id: input.labelId };
      }),
  }),

  drafts: router({
    list: receivingProcedure
      .input(z.object({ ...inboxRef, ...pageInput }))
      .query(async ({ ctx, input }) => {
        const result = await listDrafts(ctx.db, {
          teamId: ctx.teamId,
          inboxId: input.inboxId,
          query: { limit: input.limit, after: input.cursor },
        });
        if (result === "bad_cursor") throw new TRPCError({ code: "NOT_FOUND" });
        // A snippet is the body's opening: content, like the draft itself.
        const page = idPage(result);
        return ctx.supportView
          ? { ...page, items: page.items.map((item) => ({ ...item, snippet: null })) }
          : page;
      }),

    get: receivingProcedure.input(z.object(draftRef)).query(async ({ ctx, input }) => {
      const draft = await getDraft(ctx.db, getKeyring(), {
        teamId: ctx.teamId,
        inboxId: input.inboxId,
        draftId: input.draftId,
      });
      if (!draft) throw new TRPCError({ code: "NOT_FOUND" });
      return ctx.supportView ? withoutContent(draft) : draft;
    }),

    update: receivingProcedure
      .input(
        z.object({
          ...draftRef,
          patch: z
            .object({
              to: recipients,
              cc: recipients,
              bcc: recipients,
              subject: z.string().max(2000),
              text: z.string().max(1_000_000),
            })
            .partial(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const result = await updateDraft(ctx.db, inboxSendDeps(ctx), {
          teamId: ctx.teamId,
          inboxId: input.inboxId,
          draftId: input.draftId,
          actor: userActor(ctx),
          patch: input.patch,
        });
        if (!result.ok) throw inboxFailure(result.error);
        return result.draft;
      }),

    delete: receivingProcedure.input(z.object(draftRef)).mutation(async ({ ctx, input }) => {
      const result = await deleteDraft(ctx.db, inboxSendDeps(ctx), {
        teamId: ctx.teamId,
        inboxId: input.inboxId,
        draftId: input.draftId,
        actor: userActor(ctx),
      });
      if (!result.ok) throw inboxFailure(result.error);
      return { id: input.draftId };
    }),

    approve: receivingProcedure.input(z.object(draftRef)).mutation(async ({ ctx, input }) =>
      sendResult(
        await sendDraft(ctx.db, inboxSendDeps(ctx), {
          teamId: ctx.teamId,
          billing: await fetchQuotaRow(ctx.db, ctx.teamId),
          actor: userActor(ctx),
          inboxId: input.inboxId,
          draftId: input.draftId,
        }),
      ),
    ),

    reject: receivingProcedure.input(z.object(draftRef)).mutation(async ({ ctx, input }) => {
      const result = await rejectDraft(ctx.db, inboxSendDeps(ctx), {
        teamId: ctx.teamId,
        inboxId: input.inboxId,
        draftId: input.draftId,
        actor: userActor(ctx),
      });
      if (!result.ok) throw inboxFailure(result.error);
      return result.draft;
    }),
  }),

  send: receivingProcedure
    .input(
      z.object({
        ...inboxRef,
        to: recipients.min(1),
        cc: recipients.optional(),
        bcc: recipients.optional(),
        subject: z.string().trim().min(1).max(2000),
        html: z.string().max(1_000_000).optional(),
        text: z.string().min(1).max(1_000_000),
      }),
    )
    .mutation(async ({ ctx, input }) =>
      sendResult(
        await sendNewFromInbox(ctx.db, inboxSendDeps(ctx), {
          teamId: ctx.teamId,
          billing: await fetchQuotaRow(ctx.db, ctx.teamId),
          actor: userActor(ctx),
          inboxId: input.inboxId,
          message: {
            to: input.to,
            cc: input.cc,
            bcc: input.bcc,
            subject: input.subject,
            html: input.html,
            text: input.text,
          },
        }),
      ),
    ),

  reply: receivingProcedure
    .input(
      z.object({
        ...threadRef,
        emailId: z.uuid(),
        html: z.string().max(1_000_000).optional(),
        text: z.string().min(1).max(1_000_000),
        replyAll: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) =>
      sendResult(
        await replyInThread(ctx.db, inboxSendDeps(ctx), {
          teamId: ctx.teamId,
          billing: await fetchQuotaRow(ctx.db, ctx.teamId),
          actor: userActor(ctx),
          inboxId: input.inboxId,
          threadId: input.threadId,
          emailId: input.emailId,
          body: { html: input.html, text: input.text, reply_all: input.replyAll },
        }),
      ),
    ),

  forward: receivingProcedure
    .input(
      z.object({
        ...threadRef,
        emailId: z.uuid(),
        to: recipients.min(1),
        text: z.string().max(1_000_000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) =>
      sendResult(
        await forwardInThread(ctx.db, inboxSendDeps(ctx), {
          teamId: ctx.teamId,
          billing: await fetchQuotaRow(ctx.db, ctx.teamId),
          actor: userActor(ctx),
          inboxId: input.inboxId,
          threadId: input.threadId,
          emailId: input.emailId,
          body: { to: input.to, text: input.text || undefined },
        }),
      ),
    ),

  quarantine: router({
    list: receivingProcedure
      .input(z.object({ ...inboxRef, ...pageInput }))
      .query(async ({ ctx, input }) => {
        const result = await listQuarantined(ctx.db, {
          teamId: ctx.teamId,
          inboxId: input.inboxId,
          query: { limit: input.limit, after: input.cursor },
        });
        if (result === "bad_cursor") throw new TRPCError({ code: "NOT_FOUND" });
        return idPage(result);
      }),

    /** What the release dialog shows; inboxId null for a catch-all row held for a virus. */
    preview: receivingProcedure
      .input(z.object({ inboxId: z.uuid().nullable(), emailId: z.uuid() }))
      .query(async ({ ctx, input }) => {
        const preview = await releasePreview(ctx.db, getKeyring(), {
          teamId: ctx.teamId,
          inboxId: input.inboxId,
          receivedEmailId: input.emailId,
          ...releaser(ctx),
          judgeConfigured: abuseJudgeConfig() !== null,
          withText: !ctx.supportView,
        });
        if (typeof preview === "string") throw releaseFailure(preview);
        return preview;
      }),

    release: receivingProcedure
      .input(
        z.object({
          ...inboxRef,
          emailId: z.uuid(),
          trustSender: z.boolean().default(false),
          /** The hold the dialog showed: one changed since answers held_again. */
          reviewed: z.enum(QUARANTINE_REASONS).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) =>
        releaseResult(
          await releaseQuarantined(ctx.db, releaseDeps(ctx), {
            teamId: ctx.teamId,
            receivedEmailId: input.emailId,
            inboxId: input.inboxId,
            ...releaser(ctx),
            reviewed: input.reviewed,
            trustSender: input.trustSender,
          }),
        ),
      ),
  }),

  activity: router({
    list: receivingProcedure
      .input(
        z.object({
          ...inboxRef,
          cursor: cursorSchema.optional(),
          limit: z.number().int().min(1).max(100).default(50),
        }),
      )
      .query(async ({ ctx, input }) => {
        const a = schema.inboxActivity;
        const rows = await ctx.db
          .select({
            id: a.id,
            actor: a.actor,
            action: a.action,
            threadId: a.threadId,
            emailId: a.emailId,
            draftId: a.draftId,
            decision: a.decision,
            createdAt: a.createdAt,
            cursorCreatedAt: createdAtCursorField(a),
          })
          .from(a)
          .where(
            and(
              eq(a.teamId, ctx.teamId),
              eq(a.inboxId, input.inboxId),
              input.cursor ? beforeCursor(a, input.cursor) : undefined,
            ),
          )
          .orderBy(desc(a.createdAt), desc(a.id))
          .limit(input.limit + 1);
        const page = paginate(rows, input.limit);
        const actors = await actorNames(
          ctx.db,
          ctx.teamId,
          page.items.map((row) => row.actor),
        );
        return {
          nextCursor: page.nextCursor,
          items: page.items.map((row, index) => ({
            ...row,
            actor: actors[index] ?? { kind: "system" as const, name: null },
          })),
        };
      }),
  }),
});

function threadListInput() {
  return {
    ...inboxRef,
    ...pageInput,
    folders: z.array(z.enum(THREAD_FOLDERS)).max(5).optional(),
    labels: z.array(z.uuid()).max(50).optional(),
    read: z.boolean().optional(),
  };
}

function threadQuery(input: {
  folders?: (typeof THREAD_FOLDERS)[number][] | undefined;
  labels?: string[] | undefined;
  read?: boolean | undefined;
  limit: number;
  cursor?: string | undefined;
}) {
  return {
    folders: input.folders,
    labels: input.labels,
    read: input.read,
    limit: input.limit,
    after: input.cursor,
    includeHeld: true,
  };
}
