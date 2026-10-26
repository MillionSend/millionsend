import {
  decryptEmailBody,
  type EmailBody,
  emailInsightsView,
  emitSuppressionEvents,
  fetchEmailInsights,
  findSuppressionsFor,
  getWarmup,
  hashRecipient,
  heldByNewDomainLimit,
  lockSuppressionContacts,
  type NewDomainLimit,
  newDomainLimitEta,
  newDomainLimitEtas,
  newDomainLimitStatus,
  revokeSuppressedConfirmations,
  utcDay,
} from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import { z } from "zod";
import { escapeLike } from "@/lib/sql";
import { planHoldUntil, sendingProgress } from "../broadcast-plan";
import { getKeyring } from "../keyring";
import { supportViewEventData } from "../support-view";
import { adminProcedure, router, teamProcedure } from "../trpc";

const emailStatus = z.enum(schema.emailStatusEnum.enumValues);

/**
 * Keyset cursor over (createdAt desc, id desc); id breaks createdAt ties.
 * createdAt travels as the Postgres text rendering of the timestamptz, not
 * as a Date: timestamptz carries microseconds and a JS Date only
 * milliseconds, so a Date round-trip would silently skip same-millisecond
 * rows at page boundaries.
 */
const cursorSchema = z.object({ createdAt: z.string(), id: z.uuid() });
type Cursor = z.infer<typeof cursorSchema>;

function beforeCursor(
  t: { createdAt: AnyPgColumn; id: AnyPgColumn },
  cursor: Cursor,
): SQL | undefined {
  return or(
    sql`${t.createdAt} < ${cursor.createdAt}::timestamptz`,
    and(sql`${t.createdAt} = ${cursor.createdAt}::timestamptz`, lt(t.id, cursor.id)),
  );
}

/** Mirror of beforeCursor for ascending (createdAt asc, id asc) pages. */
function afterCursor(
  t: { createdAt: AnyPgColumn; id: AnyPgColumn },
  cursor: Cursor,
): SQL | undefined {
  return or(
    sql`${t.createdAt} > ${cursor.createdAt}::timestamptz`,
    and(sql`${t.createdAt} = ${cursor.createdAt}::timestamptz`, gt(t.id, cursor.id)),
  );
}

/** Full-precision cursor value for a row's createdAt (see cursorSchema). */
function createdAtCursorField(t: { createdAt: AnyPgColumn }): SQL<string> {
  return sql<string>`${t.createdAt}::text`;
}

/**
 * Splits a limit+1 fetch into the page and its next-page cursor. Rows must
 * already be ordered on (createdAt, id) in the direction the cursor filter
 * walks; the cursorCreatedAt field feeds the cursor and is stripped from
 * the returned items.
 */
function paginate<T extends { id: string; cursorCreatedAt: string }>(
  rows: T[],
  limit: number,
): { items: Omit<T, "cursorCreatedAt">[]; nextCursor: Cursor | null } {
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > limit && last ? { createdAt: last.cursorCreatedAt, id: last.id } : null;
  const items = page.map(({ cursorCreatedAt: _cursorCreatedAt, ...item }) => item);
  return { items, nextCursor };
}

/**
 * Filter-scope total (the cursor excluded), computed for the first page only:
 * later pages return null and the client keeps reading pages[0].total, so an
 * infinite scroll costs one count, not one per page.
 */
async function firstPageTotal(
  db: Db,
  table: PgTable,
  filters: (SQL | undefined)[],
  cursor: Cursor | undefined,
): Promise<number | null> {
  if (cursor) return null;
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(table)
    .where(and(...filters));
  return row?.total ?? 0;
}

/**
 * A broadcast copy the provider has not seen whose sender region holds
 * broadcasts: the list and the detail show it as delayed, never why.
 * Spelled out because a single-table select leaves column names
 * unqualified, and the subquery's own tables would capture them.
 */
const HELD_SQL = sql<boolean>`(emails.broadcast_id is not null and emails.latest_status in ('queued', 'queued_quota') and exists (select 1 from domains d join region_breakers rb on rb.region = d.region and rb.paused where d.id = emails.domain_id))`;

/**
 * A suppression a full or inactive mailbox left: the API still reads it as a
 * hard bounce, but the bounce behind it was a soft one, which suppresses only
 * for that. Spelled out like HELD_SQL, over a select from suppressions; the
 * team guard keeps a stray source id from reading another team's events.
 */
function fullMailboxSql(teamId: string): SQL<boolean> {
  return sql<boolean>`(suppressions.reason = 'hard_bounce' and coalesce((select ev.bounce_type = 'Transient' from email_events ev join emails e on e.id = ev.email_id where ev.email_id = suppressions.source_email_id and e.team_id = ${teamId} and ev.type = 'bounced' order by ev.occurred_at desc, ev.id desc limit 1), false))`;
}

/**
 * A row the list shows as waiting for a reason the team may know: the new
 * domain limit, a broadcast copy's own warm-up (running or paused), or (for
 * "quota", resolved against the plan per page) the plan's cap. Every other
 * park, a silent hold included, resolves as capacity does, so it reads as a
 * plain wait, or the plan's while that binds. The paused warm-up's lookup
 * is spelled out like HELD_SQL.
 */
const WAITING_FOR_SQL = sql<"domain_limit" | "warmup" | "warmup_paused" | "quota" | null>`case
  when ${heldByNewDomainLimit()} then 'domain_limit'
  when ${schema.emails.latestStatus} = 'queued_quota' and ${schema.emails.parkReason} = 'warmup' then
    case when exists (select 1 from domain_warmups dw where dw.domain_id = emails.domain_id and dw.status = 'paused') then 'warmup_paused' else 'warmup' end
  when ${schema.emails.latestStatus} = 'queued_quota' then 'quota'
end`;

/**
 * What a row not yet handed to the provider is waiting for, for the detail's
 * estimated nodes. Never stored: it is the planner's view at read time.
 */
type PendingSend =
  | { kind: "scheduled"; at: Date }
  | { kind: "queued" }
  | { kind: "plan"; resumesAt: Date }
  | { kind: "waiting" }
  | { kind: "warmup" }
  | { kind: "warmupPaused" }
  | {
      kind: "newDomainLimit";
      domainId: string;
      domain: string;
      cap: number;
      used: number;
      pool: NewDomainLimit["pool"];
      /** Held emails of the domain that go out before this one. */
      ahead: number;
      sendsAfter: Date;
      resetsAt: Date;
    }
  | { kind: "held" }
  | { kind: "paced"; from: Date | null; to: Date | null };

async function pendingSend(
  db: Db,
  teamId: string,
  email: {
    id: string;
    latestStatus: string;
    sentAt: Date | null;
    scheduledAt: Date | null;
    domainId: string | null;
    broadcastId: string | null;
    parkReason: string | null;
    held: boolean;
  },
  limit: NewDomainLimit | undefined,
): Promise<PendingSend | null> {
  if (email.sentAt) return null;
  if (email.held) return { kind: "held" };
  const now = new Date();
  if (email.latestStatus === "queued") {
    return email.scheduledAt && email.scheduledAt > now
      ? { kind: "scheduled", at: email.scheduledAt }
      : { kind: "queued" };
  }
  if (email.latestStatus !== "queued_quota") return null;
  // Both warm-ups free the row by themselves, so no limit to raise: a
  // broadcast copy waits on its domain's own warm-up while that is on,
  // anything else on the age-based limit of a newly registered domain.
  if (email.parkReason === "warmup") {
    const ramp =
      email.domainId && email.broadcastId ? await getWarmup(db, teamId, email.domainId) : undefined;
    if (ramp?.status === "warming") return { kind: "warmup" };
    if (ramp?.status === "paused") return { kind: "warmupPaused" };
    // A domain the limit no longer covers lets its held mail out at the next drain.
    const eta = limit ? await newDomainLimitEta(db, { teamId, emailId: email.id, now }) : null;
    if (!limit || !eta) return { kind: "waiting" };
    return {
      kind: "newDomainLimit",
      domainId: limit.domainId,
      domain: limit.name,
      cap: limit.cap,
      used: limit.used,
      pool: limit.pool,
      ahead: eta.ahead,
      sendsAfter: eta.sendsAfter,
      resetsAt: limit.resetsAt,
    };
  }
  // A hold by the team's own cap outranks capacity: its reset is the date.
  const hold = await planHoldUntil(db, teamId, now);
  if (hold) return { kind: "plan", resumesAt: hold };
  // Parked with room under the plan: SES capacity (or a suspension) holds it.
  if (!email.broadcastId) return { kind: "waiting" };
  const progress = (await sendingProgress(db, teamId, now)).get(email.broadcastId);
  return {
    kind: "paced",
    from: progress?.releases[0]?.at ?? null,
    to: progress?.finishesAt ?? null,
  };
}

/** The Emails list's filters, shared by the list and its per-source counts. */
const listFilterInput = z.object({
  // One status or any subset of them.
  status: z.union([emailStatus, z.array(emailStatus).min(1)]).optional(),
  search: z.string().trim().max(200).optional(),
  apiKeyId: z.uuid().optional(),
  domainId: z.uuid().optional(),
  broadcastId: z.uuid().optional(),
  since: z.coerce.date().optional(),
});

function listFilters(teamId: string, input: z.infer<typeof listFilterInput>): (SQL | undefined)[] {
  const t = schema.emails;
  const filters: (SQL | undefined)[] = [eq(t.teamId, teamId)];
  if (input.status) {
    filters.push(
      Array.isArray(input.status)
        ? inArray(t.latestStatus, input.status)
        : eq(t.latestStatus, input.status),
    );
  }
  if (input.search) {
    const pattern = `%${escapeLike(input.search)}%`;
    filters.push(or(ilike(t.subject, pattern), sql`${t.to}::text ilike ${pattern}`));
  }
  if (input.apiKeyId) filters.push(eq(t.apiKeyId, input.apiKeyId));
  if (input.domainId) filters.push(eq(t.domainId, input.domainId));
  if (input.broadcastId) filters.push(eq(t.broadcastId, input.broadcastId));
  if (input.since) filters.push(gte(t.createdAt, input.since));
  return filters;
}

export const emailsRouter = router({
  list: teamProcedure
    .input(
      listFilterInput.extend({
        // Where the emails came from: API/SMTP sends, or broadcast copies.
        source: z.enum(["transactional", "broadcast"]).optional(),
        cursor: cursorSchema.optional(),
        limit: z.number().int().min(1).max(50).default(25),
        // "asc" reads oldest-first (e.g. a team's very first email).
        order: z.enum(["asc", "desc"]).default("desc"),
      }),
    )
    .query(async ({ ctx, input }) => {
      const t = schema.emails;
      const filters = listFilters(ctx.teamId, input);
      if (input.source) {
        filters.push(
          input.source === "broadcast" ? isNotNull(t.broadcastId) : isNull(t.broadcastId),
        );
      }
      const total = await firstPageTotal(ctx.db, t, filters, input.cursor);
      const ascending = input.order === "asc";
      if (input.cursor) {
        filters.push(ascending ? afterCursor(t, input.cursor) : beforeCursor(t, input.cursor));
      }
      const rows = await ctx.db
        .select({
          id: t.id,
          to: t.to,
          subject: t.subject,
          latestStatus: t.latestStatus,
          createdAt: t.createdAt,
          cursorCreatedAt: createdAtCursorField(t),
          scheduledAt: t.scheduledAt,
          sentAt: t.sentAt,
          broadcastId: t.broadcastId,
          domainId: t.domainId,
          held: HELD_SQL,
          waitingFor: WAITING_FOR_SQL,
        })
        .from(t)
        .where(and(...filters))
        .orderBy(...(ascending ? [asc(t.createdAt), asc(t.id)] : [desc(t.createdAt), desc(t.id)]))
        .limit(input.limit + 1);
      const page = paginate(rows, input.limit);
      // Parked with no reason of its own: the plan's cap when it binds, else capacity.
      const planResumesAt = page.items.some((row) => row.waitingFor === "quota")
        ? await planHoldUntil(ctx.db, ctx.teamId)
        : null;
      // Each row the limit holds goes out by its own place in its domain's line.
      const etas = await newDomainLimitEtas(ctx.db, {
        teamId: ctx.teamId,
        emailIds: page.items.flatMap((row) => (row.waitingFor === "domain_limit" ? [row.id] : [])),
      });
      const items = page.items.map(({ waitingFor, ...row }) => {
        const quota = waitingFor === "quota";
        return {
          ...row,
          waitingFor: quota ? (planResumesAt ? ("plan" as const) : null) : waitingFor,
          resumesAt: quota ? planResumesAt : null,
          sendsAfter: etas.get(row.id)?.sendsAfter ?? null,
        };
      });
      return { items, nextCursor: page.nextCursor, total };
    }),

  /**
   * Both sources' counts under the list's other filters, for the source
   * tabs. Kept apart from the list so switching tabs reuses them instead of
   * blanking them while the new page loads.
   */
  sourceTotals: teamProcedure.input(listFilterInput).query(async ({ ctx, input }) => {
    const t = schema.emails;
    const filters = listFilters(ctx.teamId, input);
    // Two counts, one per partial index, so each stays an index-only scan.
    const count = async (side: SQL) => {
      const [row] = await ctx.db
        .select({ n: sql<number>`count(*)::int` })
        .from(t)
        .where(and(...filters, side));
      return row?.n ?? 0;
    };
    const [transactional, broadcast] = await Promise.all([
      count(isNull(t.broadcastId)),
      count(isNotNull(t.broadcastId)),
    ]);
    return { transactional, broadcast };
  }),

  /** Masthead proof strip + cap banner: today's sends, all-time deliveries, queued backlog. */
  stats: teamProcedure.query(async ({ ctx }) => {
    const today = utcDay();
    const c = schema.usageCounters;
    const [usage] = await ctx.db
      .select({
        sentToday: sql<number>`coalesce(sum(${c.sent}) filter (where ${c.day} = ${today}), 0)::int`,
        deliveredAllTime: sql<number>`coalesce(sum(${c.delivered}), 0)::int`,
      })
      .from(c)
      .where(eq(c.teamId, ctx.teamId));

    const t = schema.emails;
    const [queued] = await ctx.db
      .select({ count: sql<number>`count(*)::int` })
      .from(t)
      // Transactional only: a paced broadcast's rows wait for capacity, and
      // the broadcast's own page says when they go.
      .where(
        and(
          eq(t.teamId, ctx.teamId),
          eq(t.latestStatus, "queued_quota"),
          isNull(t.broadcastId),
          // A young domain's warm-up frees by itself, not at the plan's reset.
          isNull(t.parkReason),
        ),
      );

    // Whether the team ever sent a broadcast copy: the source tabs show from
    // it, whatever the list's filters match.
    const [bulk] = await ctx.db
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.teamId, ctx.teamId), isNotNull(t.broadcastId)))
      .limit(1);

    return {
      hasBroadcasts: bulk !== undefined,
      sentToday: usage?.sentToday ?? 0,
      deliveredAllTime: usage?.deliveredAllTime ?? 0,
      queuedQuota: queued?.count ?? 0,
    };
  }),

  get: teamProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
    const t = schema.emails;
    const [email] = await ctx.db
      .select({ ...getTableColumns(t), held: HELD_SQL })
      .from(t)
      .where(and(eq(t.id, input.id), eq(t.teamId, ctx.teamId)))
      .limit(1);
    if (!email) throw new TRPCError({ code: "NOT_FOUND" });

    let body: EmailBody = { html: null, text: null };
    // A support view reads the envelope, never the message: the body is not
    // decrypted at all, and the flag says so instead of "no body".
    const hiddenBySupportView = Boolean(ctx.supportView);
    if (
      !hiddenBySupportView &&
      email.bodyCiphertext &&
      email.bodyIv &&
      email.bodyWrappedDek &&
      email.bodyKeyVersion != null
    ) {
      const kr = getKeyring();
      try {
        body = await decryptEmailBody(
          {
            ciphertext: email.bodyCiphertext,
            iv: email.bodyIv,
            wrappedDek: email.bodyWrappedDek,
            keyVersion: email.bodyKeyVersion,
          },
          kr,
          { teamId: email.teamId, rowId: email.id },
        );
      } catch {
        // Undecryptable (corrupt ciphertext, unknown KEK version) reads as
        // "no body" — the metadata and events are still worth showing.
      }
    }

    const ev = schema.emailEvents;
    const events = await ctx.db
      .select({ id: ev.id, type: ev.type, occurredAt: ev.occurredAt, data: ev.data })
      .from(ev)
      .where(eq(ev.emailId, email.id))
      .orderBy(asc(ev.occurredAt), asc(ev.id));

    const insightsRow = await fetchEmailInsights(ctx.db, ctx.teamId, {
      emailId: email.id,
      broadcastId: email.broadcastId,
    });
    const insights = emailInsightsView(insightsRow);

    let apiKeyName: string | null = null;
    if (email.apiKeyId) {
      const k = schema.apiKeys;
      const [key] = await ctx.db
        .select({ name: k.name })
        .from(k)
        .where(and(eq(k.id, email.apiKeyId), eq(k.teamId, ctx.teamId)))
        .limit(1);
      apiKeyName = key?.name ?? null;
    }

    let broadcast: { id: string; name: string } | null = null;
    if (email.broadcastId) {
      const b = schema.broadcasts;
      const [row] = await ctx.db
        .select({ id: b.id, name: sql<string>`coalesce(${b.name}, ${b.subject})` })
        .from(b)
        .where(and(eq(b.id, email.broadcastId), eq(b.teamId, ctx.teamId)))
        .limit(1);
      broadcast = row ?? null;
    }
    let sendingDomain: { id: string; name: string; cap: number | null } | null = null;
    let limit: NewDomainLimit | undefined;
    if (email.domainId) {
      const d = schema.domains;
      const [domain] = await ctx.db
        .select({ id: d.id, name: d.name })
        .from(d)
        .where(and(eq(d.id, email.domainId), eq(d.teamId, ctx.teamId)))
        .limit(1);
      if (domain) {
        [limit] = await newDomainLimitStatus(ctx.db, {
          teamId: ctx.teamId,
          domainIds: [domain.id],
        });
        sendingDomain = { ...domain, cap: limit?.cap ?? null };
      }
    }
    const pending = await pendingSend(ctx.db, ctx.teamId, email, limit);

    // Whitelisted shape: the ciphertext/key columns must never reach the client.
    return {
      broadcast,
      pending,
      sendingDomain,
      apiKeyName,
      id: email.id,
      from: email.from,
      to: email.to,
      cc: email.cc,
      bcc: email.bcc,
      replyTo: email.replyTo,
      subject: email.subject,
      tags: email.tags,
      latestStatus: email.latestStatus,
      createdAt: email.createdAt,
      scheduledAt: email.scheduledAt,
      sentAt: email.sentAt,
      bodyPurgedAt: email.bodyPurgedAt,
      html: body.html,
      text: body.text,
      hiddenBySupportView,
      events: hiddenBySupportView
        ? events.map((e) => ({ ...e, data: supportViewEventData(e.data) }))
        : events,
      insights,
    };
  }),

  suppressions: router({
    list: teamProcedure
      .input(
        z.object({
          search: z.string().trim().max(200).optional(),
          reason: z.enum(schema.suppressionReasonEnum.enumValues).optional(),
          since: z.coerce.date().optional(),
          cursor: cursorSchema.optional(),
          limit: z.number().int().min(1).max(50).default(25),
        }),
      )
      .query(async ({ ctx, input }) => {
        const t = schema.suppressions;
        const filters: (SQL | undefined)[] = [eq(t.teamId, ctx.teamId)];
        if (input.search) filters.push(ilike(t.email, `%${escapeLike(input.search)}%`));
        if (input.reason) filters.push(eq(t.reason, input.reason));
        if (input.since) filters.push(gte(t.createdAt, input.since));
        const total = await firstPageTotal(ctx.db, t, filters, input.cursor);
        if (input.cursor) filters.push(beforeCursor(t, input.cursor));
        const rows = await ctx.db
          .select({
            id: t.id,
            email: t.email,
            reason: t.reason,
            fullMailbox: fullMailboxSql(ctx.teamId),
            createdAt: t.createdAt,
            cursorCreatedAt: createdAtCursorField(t),
          })
          .from(t)
          .where(and(...filters))
          .orderBy(desc(t.createdAt), desc(t.id))
          .limit(input.limit + 1);
        return { ...paginate(rows, input.limit), total };
      }),

    /** Masthead proof strip: "{total} addresses blocked · {n} bounce · {n} complaint". */
    stats: teamProcedure.query(async ({ ctx }) => {
      const t = schema.suppressions;
      const rows = await ctx.db
        .select({ reason: t.reason, count: sql<number>`count(*)::int` })
        .from(t)
        .where(eq(t.teamId, ctx.teamId))
        .groupBy(t.reason);
      const byReason = Object.fromEntries(rows.map((r) => [r.reason, r.count])) as Partial<
        Record<(typeof schema.suppressionReasonEnum.enumValues)[number], number>
      >;
      return { total: rows.reduce((sum, r) => sum + r.count, 0), byReason };
    }),

    get: teamProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
      const t = schema.suppressions;
      const [row] = await ctx.db
        .select({
          id: t.id,
          email: t.email,
          reason: t.reason,
          fullMailbox: fullMailboxSql(ctx.teamId),
          createdAt: t.createdAt,
          sourceEmailId: t.sourceEmailId,
        })
        .from(t)
        .where(and(eq(t.id, input.id), eq(t.teamId, ctx.teamId)))
        .limit(1);
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });

      // The SMTP diagnostic lives on the source email's bounce event; the
      // team guard on the join keeps a stray sourceEmailId from leaking
      // another tenant's event payload.
      let bounce: Record<string, unknown> | null = null;
      if (row.sourceEmailId) {
        const ev = schema.emailEvents;
        const e = schema.emails;
        const [event] = await ctx.db
          .select({ data: ev.data })
          .from(ev)
          .innerJoin(e, eq(ev.emailId, e.id))
          .where(
            and(
              eq(ev.emailId, row.sourceEmailId),
              eq(e.teamId, ctx.teamId),
              eq(ev.type, "bounced"),
            ),
          )
          .orderBy(desc(ev.occurredAt), desc(ev.id))
          .limit(1);
        const data = event?.data?.bounce;
        bounce = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
      }
      return { ...row, bounce };
    }),

    /** The suppressions any recipient of one email (to, cc or bcc) matches, for its detail. */
    forEmail: teamProcedure.input(z.object({ emailId: z.uuid() })).query(async ({ ctx, input }) => {
      const e = schema.emails;
      const [email] = await ctx.db
        .select({ to: e.to, cc: e.cc, bcc: e.bcc })
        .from(e)
        .where(and(eq(e.id, input.emailId), eq(e.teamId, ctx.teamId)))
        .limit(1);
      if (!email) throw new TRPCError({ code: "NOT_FOUND" });
      const rows = await findSuppressionsFor(ctx.db, ctx.teamId, [
        ...email.to,
        ...(email.cc ?? []),
        ...(email.bcc ?? []),
      ]);
      const bounced = rows.filter((row) => row.reason === "hard_bounce").map((row) => row.id);
      const s = schema.suppressions;
      const full = new Set(
        bounced.length === 0
          ? []
          : (
              await ctx.db
                .select({ id: s.id })
                .from(s)
                .where(and(inArray(s.id, bounced), fullMailboxSql(ctx.teamId)))
            ).map((row) => row.id),
      );
      return rows.map((row) => ({ ...row, fullMailbox: full.has(row.id) }));
    }),

    add: teamProcedure
      .input(
        z.object({
          email: z.string().trim().pipe(z.email()).pipe(z.string().max(320)),
          reason: z.literal("manual"),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const t = schema.suppressions;
        const emailHash = hashRecipient(input.email);
        const row = await ctx.db.transaction(async (tx) => {
          const txDb = tx as unknown as Db;
          await lockSuppressionContacts(txDb, ctx.teamId, [input.email]);
          const [changed] = await txDb
            .insert(t)
            .values({ teamId: ctx.teamId, email: input.email, emailHash, reason: input.reason })
            .onConflictDoUpdate({
              target: [t.teamId, t.emailHash],
              set: { reason: input.reason },
              setWhere: eq(t.reason, "one_click_unsubscribe"),
            })
            .returning({
              id: t.id,
              email: t.email,
              reason: t.reason,
              sourceEmailId: t.sourceEmailId,
              createdAt: t.createdAt,
            });
          await revokeSuppressedConfirmations(txDb, ctx.teamId, [input.email]);
          return changed;
        });
        if (row) {
          await emitSuppressionEvents(ctx.db, {
            teamId: ctx.teamId,
            type: "suppression.added",
            rows: [row],
            source: "dashboard",
            enqueue: ctx.enqueueWebhookDeliveries,
          });
          return { id: row.id };
        }
        // Already suppressed (any reason) — adding is idempotent.
        const [existing] = await ctx.db
          .select({ id: t.id })
          .from(t)
          .where(and(eq(t.teamId, ctx.teamId), eq(t.emailHash, emailHash)))
          .limit(1);
        if (!existing) throw new TRPCError({ code: "CONFLICT" });
        return { id: existing.id };
      }),

    // Admin-only: lifting a bounce/complaint block re-exposes sender reputation.
    remove: adminProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
      const t = schema.suppressions;
      const [row] = await ctx.db
        .delete(t)
        .where(and(eq(t.id, input.id), eq(t.teamId, ctx.teamId)))
        .returning({
          id: t.id,
          email: t.email,
          reason: t.reason,
          sourceEmailId: t.sourceEmailId,
          createdAt: t.createdAt,
        });
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      await emitSuppressionEvents(ctx.db, {
        teamId: ctx.teamId,
        type: "suppression.removed",
        rows: [row],
        source: "dashboard",
        enqueue: ctx.enqueueWebhookDeliveries,
      });
      return { id: row.id };
    }),
  }),
});
