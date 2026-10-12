import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, asc, count, eq, inArray, isNotNull, isNull, lte, type SQL, sql } from "drizzle-orm";
import { simpleParser } from "mailparser";
import { createSemaphore } from "../concurrency.js";
import { decryptEmailBody, openAttachments } from "../crypto/envelope.js";
import type { Keyring } from "../crypto/keyring.js";
import { dropInvisible } from "../customer-text.js";
import { resultRows } from "../driver-result.js";
import { escapeRegex } from "../erase-recipient.js";
import {
  openReceivedAttachments,
  openReceivedExtracted,
  openReceivedRaw,
  RECEIVED_EMAIL_META_COLUMNS,
  type ReceivedEmailRow,
} from "../receiving/message.js";
import { formatMailbox } from "../sender-address.js";
import { DAY_MS } from "../utc-day.js";
import { type InboxActor, isAgentActor, recordInboxActivity, webhookSource } from "./activity.js";
import { threadFolderEvent, threadLabelsEvent } from "./events.js";
import {
  CURSOR_NOT_FOUND,
  findLiveInbox,
  INBOX_NOT_FOUND,
  invalid,
  isInboxError,
  keysetRows,
  labelNotFound,
  notFound,
  webhookBatch,
} from "./inbox-common.js";
import type { InboxDeps } from "./inboxes.js";
import { TRASH_RETENTION } from "./limits.js";
import {
  EMAIL_QUARANTINED_MESSAGE,
  type InboxError,
  type ListQuery,
  type MoveFolder,
  type ThreadEmailWire,
  type ThreadFolder,
  type ThreadLabelWire,
  type ThreadListItemWire,
  type ThreadSearchHighlightKey,
  type ThreadSearchResultWire,
  type ThreadSummaryWire,
} from "./types.js";
import {
  inboundThreadEmailWire,
  type MessageContent,
  outboundThreadEmailWire,
  threadLabelWire,
  threadSummaryWire,
} from "./wire.js";

export interface ThreadListQuery {
  folders?: ThreadFolder[] | undefined;
  labels?: string[] | undefined;
  read?: boolean | undefined;
  limit?: number | undefined;
  after?: string | undefined;
  before?: string | undefined;
  /** Owner views only: threads whose messages are all held. */
  includeHeld?: boolean | undefined;
}

export interface ThreadSearchQuery extends ThreadListQuery {
  query?: string | undefined;
  from?: string[] | undefined;
  to?: string[] | undefined;
  cc?: string[] | undefined;
  bcc?: string[] | undefined;
  hasAttachment?: boolean | undefined;
  startDate?: string | undefined;
  endDate?: string | undefined;
}

const th = schema.inboxThreads;
const m = schema.receivedEmailInboxes;
const r = schema.receivedEmails;
const e = schema.emails;
const l = schema.inboxLabels;
const tl = schema.inboxThreadLabels;

type ThreadRow = typeof th.$inferSelect;
type InboxRow = typeof schema.inboxes.$inferSelect;

const THREAD_NOT_FOUND = notFound("Thread not found.");
const EMAIL_NOT_FOUND = notFound("Email not found.");
const EMAIL_QUARANTINED: InboxError = {
  status: 403,
  name: "email_quarantined",
  message: EMAIL_QUARANTINED_MESSAGE,
};

const QUERY_MAX_CHARS = 256;
const QUERY_MAX_WORDS = 32;
/** Search covers this many threads, those with the newest matching email (Resend's limit). */
const SEARCH_THREADS_MAX = 10_000;
const PURGE_BATCH = 1000;

/**
 * Received messages decrypted and parsed at once per process for thread
 * reads: each can hold a 40 MiB message several times over.
 */
// ponytail: per process; a shared queue if several API replicas parse at once.
const contentSlot = createSemaphore(4);

/** A membership counts when delivered (or released); owners may also count held ones. */
const counted = (includeHeld: boolean): SQL =>
  includeHeld ? sql`true` : sql`${m.deliveredAt} is not null`;

/** A thread holding at least one message the view may see. */
const hasMessage = (includeHeld: boolean): SQL =>
  sql`(exists (select 1 from ${m} where ${m.threadId} = ${th.id} and ${counted(includeHeld)}) or exists (select 1 from ${e} where ${e.threadId} = ${th.id}))`;

const hasUnread = sql`exists (select 1 from ${m} where ${m.threadId} = ${th.id} and ${m.readAt} is null and ${m.deliveredAt} is not null)`;

async function findThread(
  db: Db,
  p: { teamId: string; inboxId: string; threadId: string; agentView: boolean },
): Promise<ThreadRow | undefined> {
  const [row] = await db
    .select()
    .from(th)
    .where(
      and(
        eq(th.id, p.threadId),
        eq(th.inboxId, p.inboxId),
        eq(th.teamId, p.teamId),
        p.agentView ? hasMessage(false) : undefined,
      ),
    );
  return row;
}

async function threadLabels(db: Db, threadIds: string[]): Promise<Map<string, ThreadLabelWire[]>> {
  const out = new Map<string, ThreadLabelWire[]>();
  if (threadIds.length === 0) return out;
  const rows = await db
    .select({ threadId: tl.threadId, id: l.id, name: l.name, color: l.color })
    .from(tl)
    .innerJoin(l, eq(l.id, tl.labelId))
    .where(inArray(tl.threadId, threadIds))
    .orderBy(asc(tl.createdAt), asc(l.name));
  for (const row of rows)
    out.set(row.threadId, [...(out.get(row.threadId) ?? []), threadLabelWire(row)]);
  return out;
}

/** The summary a view reads; held counts are for owners only. */
async function summaryOf(db: Db, row: ThreadRow, agentView: boolean): Promise<ThreadSummaryWire> {
  const [labels, [unread], [held]] = await Promise.all([
    threadLabels(db, [row.id]),
    db
      .select({ n: count() })
      .from(m)
      .where(and(eq(m.threadId, row.id), isNull(m.readAt), isNotNull(m.deliveredAt))),
    agentView
      ? [{ n: 0 }]
      : db
          .select({ n: count() })
          .from(m)
          .where(and(eq(m.threadId, row.id), isNotNull(m.quarantinedAt), isNull(m.releasedAt))),
  ]);
  return threadSummaryWire(row, {
    labels: labels.get(row.id) ?? [],
    read: (unread?.n ?? 0) === 0,
    quarantined: held?.n ?? 0,
  });
}

/** A thread as its owners read it, or null once it is gone. */
export async function threadSummaryOf(db: Db, threadId: string): Promise<ThreadSummaryWire | null> {
  const [row] = await db.select().from(th).where(eq(th.id, threadId));
  return row ? summaryOf(db, row, false) : null;
}

/** Lowercased label ids, or the 404 of the first one the inbox lacks. */
async function knownLabels(
  db: Db,
  inboxId: string,
  ids: readonly string[],
): Promise<string[] | InboxError> {
  const wanted = [...new Set(ids.map((id) => id.toLowerCase()))];
  if (wanted.length === 0) return [];
  const found = new Set(
    (
      await db
        .select({ id: l.id })
        .from(l)
        .where(and(eq(l.inboxId, inboxId), inArray(l.id, wanted)))
    ).map((row) => row.id),
  );
  const missing = ids.find((id) => !found.has(id.toLowerCase()));
  return missing === undefined ? wanted : labelNotFound(missing);
}

/** The thread-level filters list and search share: folders, labels, read state, visibility. */
async function threadScope(
  db: Db,
  p: { teamId: string; inboxId: string; query: ThreadListQuery; includeHeld: boolean },
): Promise<SQL | InboxError> {
  const labels = await knownLabels(db, p.inboxId, p.query.labels ?? []);
  if (isInboxError(labels)) return labels;
  const folders =
    p.query.folders && p.query.folders.length > 0
      ? p.query.folders
      : labels.length > 0
        ? (["inbox", "archive", "sent"] as const)
        : (["inbox"] as const);
  return and(
    eq(th.inboxId, p.inboxId),
    eq(th.teamId, p.teamId),
    inArray(th.folder, [...folders]),
    labels.length > 0
      ? sql`exists (select 1 from ${tl} where ${tl.threadId} = ${th.id} and ${inArray(tl.labelId, labels)})`
      : undefined,
    p.query.read === undefined ? undefined : p.query.read ? sql`not ${hasUnread}` : hasUnread,
    hasMessage(p.includeHeld),
  ) as SQL;
}

/** Keyset paging over threads, most recently active first. */
function threadPage<R>(
  db: Db,
  p: { inboxId: string; query: ListQuery },
  load: (where: SQL | undefined, orderBy: SQL[], take: number) => Promise<R[]>,
) {
  return keysetRows({
    query: p.query,
    key: th.lastMessageAt,
    id: th.id,
    newestFirst: true,
    cursorExists: async (id) =>
      (
        await db
          .select({ id: th.id })
          .from(th)
          .where(and(eq(th.id, id), eq(th.inboxId, p.inboxId)))
      ).length > 0,
    cursorKey: (id) => sql`(select ${th.lastMessageAt} from ${th} where ${th.id} = ${id}::uuid)`,
    load,
  });
}

/** Thread list rows: counts, the latest message's recipients, the latest sender. */
async function listItems(
  db: Db,
  p: { teamId: string; inbox: InboxRow; rows: ThreadRow[]; includeHeld: boolean },
): Promise<ThreadListItemWire[]> {
  const ids = p.rows.map((row) => row.id);
  if (ids.length === 0) return [];
  const inCounted = counted(p.includeHeld);
  const [inbound, outbound, latest, senders, labels, drafts] = await Promise.all([
    db
      .select({
        threadId: m.threadId,
        n: sql<number>`(count(*) filter (where ${inCounted}))::int`,
        attachment: sql<boolean>`coalesce(bool_or(${r.attachmentCount} > 0) filter (where ${inCounted}), false)`,
        unread: sql<boolean>`coalesce(bool_or(${m.readAt} is null and ${m.deliveredAt} is not null), false)`,
      })
      .from(m)
      .innerJoin(r, eq(r.id, m.receivedEmailId))
      .where(inArray(m.threadId, ids))
      .groupBy(m.threadId),
    db
      .select({
        threadId: e.threadId,
        n: count(),
        attachment: sql<boolean>`bool_or(${e.attachments} is not null)`,
      })
      .from(e)
      .where(and(inArray(e.threadId, ids), eq(e.teamId, p.teamId)))
      .groupBy(e.threadId),
    db
      .execute(
        sql`select distinct on (x.thread_id) x.thread_id, x.to_list, x.cc_list, x.bcc_list from (
          select ${m.threadId} as thread_id, ${r.createdAt} as at, ${r.id} as id,
                 ${r.to} as to_list, ${r.cc} as cc_list, ${r.bcc} as bcc_list
            from ${m} join ${r} on ${r.id} = ${m.receivedEmailId}
           where ${inArray(m.threadId, ids)} and ${inCounted}
          union all
          select ${e.threadId}, ${e.createdAt}, ${e.id}, ${e.to},
                 coalesce(${e.cc}, '[]'::jsonb), coalesce(${e.bcc}, '[]'::jsonb)
            from ${e}
           where ${inArray(e.threadId, ids)} and ${e.teamId} = ${p.teamId}::uuid
        ) x order by x.thread_id, x.at desc, x.id desc`,
      )
      .then((res) =>
        resultRows<{ thread_id: string; to_list: string[]; cc_list: string[]; bcc_list: string[] }>(
          res,
        ),
      ),
    db
      .execute(
        sql`select distinct on (${m.threadId}) ${m.threadId} as thread_id,
                   ${r.from} as sender, ${r.fromName} as sender_name
              from ${m} join ${r} on ${r.id} = ${m.receivedEmailId}
             where ${inArray(m.threadId, ids)} and ${inCounted}
             order by ${m.threadId}, ${r.createdAt} desc, ${r.id} desc`,
      )
      .then((res) => resultRows<{ thread_id: string; sender: string; sender_name: string }>(res)),
    threadLabels(db, ids),
    db
      .selectDistinct({ threadId: schema.inboxDrafts.threadId })
      .from(schema.inboxDrafts)
      .where(
        and(
          inArray(schema.inboxDrafts.threadId, ids),
          inArray(schema.inboxDrafts.status, ["draft", "pending_approval"]),
        ),
      ),
  ]);
  const inboundOf = new Map(inbound.map((row) => [row.threadId, row]));
  const outboundOf = new Map(outbound.map((row) => [row.threadId, row]));
  const latestOf = new Map(latest.map((row) => [row.thread_id, row]));
  const senderOf = new Map(senders.map((row) => [row.thread_id, row]));
  const withDraft = new Set(drafts.map((row) => row.threadId));
  const inboxFrom = formatMailbox({
    name: p.inbox.fromName ?? undefined,
    address: p.inbox.emailAddress,
  });
  return p.rows.map((row) => {
    const received = inboundOf.get(row.id);
    const sent = outboundOf.get(row.id);
    const last = latestOf.get(row.id);
    const sender = senderOf.get(row.id);
    return {
      id: row.id,
      subject: row.subject === "" ? null : row.subject,
      from: sender
        ? formatMailbox({ name: sender.sender_name, address: sender.sender })
        : inboxFrom,
      to: last?.to_list ?? [],
      cc: last?.cc_list ?? [],
      bcc: last?.bcc_list ?? [],
      labels: labels.get(row.id) ?? [],
      message_count: (received?.n ?? 0) + (sent?.n ?? 0),
      has_attachment: Boolean(received?.attachment) || Boolean(sent?.attachment),
      has_draft: withDraft.has(row.id),
      read: !received?.unread,
      received_at: row.lastMessageAt.toISOString(),
      folder: row.folder,
    };
  });
}

/**
 * An inbox's threads, most recently active first. Agent views (and owner
 * views without includeHeld) never list a thread whose messages are all
 * held for screening or quarantine.
 */
export async function listThreads(
  db: Db,
  p: { teamId: string; inboxId: string; query: ThreadListQuery; agentView: boolean },
): Promise<{ data: ThreadListItemWire[]; hasMore: boolean } | { error: InboxError }> {
  const inbox = await findLiveInbox(db, p.teamId, p.inboxId);
  if (!inbox) return { error: INBOX_NOT_FOUND };
  const includeHeld = !p.agentView && Boolean(p.query.includeHeld);
  const scope = await threadScope(db, { ...p, includeHeld });
  if (isInboxError(scope)) return { error: scope };
  const page = await threadPage(db, p, (where, orderBy, take) =>
    db
      .select()
      .from(th)
      .where(and(scope, where))
      .orderBy(...orderBy)
      .limit(take),
  );
  if (page === "bad_cursor") return { error: CURSOR_NOT_FOUND };
  return {
    data: await listItems(db, { teamId: p.teamId, inbox, rows: page.rows, includeHeld }),
    hasMore: page.hasMore,
  };
}

interface SearchTerms {
  include: string[];
  exclude: string[];
}

/** Every word must match; "a phrase" matches as written; -word and -"a phrase" exclude. */
function searchTerms(query: string): SearchTerms | InboxError {
  if (query.length > QUERY_MAX_CHARS) {
    return invalid(
      `The \`query\` parameter must be at most ${QUERY_MAX_CHARS} characters, but received ${query.length}.`,
    );
  }
  const words = query.split(/\s+/).filter(Boolean).length;
  if (words > QUERY_MAX_WORDS) {
    return invalid(
      `The \`query\` parameter must contain at most ${QUERY_MAX_WORDS} words, but received ${words}.`,
    );
  }
  const terms: SearchTerms = { include: [], exclude: [] };
  for (const [, phraseNot, phrase, wordNot, word] of query.matchAll(/(-?)"([^"]*)"|(-?)(\S+)/g)) {
    const term = (phrase ?? word ?? "").replaceAll('"', "").trim();
    if (term) (phraseNot || wordNot ? terms.exclude : terms.include).push(term);
  }
  return terms;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?$/i;

/**
 * A search date as the instant it starts (start_date) or the instant after
 * it ends (end_date, exclusive): a date covers its whole UTC day, a
 * timestamp is used as given, UTC unless it has an offset.
 */
function dateBound(value: string, key: "start_date" | "end_date"): Date | InboxError {
  const bad = invalid(`The \`${key}\` must be a valid ISO 8601 date.`);
  if (DATE_ONLY.test(value)) {
    const day = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(day.getTime()) || !day.toISOString().startsWith(value)) return bad;
    return key === "end_date" ? new Date(day.getTime() + DAY_MS) : day;
  }
  const match = TIMESTAMP.exec(value);
  if (!match) return bad;
  const at = new Date(match[1] ? value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2") : `${value}Z`);
  if (Number.isNaN(at.getTime())) return bad;
  return key === "end_date" ? new Date(at.getTime() + 1) : at;
}

/** `**match**` markers around every hit of the include terms, longest terms first. */
function highlightsOf(
  fields: Record<ThreadSearchHighlightKey, string[]>,
  include: string[],
): Partial<Record<ThreadSearchHighlightKey, string[]>> {
  if (include.length === 0) return {};
  const terms = [...include].sort((a, b) => b.length - a.length).map(escapeRegex);
  const hit = new RegExp(terms.join("|"), "giu");
  const out: Partial<Record<ThreadSearchHighlightKey, string[]>> = {};
  for (const key of Object.keys(fields) as ThreadSearchHighlightKey[]) {
    const marked = fields[key]
      .map((value) => value.replace(hit, (found) => `**${found}**`))
      .filter((value, n) => value !== fields[key][n]);
    if (marked.length > 0) out[key] = marked;
  }
  return out;
}

/**
 * Search over metadata: subject, sender (address and display name) and
 * recipients. Every per-email filter must match the same email; folders,
 * labels and read apply to the thread.
 */
// ponytail: bodies and attachment names are sealed at rest, so search reads
// metadata only, unindexed, and matched_email_id is the newest match rather
// than a ranked one. A search index is the upgrade if inboxes outgrow it.
export async function searchThreads(
  db: Db,
  p: { teamId: string; inboxId: string; query: ThreadSearchQuery; agentView: boolean },
): Promise<{ data: ThreadSearchResultWire[]; hasMore: boolean } | { error: InboxError }> {
  const q = p.query;
  const terms = q.query === undefined ? { include: [], exclude: [] } : searchTerms(q.query);
  if (isInboxError(terms)) return { error: terms };
  const start = q.startDate === undefined ? null : dateBound(q.startDate, "start_date");
  if (isInboxError(start)) return { error: start };
  const end = q.endDate === undefined ? null : dateBound(q.endDate, "end_date");
  if (isInboxError(end)) return { error: end };
  if (start && end && start >= end) {
    return { error: invalid("The `start_date` must be on or before the `end_date`.") };
  }
  const inbox = await findLiveInbox(db, p.teamId, p.inboxId);
  if (!inbox) return { error: INBOX_NOT_FOUND };
  const includeHeld = !p.agentView && Boolean(q.includeHeld);
  const scope = await threadScope(db, { ...p, includeHeld });
  if (isInboxError(scope)) return { error: scope };

  const hay = sql`lower(x.subject || ' ' || x.sender || ' ' || x.to_t || ' ' || x.cc_t || ' ' || x.bcc_t)`;
  const any = (column: string, values: string[] | undefined) =>
    values && values.length > 0
      ? sql`(${sql.join(
          values.map((v) => sql`strpos(lower(${sql.raw(`x.${column}`)}), lower(${v})) > 0`),
          sql` or `,
        )})`
      : undefined;
  const perEmail = and(
    sql`true`,
    ...terms.include.map((term) => sql`strpos(${hay}, lower(${term})) > 0`),
    ...terms.exclude.map((term) => sql`strpos(${hay}, lower(${term})) = 0`),
    any("sender", q.from),
    any("to_t", q.to),
    any("cc_t", q.cc),
    any("bcc_t", q.bcc),
    q.hasAttachment === undefined ? undefined : q.hasAttachment ? sql`x.att` : sql`not x.att`,
    start ? sql`x.at >= ${start.toISOString()}::timestamptz` : undefined,
    end ? sql`x.at < ${end.toISOString()}::timestamptz` : undefined,
  );
  const emails = sql`
    select ${m.threadId} as thread_id, ${r.id} as email_id, ${r.createdAt} as at,
           ${r.subject} as subject, ${r.from} || ' ' || ${r.fromName} as sender,
           ${r.to}::text as to_t, ${r.cc}::text as cc_t, ${r.bcc}::text as bcc_t,
           ${r.attachmentCount} > 0 as att, 'in' as dir
      from ${m} join ${r} on ${r.id} = ${m.receivedEmailId}
     where ${m.inboxId} = ${p.inboxId}::uuid and ${counted(includeHeld)}
    union all
    select ${e.threadId}, ${e.id}, ${e.createdAt}, ${e.subject}, ${e.from},
           ${e.to}::text, coalesce(${e.cc}::text, ''), coalesce(${e.bcc}::text, ''),
           ${e.attachments} is not null, 'out'
      from ${e} join ${th} on ${th.id} = ${e.threadId}
     where ${th.inboxId} = ${p.inboxId}::uuid and ${e.teamId} = ${p.teamId}::uuid`;
  const page = await threadPage(
    db,
    { inboxId: p.inboxId, query: q },
    async (where, orderBy, take) =>
      resultRows<{ id: string; email_id: string; dir: "in" | "out" }>(
        await db.execute(sql`
        with matched as (
          select distinct on (x.thread_id) x.thread_id, x.email_id, x.at, x.dir
            from (${emails}) x
           where ${perEmail}
           order by x.thread_id, x.at desc, x.email_id desc
        ), covered as (
          select thread_id, email_id, dir from matched order by at desc limit ${SEARCH_THREADS_MAX}
        )
        select ${th.id} as id, covered.email_id, covered.dir
          from ${th} join covered on covered.thread_id = ${th.id}
         where ${and(scope, where)}
         order by ${sql.join(orderBy, sql`, `)}
         limit ${take}`),
      ),
  );
  if (page === "bad_cursor") return { error: CURSOR_NOT_FOUND };
  const ids = page.rows.map((row) => row.id);
  const rows = ids.length === 0 ? [] : await db.select().from(th).where(inArray(th.id, ids));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const ordered = ids.map((id) => byId.get(id)).filter((row): row is ThreadRow => !!row);
  const items = await listItems(db, { teamId: p.teamId, inbox, rows: ordered, includeHeld });

  const matched = new Map<string, Record<ThreadSearchHighlightKey, string[]>>();
  const inboundIds = page.rows.filter((row) => row.dir === "in").map((row) => row.email_id);
  const outboundIds = page.rows.filter((row) => row.dir === "out").map((row) => row.email_id);
  if (terms.include.length > 0 && inboundIds.length > 0) {
    for (const row of await db
      .select({
        id: r.id,
        subject: r.subject,
        from: r.from,
        fromName: r.fromName,
        to: r.to,
        cc: r.cc,
        bcc: r.bcc,
      })
      .from(r)
      .where(inArray(r.id, inboundIds))) {
      matched.set(row.id, {
        subject: [row.subject],
        from: [formatMailbox({ name: row.fromName, address: row.from })],
        to: row.to,
        cc: row.cc,
        bcc: row.bcc,
      });
    }
  }
  if (terms.include.length > 0 && outboundIds.length > 0) {
    for (const row of await db
      .select({ id: e.id, subject: e.subject, from: e.from, to: e.to, cc: e.cc, bcc: e.bcc })
      .from(e)
      .where(inArray(e.id, outboundIds))) {
      matched.set(row.id, {
        subject: [row.subject],
        from: [row.from],
        to: row.to,
        cc: row.cc ?? [],
        bcc: row.bcc ?? [],
      });
    }
  }
  const emailOf = new Map(page.rows.map((row) => [row.id, row.email_id]));
  return {
    data: items.map((item) => {
      const emailId = emailOf.get(item.id) ?? null;
      const fields = emailId ? matched.get(emailId) : undefined;
      return {
        ...item,
        matched_email_id: emailId,
        highlights: fields ? highlightsOf(fields, terms.include) : {},
      };
    }),
    hasMore: page.hasMore,
  };
}

/** ThreadSummary; null when the thread is not in the inbox, or holds nothing an agent may see. */
export async function getThread(
  db: Db,
  p: { teamId: string; inboxId: string; threadId: string; agentView: boolean },
): Promise<ThreadSummaryWire | null> {
  if (!(await findLiveInbox(db, p.teamId, p.inboxId))) return null;
  const row = await findThread(db, p);
  return row ? summaryOf(db, row, p.agentView) : null;
}

type ThreadChange =
  | { ok: true; thread: ThreadSummaryWire; previousFolder: ThreadFolder }
  | { ok: false; error: InboxError };

async function changeThread(
  db: Db,
  deps: InboxDeps,
  p: {
    teamId: string;
    inboxId: string;
    threadId: string;
    actor: InboxActor;
    read?: boolean | undefined;
    folder?: MoveFolder | undefined;
    labelId?: string | undefined;
    removeLabelId?: string | undefined;
  },
): Promise<ThreadChange> {
  const now = new Date();
  const agentView = isAgentActor(p.actor);
  const source = webhookSource(p.actor);
  const hooks = webhookBatch(deps.enqueueWebhookDeliveries);
  const result = await db.transaction(async (tx): Promise<ThreadChange> => {
    const t = tx as unknown as Db;
    if (!(await findLiveInbox(t, p.teamId, p.inboxId, now)))
      return { ok: false, error: INBOX_NOT_FOUND };
    const thread = await findThread(t, { ...p, agentView });
    if (!thread) return { ok: false, error: THREAD_NOT_FOUND };
    // Labels resolve before anything changes, so a 404 leaves the thread as it was.
    const labelRow = async (id: string | undefined) => {
      if (id === undefined) return null;
      const [row] = await t
        .select()
        .from(l)
        .where(and(eq(l.id, id.toLowerCase()), eq(l.inboxId, p.inboxId)));
      return row ?? labelNotFound(id);
    };
    const add = await labelRow(p.labelId);
    if (isInboxError(add)) return { ok: false, error: add };
    const remove = await labelRow(p.removeLabelId);
    if (isInboxError(remove)) return { ok: false, error: remove };

    if (p.read !== undefined) {
      await t
        .update(m)
        .set({ readAt: p.read ? now : null })
        .where(
          and(
            eq(m.threadId, thread.id),
            isNotNull(m.deliveredAt),
            p.read ? isNull(m.readAt) : isNotNull(m.readAt),
          ),
        );
    }
    let row = thread;
    const moved = p.folder !== undefined && p.folder !== thread.folder;
    if (moved) {
      const [updated] = await t
        .update(th)
        .set({ folder: p.folder, trashedAt: p.folder === "trash" ? now : null })
        .where(eq(th.id, thread.id))
        .returning();
      if (updated) row = updated;
    }
    const added = add
      ? (
          await t
            .insert(tl)
            .values({ threadId: thread.id, labelId: add.id })
            .onConflictDoNothing()
            .returning({ labelId: tl.labelId })
        ).length > 0
      : false;
    const removed = remove
      ? (
          await t
            .delete(tl)
            .where(and(eq(tl.threadId, thread.id), eq(tl.labelId, remove.id)))
            .returning({ labelId: tl.labelId })
        ).length > 0
      : false;
    await recordInboxActivity(t, {
      teamId: p.teamId,
      inboxId: p.inboxId,
      actor: p.actor,
      action: "thread.updated",
      threadId: thread.id,
    });
    const summary = await summaryOf(t, row, agentView);
    const common = { source, inboxId: p.inboxId, thread: summary, occurredAt: now };
    await hooks.emit(t, p.teamId, [
      ...(moved ? [threadFolderEvent({ ...common, from: thread.folder, to: row.folder })] : []),
      ...(added && add ? [threadLabelsEvent({ ...common, added: threadLabelWire(add) })] : []),
      ...(removed && remove
        ? [threadLabelsEvent({ ...common, removed: threadLabelWire(remove) })]
        : []),
    ]);
    return { ok: true, thread: summary, previousFolder: thread.folder };
  });
  await hooks.flush();
  return result;
}

export async function updateThread(
  db: Db,
  deps: InboxDeps,
  p: {
    teamId: string;
    inboxId: string;
    threadId: string;
    actor: InboxActor;
    read?: boolean | undefined;
    folder?: MoveFolder | undefined;
    labelId?: string | undefined;
    /** The dashboard's removal; the API cannot remove labels (Resend). */
    removeLabelId?: string | undefined;
  },
): Promise<{ ok: true; thread: ThreadSummaryWire } | { ok: false; error: InboxError }> {
  const result = await changeThread(db, deps, p);
  return result.ok ? { ok: true, thread: result.thread } : result;
}

/** Moves the thread to trash; deleted is false when it was there already. */
export async function trashThread(
  db: Db,
  deps: InboxDeps,
  p: { teamId: string; inboxId: string; threadId: string; actor: InboxActor },
): Promise<{ ok: true; deleted: boolean } | { ok: false; error: InboxError }> {
  const result = await changeThread(db, deps, { ...p, folder: "trash" });
  return result.ok ? { ok: true, deleted: result.previousFolder !== "trash" } : result;
}

/**
 * Deletes threads 30 days in the trash, and the received messages left in
 * no inbox and outside catch-all.
 */
export async function purgeTrashedThreads(db: Db, now: Date): Promise<number> {
  const due = await db
    .select({ id: th.id })
    .from(th)
    .where(
      and(eq(th.folder, "trash"), lte(th.trashedAt, new Date(now.getTime() - TRASH_RETENTION))),
    )
    .limit(PURGE_BATCH);
  if (due.length === 0) return 0;
  const ids = due.map((row) => row.id);
  await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const received = (
      await t.selectDistinct({ id: m.receivedEmailId }).from(m).where(inArray(m.threadId, ids))
    ).map((row) => row.id);
    await t.delete(th).where(inArray(th.id, ids));
    if (received.length > 0) {
      await t
        .delete(r)
        .where(
          and(
            inArray(r.id, received),
            eq(r.catchAll, false),
            sql`not exists (select 1 from ${m} where ${m.receivedEmailId} = ${r.id})`,
          ),
        );
    }
  });
  return ids.length;
}

const PARSE = {
  skipHtmlToText: true,
  skipTextToHtml: true,
  skipTextLinks: true,
  keepCidLinks: true,
} as const;

/** HTML byte-for-byte, text with invisible characters out, the sanitized read, attachment facts. */
async function inboundContent(
  row: ReceivedEmailRow,
  keyring: Keyring,
): Promise<MessageContent & { extractedText: string | null }> {
  const empty = { html: null, text: null, attachments: [], extractedText: null };
  try {
    const [files, extracted, raw] = await Promise.all([
      openReceivedAttachments(row, keyring),
      row.extracted === null ? null : openReceivedExtracted(row, keyring),
      openReceivedRaw(row, keyring),
    ]);
    let html: string | null = null;
    let text: string | null = null;
    if (raw) {
      try {
        const parsed = await simpleParser(raw, PARSE);
        html = parsed.html || null;
        text = parsed.text || null;
      } catch {
        // Malformed MIME reads as no body; the metadata still answers.
      }
    }
    return {
      // Mail carrying malware shows its text only, released or not.
      html: row.virusVerdict === "fail" ? null : html,
      text: text === null ? null : dropInvisible(text),
      attachments: files.map((a) => ({ id: a.id, filename: a.filename, size: a.size })),
      extractedText: extracted?.text ?? null,
    };
  } catch {
    // Undecryptable content (corrupt, unknown key version) reads as none.
    return empty;
  }
}

async function outboundContent(
  row: typeof e.$inferSelect,
  keyring: Keyring,
): Promise<MessageContent> {
  const owner = { teamId: row.teamId, rowId: row.id };
  let body: { html: string | null; text: string | null } = { html: null, text: null };
  let attachments: MessageContent["attachments"] = [];
  try {
    if (row.bodyCiphertext && row.bodyIv && row.bodyWrappedDek && row.bodyKeyVersion !== null) {
      body = await decryptEmailBody(
        {
          ciphertext: row.bodyCiphertext,
          iv: row.bodyIv,
          wrappedDek: row.bodyWrappedDek,
          keyVersion: row.bodyKeyVersion,
        },
        keyring,
        owner,
      );
    }
    if (row.attachments) {
      attachments = (await openAttachments(row.attachments, keyring, owner)).map((a, n) => ({
        id: String(n),
        filename: a.filename ?? null,
        size: Buffer.byteLength(a.content, "base64"),
      }));
    }
  } catch {
    // A purged or corrupt body must not fail the thread read.
  }
  return { html: body.html, text: body.text, attachments };
}

const NO_CONTENT: MessageContent = { html: null, text: null, attachments: [] };

type EmailRef = { id: string; dir: "in" | "out" };

/** One message of the thread as the view may read it, or the refusal. */
async function threadEmail(
  db: Db,
  keyring: Keyring,
  p: {
    teamId: string;
    inboxId: string;
    threadId: string;
    ref: EmailRef;
    agentView: boolean;
    includeHeld: boolean;
    envelopeOnly: boolean;
  },
): Promise<ThreadEmailWire | InboxError> {
  if (p.ref.dir === "out") {
    const [row] = await db
      .select()
      .from(e)
      .where(and(eq(e.id, p.ref.id), eq(e.threadId, p.threadId), eq(e.teamId, p.teamId)));
    if (!row) return EMAIL_NOT_FOUND;
    return outboundThreadEmailWire(
      row,
      p.envelopeOnly ? NO_CONTENT : await contentSlot(() => outboundContent(row, keyring)),
    );
  }
  const where = and(
    eq(m.receivedEmailId, p.ref.id),
    eq(m.inboxId, p.inboxId),
    eq(m.threadId, p.threadId),
    eq(r.teamId, p.teamId),
  );
  const [meta] = await db
    .select({ membership: m, row: RECEIVED_EMAIL_META_COLUMNS })
    .from(m)
    .innerJoin(r, eq(r.id, m.receivedEmailId))
    .where(where);
  if (!meta) return EMAIL_NOT_FOUND;
  const { membership } = meta;
  // SECURITY: agents never read held mail; a quarantined id says so, a pending one is not there yet.
  if (membership.deliveredAt === null && (p.agentView || !p.includeHeld)) {
    return membership.quarantinedAt !== null && membership.releasedAt === null
      ? EMAIL_QUARANTINED
      : EMAIL_NOT_FOUND;
  }
  if (p.envelopeOnly) {
    return inboundThreadEmailWire(meta.row, membership, { ...NO_CONTENT, extractedText: null });
  }
  return contentSlot(async () => {
    const [row] = await db.select().from(r).where(eq(r.id, p.ref.id));
    if (!row) return EMAIL_NOT_FOUND;
    return inboundThreadEmailWire(row, membership, await inboundContent(row, keyring));
  });
}

/** The thread exists in the live inbox and the view may see it. */
async function threadFor(
  db: Db,
  p: { teamId: string; inboxId: string; threadId: string; agentView: boolean },
): Promise<InboxError | null> {
  if (!(await findLiveInbox(db, p.teamId, p.inboxId))) return INBOX_NOT_FOUND;
  return (await findThread(db, p)) ? null : THREAD_NOT_FOUND;
}

/** A thread's messages, both directions, oldest first; `after` pages toward newer ones. */
export async function listThreadEmails(
  db: Db,
  keyring: Keyring,
  p: {
    teamId: string;
    inboxId: string;
    threadId: string;
    query: ListQuery;
    agentView: boolean;
    includeHeld: boolean;
    /** Support view: metadata only, never content. */
    envelopeOnly?: boolean | undefined;
  },
): Promise<{ data: ThreadEmailWire[]; hasMore: boolean } | { error: InboxError }> {
  const missing = await threadFor(db, p);
  if (missing) return { error: missing };
  const includeHeld = !p.agentView && p.includeHeld;
  const messages = sql`(
    select ${r.id} as id, ${r.createdAt} as at, 'in' as dir
      from ${m} join ${r} on ${r.id} = ${m.receivedEmailId}
     where ${m.threadId} = ${p.threadId}::uuid and ${m.inboxId} = ${p.inboxId}::uuid
       and ${r.teamId} = ${p.teamId}::uuid and ${counted(includeHeld)}
    union all
    select ${e.id}, ${e.createdAt}, 'out'
      from ${e}
     where ${e.threadId} = ${p.threadId}::uuid and ${e.teamId} = ${p.teamId}::uuid
  ) x`;
  const page = await keysetRows({
    query: p.query,
    key: sql`x.at`,
    id: sql`x.id`,
    newestFirst: false,
    cursorExists: async (id) =>
      resultRows(await db.execute(sql`select 1 from ${messages} where x.id = ${id}::uuid`)).length >
      0,
    cursorKey: (id) =>
      sql`coalesce((select ${r.createdAt} from ${r} where ${r.id} = ${id}::uuid), (select ${e.createdAt} from ${e} where ${e.id} = ${id}::uuid))`,
    load: async (where, orderBy, take) =>
      resultRows<EmailRef>(
        await db.execute(
          sql`select x.id, x.dir from ${messages} where ${where ?? sql`true`} order by ${sql.join(orderBy, sql`, `)} limit ${take}`,
        ),
      ),
  });
  if (page === "bad_cursor") return { error: CURSOR_NOT_FOUND };
  const data: ThreadEmailWire[] = [];
  // One message at a time: each read can decrypt a 40 MiB message.
  for (const ref of page.rows) {
    const email = await threadEmail(db, keyring, {
      ...p,
      ref,
      includeHeld,
      envelopeOnly: Boolean(p.envelopeOnly),
    });
    if (!isInboxError(email)) data.push(email);
  }
  return { data, hasMore: page.hasMore };
}

export async function getThreadEmail(
  db: Db,
  keyring: Keyring,
  p: {
    teamId: string;
    inboxId: string;
    threadId: string;
    emailId: string;
    agentView: boolean;
    includeHeld: boolean;
    envelopeOnly?: boolean | undefined;
  },
): Promise<ThreadEmailWire | { error: InboxError }> {
  const missing = await threadFor(db, p);
  if (missing) return { error: missing };
  const id = p.emailId.toLowerCase();
  const [outbound] = await db
    .select({ id: e.id })
    .from(e)
    .where(and(eq(e.id, id), eq(e.threadId, p.threadId), eq(e.teamId, p.teamId)));
  const email = await threadEmail(db, keyring, {
    ...p,
    ref: { id, dir: outbound ? "out" : "in" },
    includeHeld: !p.agentView && p.includeHeld,
    envelopeOnly: Boolean(p.envelopeOnly),
  });
  return isInboxError(email) ? { error: email } : email;
}
