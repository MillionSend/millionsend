import {
  broadcastSendSpacingMs,
  buildAccountMail,
  checkWarmups,
  claimNotification,
  complainedEmail,
  countDistinctRecipients,
  DAY_MS,
  DRAIN_MAX_PER_RUN,
  deliverabilityHold,
  deliveredEmail,
  endQueuedEmails,
  failQueuedEmailsForDomain,
  fetchDeliverabilityHealth,
  getInstanceSettings,
  isIdentitySharedByOtherDomains,
  nextUtcDayStart,
  OPERATOR_PARK_REASONS,
  type PlanSnapshot,
  purgedEmailBodyColumns,
  QUOTA_COLUMNS,
  type QuotaTeamRow,
  RECEIVED_SECRET_WINDOW,
  recordAudit,
  releaseQuota,
  reserveQuota,
  reserveWarmup,
  reserveWarmupDay,
  SES_QUOTA_SLOT_MS,
  SYSTEM_MAIL_TAG,
  type TeamQuota,
  teamQuota,
  transitionQueueState,
  utcDay,
  type WarmupCap,
  type WarmupEvent,
  type WarmupRelease,
  WEBHOOK_BACKLOG_AGE_MS,
  WEBHOOK_MAX_AGE_MS,
  type WebhookEnqueue,
  warmupCap,
  warmupMailValues,
  warmupRelease,
  webhookBatch,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { affectedRows, keysetCursorWhere, schema } from "@millionsend/db";
import { type EnqueueEmailSends, emailSendPriority } from "@millionsend/queue";
import {
  checkDnsRecords,
  computeDomainVerification,
  type DnsResolver,
  deleteDomainIdentity,
  disassociateIdentity,
  getDomainVerification,
  type SesIdentityClient,
  verificationDbPatch,
} from "@millionsend/ses";
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { mailOwners, type SystemMailer } from "../system-mail.js";
import { exhaustOpenDeliveries } from "./deliver-webhook.js";

/**
 * Safety net for a lost webhook.drain job (worker died mid-pass, enqueue
 * failed after the rows were written). Day-old open rows are exhausted
 * first. Then, per endpoint, a row due for a quarter hour that no pass
 * claimed goes through the fan-out seam, which arms one drain per
 * endpoint; the queue's singleton and the group lane serialise that pass
 * behind any live one, so arming is safe even when a drain is alive. An
 * endpoint whose oldest due row is over WEBHOOK_BACKLOG_AGE_MS old is
 * logged as an alert (depth alone is not: ten thousand rows is minutes of
 * healthy draining). Every probe is one index lookup per endpoint; the
 * backlog itself is never walked.
 *
 * ponytail: the alert is a warn line in the container log; a customer
 * notification is the upgrade, on the alarmed ids this computes.
 */
export async function reconcileWebhookDeliveries(
  db: Db,
  deps: { enqueue: WebhookEnqueue; now?: Date },
): Promise<number> {
  const now = deps.now ?? new Date();
  const d = schema.webhookDeliveries;
  const e = schema.webhookEndpoints;
  await exhaustOpenDeliveries(
    db,
    lt(d.createdAt, new Date(now.getTime() - WEBHOOK_MAX_AGE_MS)),
    asc(d.createdAt),
  );

  const staleBefore = new Date(now.getTime() - 15 * 60 * 1000);
  const alarmBefore = new Date(now.getTime() - WEBHOOK_BACKLOG_AGE_MS);
  const open = sql`${d.endpointId} = ${e.id} and ${d.status} in ('pending', 'failed')`;
  const endpoints = await db
    .select({
      endpointId: e.id,
      staleId: sql<
        string | null
      >`(select ${d.id} from ${d} where ${open} and ${d.nextAttemptAt} < ${staleBefore} order by ${d.nextAttemptAt}, ${d.id} limit 1)`,
      // min() over the due index rather than exists(): the planner turns a
      // correlated exists into a heap scan per endpoint when the backlog is deep.
      alarmed: sql<boolean>`(select min(${d.nextAttemptAt}) from ${d} where ${open}) < ${alarmBefore}`,
    })
    .from(e);
  const stale = endpoints.flatMap((row) =>
    row.staleId ? [{ id: row.staleId, endpointId: row.endpointId }] : [],
  );
  if (stale.length > 0) await deps.enqueue(stale);
  for (const row of endpoints) {
    if (row.alarmed)
      console.warn(
        `webhooks.reconcile: endpoint ${row.endpointId} has a delivery due for over ${WEBHOOK_BACKLOG_AGE_MS / 3_600_000} hours`,
      );
  }
  return stale.length;
}

/**
 * Safety net for broadcast.send jobs lost between the schedule commit and the
 * enqueue (or a worker crash mid-fan-out). Scheduled broadcasts past due and
 * sending broadcasts whose fan-out went quiet are re-enqueued; the handler's
 * status re-check plus the (broadcastId, contactId) unique index make a stray
 * extra job harmless. A walk that finished (recipientCount set) is never
 * re-kicked: its broadcast stays sending only while parked rows drain, and
 * `finalize` flips it once the last one has gone.
 */
export async function reconcileStalledBroadcasts(
  db: Db,
  deps: {
    enqueue: (broadcastId: string) => Promise<void>;
    finalize?: ((broadcastId: string) => Promise<unknown>) | undefined;
    now?: Date;
  },
): Promise<number> {
  const now = deps.now ?? new Date();
  const staleBefore = new Date(now.getTime() - 15 * 60 * 1000);
  const b = schema.broadcasts;
  const stalled = await db
    .select({ id: b.id })
    .from(b)
    .where(
      or(
        and(eq(b.status, "scheduled"), lt(b.scheduledAt, staleBefore)),
        and(eq(b.status, "sending"), lt(b.updatedAt, staleBefore), isNull(b.recipientCount)),
      ),
    )
    .orderBy(asc(b.createdAt));
  for (const broadcast of stalled) {
    await deps.enqueue(broadcast.id);
  }
  const walked = await db
    .select({ id: b.id })
    .from(b)
    .where(and(eq(b.status, "sending"), isNotNull(b.recipientCount)));
  for (const broadcast of walked) {
    await deps.finalize?.(broadcast.id);
  }
  return stalled.length;
}

export interface DrainDeps {
  isCloud: boolean;
  /** One call per page; startAfter defers emails scheduled beyond the drain time, priority keeps transactional rows ahead of broadcast ones. */
  enqueueSends: EnqueueEmailSends;
  /**
   * SES's own 24-hour quota and the broadcast share, per region: rows whose
   * region is full stay parked, since releasing them would only park them
   * again, and bulk rows move only into the room the share has. Rows with
   * no domain send from the default region, the list's first entry.
   */
  sesQuota?:
    | {
        regions: readonly string[];
        exhausted(region: string): boolean;
        room?(region: string): number;
        paused?(region: string): boolean;
        recount?(): Promise<void>;
        noteBulkQueued?(region: string, n: number): void;
      }
    | undefined;
  /** Called for every broadcast the bulk pass touched; flips it to sent once nothing of it remains. */
  finalize?: ((broadcastId: string) => Promise<unknown>) | undefined;
  /** Owners hear when a domain's warm-up pauses or finishes; absent = silent (tests). */
  mailer?: SystemMailer | undefined;
  /** Dashboard origin for the links in those mails. */
  appBaseUrl?: string | undefined;
  now?: Date | undefined;
}

export interface DrainResult {
  drained: number;
  stillParked: number;
}

/** Sentinel: the row left queued_quota concurrently; roll the reservation back. */
class DrainRaced extends Error {}

/**
 * Sentinel: the sending domain's warm-up, the team's shared one, or the
 * domain's reputation warm-up ("ramp") is spent for the day; roll the
 * plan's reservation back.
 */
class WarmupHeld extends Error {
  constructor(readonly full: "domain" | "pool" | "ramp") {
    super(`warm-up ${full} full`);
  }
}

/** Parked rows loaded per page; the backlog is unbounded (see acceptEmail). */
const DRAIN_PAGE = 500;

/** What one drain run carries between its passes. */
interface DrainRun {
  now: Date;
  /** Teams found at their cap leave every later page query. */
  heldTeams: Set<string>;
  /** Teams already asked whether the deliverability pause holds them. */
  checkedTeams: Set<string>;
  /** Teams the pause holds: only their account mail stays in later page queries. */
  pausedTeams: Set<string>;
  /** The warm-up cap per sending domain row, read once per run. */
  warmups: Map<string, WarmupCap | null>;
  /**
   * Registrable domains whose warm-up day is spent, teams whose shared one
   * is, and the domain rows that leave the page query with them.
   */
  warmupFull: Set<string>;
  poolFull: Set<string>;
  heldDomains: Set<string>;
  /** Each sending domain's reputation warm-up, read once per run, with what the run released against it. */
  ramps: Map<string, (WarmupRelease & { released: number }) | null>;
  failures: unknown[];
}

/**
 * Drain of quota-parked emails, every 15 minutes (which covers the UTC
 * midnight rollover that frees a daily quota, a billing period that renewed
 * or gained overage, and the rolling window that frees SES's own). Parked
 * emails hold NO reservation (accept-time reservation failed, or the send
 * handler handed it back when SES was full), so each one must win a
 * reservation against its team's cap before it may move to "queued":
 * without this, parking would be a quota bypass.
 *
 * Two passes under one per-run cap. Transactional rows first, oldest first,
 * in every region not at its quota: a password reset never waits behind a
 * newsletter. Then broadcasts: each one still sending with parked rows gets
 * an equal slice of what is left, in the order they were scheduled, into
 * the room its region's broadcast share has; a throttled team's slice is
 * one cadence of its drip, spaced on the rows themselves so the reconcile
 * sweep leaves them alone. A broadcast whose last parked row went is
 * finalized at the end of the run.
 *
 * A domain warming up its reputation releases its broadcasts by the
 * warm-up's day, judged each run between the two passes (checkWarmups), so
 * a long check never holds transactional mail: nothing until yesterday is
 * checked, the most active contacts first, never more in a run than a 48th
 * of the day's allowance, and nothing while it is paused.
 *
 * Reserve + transition commit atomically per email (no crash window that
 * burns quota or half-moves a row). One email's failure never blocks the
 * rest — errors are collected and rethrown at the end so the cron retries.
 */
export async function drainQuotaParked(db: Db, deps: DrainDeps): Promise<DrainResult> {
  const now = deps.now ?? new Date();
  await deps.sesQuota?.recount?.();
  const regions = deps.sesQuota?.regions ?? [];
  const held = regions.filter((region) => deps.sesQuota?.exhausted(region));
  const run: DrainRun = {
    now,
    heldTeams: new Set(),
    checkedTeams: new Set(),
    pausedTeams: new Set(),
    warmups: new Map(),
    warmupFull: new Set(),
    poolFull: new Set(),
    heldDomains: new Set(),
    ramps: new Map(),
    failures: [],
  };
  let drained = 0;
  if (regions.length === 0 || held.length < regions.length) {
    const released = await releaseParkedRows(db, deps, run, {
      where: isNull(schema.emails.broadcastId),
      budget: DRAIN_MAX_PER_RUN,
      held,
      spacingMs: 0,
    });
    drained += released.total;
    const remaining = await parkedByRegion(db, regions[0] ?? "", isNull(schema.emails.broadcastId));
    for (const region of new Set([...released.byRegion.keys(), ...remaining.keys()])) {
      console.log(
        `quota.drain: pass=1 region=${region} released=${released.byRegion.get(region) ?? 0} remaining=${remaining.get(region) ?? 0}`,
      );
    }
  }
  await mailWarmupEvents(db, deps, await checkWarmups(db, now));
  let budget = DRAIN_MAX_PER_RUN - drained;
  if (budget > 0) {
    const b = schema.broadcasts;
    const waiting = await db
      .select({
        id: b.id,
        teamId: b.teamId,
        domainId: sql<
          string | null
        >`(select e.domain_id from emails e where e.broadcast_id = broadcasts.id and e.latest_status = 'queued_quota' limit 1)`,
      })
      .from(b)
      .where(
        and(
          // Sent rows too: a broadcast completed before the status stayed
          // sending until its last row may still hold plan-parked rows.
          inArray(b.status, ["sending", "sent"]),
          sql`exists (select 1 from emails e where e.broadcast_id = broadcasts.id and e.latest_status = 'queued_quota')`,
        ),
      )
      .orderBy(asc(b.scheduledAt), asc(b.createdAt), asc(b.id));
    // Only broadcasts that can move this run share the slices, and a slice
    // is split among the peers of the same region (the room is per region).
    const eligible: { id: string; teamId: string; domainId: string | null; region: string }[] = [];
    for (const broadcast of waiting) {
      const region = (await parkedRegion(db, broadcast.id)) ?? regions[0] ?? "";
      if (deps.sesQuota && (deps.sesQuota.paused?.(region) || deps.sesQuota.exhausted(region))) {
        continue;
      }
      if ((deps.sesQuota?.room?.(region) ?? Number.POSITIVE_INFINITY) <= 0) continue;
      eligible.push({ ...broadcast, region });
    }
    const roomLeft = new Map<string, number>();
    const touched: string[] = [];
    for (const [i, broadcast] of eligible.entries()) {
      if (budget <= 0) break;
      const { region } = broadcast;
      const room =
        roomLeft.get(region) ?? deps.sesQuota?.room?.(region) ?? Number.POSITIVE_INFINITY;
      if (room <= 0) continue;
      const peers = eligible.filter((w, j) => j >= i && w.region === region).length;
      const spacingMs = broadcastSendSpacingMs(
        (await fetchDeliverabilityHealth(db, broadcast.teamId)).status,
      );
      // A dripping team gets one cadence of rows per run, so its slices
      // never stack past the next drain.
      const cap =
        spacingMs > 0 ? Math.floor(SES_QUOTA_SLOT_MS / spacingMs) : Number.POSITIVE_INFINITY;
      // An equal share of what the run and the region can still give; a
      // slice one broadcast cannot use passes down the FIFO.
      const grant = Math.min(Math.ceil(Math.min(budget, room) / peers), cap);
      if (grant <= 0) continue;
      const released = await releaseParkedRows(db, deps, run, {
        where: eq(schema.emails.broadcastId, broadcast.id),
        budget: grant,
        held: [],
        spacingMs,
        bySendOrder: true,
        sender: broadcast,
      });
      drained += released.total;
      budget -= released.total;
      roomLeft.set(region, room - released.total);
      deps.sesQuota?.noteBulkQueued?.(region, released.total);
      const remaining = await parkedByRegion(
        db,
        region,
        eq(schema.emails.broadcastId, broadcast.id),
      );
      console.log(
        `quota.drain: pass=2 region=${region} broadcast=${broadcast.id} room=${room} released=${released.total} remaining=${remaining.get(region) ?? 0}`,
      );
      touched.push(broadcast.id);
    }
    for (const id of touched) await deps.finalize?.(id);
  }
  if (run.failures.length > 0) {
    throw new Error(`quota drain: ${run.failures.length} email(s) failed`, {
      cause: run.failures[0],
    });
  }
  return { drained, stillParked: await countParked(db) };
}

/**
 * One pass over parked rows matching `where`, oldest first, up to `budget`.
 * Keyset pages over (createdAt, id): a row that stays parked (exhausted
 * team, failed enqueue) can never be re-read into an infinite loop, and
 * teams found exhausted leave the page query so one capped team's backlog
 * is never walked row by row. `bySendOrder` first walks the rows a warm-up
 * put in line, by (sendOrder, id), then the rest oldest first. One
 * broadcast's rows share a team and a domain (`sender`): once the run holds
 * either, the rest of its backlog is never read only to be skipped.
 */
async function releaseParkedRows(
  db: Db,
  deps: DrainDeps,
  run: DrainRun,
  opts: {
    where: SQL;
    budget: number;
    held: readonly string[];
    spacingMs: number;
    bySendOrder?: boolean;
    sender?: { teamId: string; domainId: string | null };
  },
): Promise<{ total: number; byRegion: Map<string, number> }> {
  const { sender } = opts;
  const senderHeld = () =>
    sender !== undefined &&
    (run.heldTeams.has(sender.teamId) ||
      run.pausedTeams.has(sender.teamId) ||
      (sender.domainId !== null && run.heldDomains.has(sender.domainId)));
  const regions = deps.sesQuota?.regions ?? [];
  const region = sql<string>`coalesce(${schema.domains.region}, ${regions[0] ?? ""})`;
  const systemMail = sql<boolean>`coalesce(${schema.emails.tags} ? ${SYSTEM_MAIL_TAG}, false)`;
  const byRegion = new Map<string, number>();
  let total = 0;
  const e = schema.emails;
  const passes = opts.bySendOrder
    ? [
        { order: e.sendOrder, where: isNotNull(e.sendOrder) },
        { order: e.createdAt, where: isNull(e.sendOrder) },
      ]
    : [{ order: e.createdAt, where: undefined }];
  for (const pass of passes) {
    let cursorId: string | undefined;
    while (total < opts.budget && !senderHeld()) {
      const page = await db
        .select({
          id: schema.emails.id,
          teamId: schema.emails.teamId,
          domainId: schema.emails.domainId,
          broadcastId: schema.emails.broadcastId,
          ...QUOTA_COLUMNS,
          scheduledAt: schema.emails.scheduledAt,
          to: schema.emails.to,
          cc: schema.emails.cc,
          bcc: schema.emails.bcc,
          region,
          systemMail,
        })
        .from(schema.emails)
        .innerJoin(schema.teams, eq(schema.emails.teamId, schema.teams.id))
        .leftJoin(schema.domains, eq(schema.emails.domainId, schema.domains.id))
        .where(
          and(
            eq(schema.emails.latestStatus, "queued_quota"),
            opts.where,
            pass.where,
            // The operator's holds: a suspended team releases nothing, a paused
            // team releases only its transactional rows, and what screening
            // parked waits for the review list.
            isNull(schema.teams.suspendedAt),
            or(
              isNull(schema.emails.broadcastId),
              isNull(schema.teams.broadcastsPausedByOperatorAt),
            ),
            or(
              isNull(schema.emails.parkReason),
              notInArray(schema.emails.parkReason, [...OPERATOR_PARK_REASONS]),
            ),
            // A row due on a later UTC day is charged on that day, its warm-up
            // included, when it comes: reserved against today, days of the cap
            // could all go out at one future instant.
            or(
              isNull(schema.emails.scheduledAt),
              lt(schema.emails.scheduledAt, nextUtcDayStart(run.now)),
            ),
            run.heldTeams.size > 0
              ? notInArray(schema.emails.teamId, [...run.heldTeams])
              : undefined,
            run.pausedTeams.size > 0
              ? or(notInArray(schema.emails.teamId, [...run.pausedTeams]), systemMail)
              : undefined,
            run.heldDomains.size > 0
              ? or(
                  isNull(schema.emails.domainId),
                  notInArray(schema.emails.domainId, [...run.heldDomains]),
                )
              : undefined,
            opts.held.length > 0 ? notInArray(region, [...opts.held]) : undefined,
            cursorId ? keysetCursorWhere(pass.order, schema.emails.id, cursorId) : undefined,
          ),
        )
        .orderBy(asc(pass.order), asc(schema.emails.id))
        .limit(DRAIN_PAGE);
      const last = page.at(-1);
      if (!last) break;
      cursorId = last.id;
      const moved: MovedEmail[] = [];
      for (const email of page) {
        if (total + moved.length >= opts.budget) break;
        const throttleAt =
          opts.spacingMs > 0
            ? new Date(run.now.getTime() + (total + moved.length) * opts.spacingMs)
            : null;
        const released = await releaseParked(db, deps, email, run, throttleAt);
        if (released) moved.push(released);
      }
      if (moved.length === 0) continue;
      try {
        await deps.enqueueSends(
          moved.map((m) => ({
            emailId: m.id,
            startAfter: m.scheduledAt ?? undefined,
            priority: emailSendPriority(m),
          })),
        );
        total += moved.length;
        for (const m of moved) byRegion.set(m.region, (byRegion.get(m.region) ?? 0) + 1);
      } catch (err) {
        // The page's enqueue is one statement, so it failed whole: "queued"
        // emails with no job would only be picked up by the reconcile sweep;
        // re-park them so the drain retry handles them sooner.
        run.failures.push(err);
        for (const m of moved) {
          // A row a racing send lane already claimed keeps its reservation:
          // refunding it here would credit the team for a send that happened.
          if (await transitionQueueState(db, m.id, { from: "queued", to: "queued_quota" })) {
            await releaseQuota(db, { teamId: m.teamId, count: m.units, quota: m.quota });
          }
        }
        return { total, byRegion };
      }
    }
  }
  return { total, byRegion };
}

/**
 * The owners hear when a domain's warm-up paused itself or finished, once
 * per episode; a mail that fails is logged and never fails the drain.
 */
async function mailWarmupEvents(db: Db, deps: DrainDeps, events: WarmupEvent[]): Promise<void> {
  const { mailer } = deps;
  if (!mailer) return;
  for (const event of events) {
    try {
      const claimed = await claimNotification(db, {
        teamId: event.teamId,
        kind: `${event.kind}:${event.domainId}`,
        periodKey: event.episode,
      });
      if (!claimed) continue;
      const tab = event.kind === "warmup.paused" ? "?tab=warmup" : "";
      await mailOwners(db, mailer, event.teamId, event.kind, (locale) =>
        buildAccountMail({
          kind: event.kind,
          locale,
          url: `${deps.appBaseUrl ?? ""}/domains/${event.domainId}${tab}`,
          values: warmupMailValues(event, locale),
        }),
      );
    } catch (err) {
      console.error(`${event.kind} mail for domain ${event.domainId} skipped`, err);
    }
  }
}

async function countParked(db: Db): Promise<number> {
  const [rest] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.emails)
    .where(eq(schema.emails.latestStatus, "queued_quota"));
  return rest?.n ?? 0;
}

/** Parked rows matching `where`, by region (domain-less rows count as the default). */
async function parkedByRegion(
  db: Db,
  defaultRegion: string,
  where: SQL,
): Promise<Map<string, number>> {
  const region = sql<string>`coalesce(${schema.domains.region}, ${defaultRegion})`;
  const rows = await db
    .select({ region, n: sql<number>`count(*)::int` })
    .from(schema.emails)
    .leftJoin(schema.domains, eq(schema.emails.domainId, schema.domains.id))
    .where(and(eq(schema.emails.latestStatus, "queued_quota"), where))
    // Positional: a bound parameter inside the expression reads as a second
    // expression to the parser when repeated in GROUP BY.
    .groupBy(sql`1`);
  return new Map(rows.map((r) => [r.region, r.n]));
}

/** The region a broadcast's parked rows send from; null when it has none. */
async function parkedRegion(db: Db, broadcastId: string): Promise<string | null> {
  const [row] = await db
    .select({ region: schema.domains.region })
    .from(schema.emails)
    .innerJoin(schema.domains, eq(schema.emails.domainId, schema.domains.id))
    .where(
      and(
        eq(schema.emails.broadcastId, broadcastId),
        eq(schema.emails.latestStatus, "queued_quota"),
      ),
    )
    .limit(1);
  return row?.region ?? null;
}

/** A row moved to "queued" with the reservation it holds, awaiting its job. */
interface MovedEmail {
  id: string;
  teamId: string;
  broadcastId: string | null;
  scheduledAt: Date | null;
  region: string;
  units: number;
  /** The cap the reservation ran against, so a refund lands on the same counter. */
  quota: TeamQuota;
}

/**
 * Reserves quota and moves the email to queued; null when it stays parked.
 * A drip time, when given, lands on the row in the same transaction as the
 * move, so the send handler defers to it and the reconcile sweep leaves it.
 */
async function releaseParked(
  db: Db,
  deps: DrainDeps,
  email: QuotaTeamRow & {
    id: string;
    teamId: string;
    domainId: string | null;
    broadcastId: string | null;
    scheduledAt: Date | null;
    region: string;
    to: string[];
    cc: string[] | null;
    bcc: string[] | null;
    systemMail: boolean;
  },
  run: DrainRun,
  throttleAt: Date | null,
): Promise<MovedEmail | null> {
  if (run.heldTeams.has(email.teamId)) return null;
  const quota = teamQuota(email, deps.isCloud);
  // Charged the way accept charged it: one unit per distinct mailbox.
  const units = countDistinctRecipients(email.to, email.cc, email.bcc);
  const { domainId } = email;
  try {
    // Past the deliverability pause line nothing of the team leaves the
    // drain but its account mail, which goes out whatever the rates: its
    // other transactional rows would only park again at send time, and its
    // broadcast backlog waits for the rates to recover.
    if (!email.systemMail) {
      if (!run.checkedTeams.has(email.teamId)) {
        const held = await deliverabilityHold(db, email.teamId);
        run.checkedTeams.add(email.teamId);
        if (held) run.pausedTeams.add(email.teamId);
      }
      if (run.pausedTeams.has(email.teamId)) return null;
    }
    // Every release passes the sending domain's warm-up too, whatever parked
    // the row: the plan's midnight must not let a young domain burst.
    let warmup: WarmupCap | null = null;
    if (domainId) {
      if (!run.warmups.has(domainId)) {
        run.warmups.set(
          domainId,
          await warmupCap(db, { teamId: email.teamId, domainId, at: run.now }),
        );
      }
      warmup = run.warmups.get(domainId) ?? null;
      if (warmup && (run.warmupFull.has(warmup.key) || run.poolFull.has(warmup.teamId))) {
        run.heldDomains.add(domainId);
        return null;
      }
    }
    // A domain warming up its reputation lets its broadcasts out by the
    // warm-up's day; transactional mail never waits on it.
    let ramp: (WarmupRelease & { released: number }) | null = null;
    if (domainId && email.broadcastId) {
      if (!run.ramps.has(domainId)) {
        const state = await warmupRelease(db, { teamId: email.teamId, domainId, now: run.now });
        run.ramps.set(domainId, state && { ...state, released: 0 });
      }
      ramp = run.ramps.get(domainId) ?? null;
      if (ramp && (ramp.status === "paused" || !ramp.ready || ramp.released + units > ramp.slice)) {
        run.heldDomains.add(domainId);
        return null;
      }
    }
    const outcome = await db
      .transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const reservation = await reserveQuota(txDb, { teamId: email.teamId, count: units, quota });
        if (!reservation.reserved) return "exhausted" as const;
        if (warmup) {
          const held = await reserveWarmup(txDb, warmup, units, utcDay(run.now));
          if (!held.reserved) throw new WarmupHeld(held.full);
        }
        if (
          ramp &&
          domainId &&
          !(await reserveWarmupDay(txDb, {
            domainId,
            day: utcDay(run.now),
            volume: ramp.volume,
            count: units,
          }))
        ) {
          throw new WarmupHeld("ramp");
        }
        const moved = await transitionQueueState(txDb, email.id, {
          from: "queued_quota",
          to: "queued",
        });
        if (!moved) throw new DrainRaced();
        if (throttleAt) {
          await txDb
            .update(schema.emails)
            .set({ scheduledAt: throttleAt })
            .where(eq(schema.emails.id, email.id));
        }
        return "moved" as const;
      })
      .catch((err) => {
        if (err instanceof DrainRaced) return "raced" as const;
        if (err instanceof WarmupHeld) return `${err.full}_full` as const;
        throw err;
      });
    if (outcome === "exhausted") {
      run.heldTeams.add(email.teamId);
      return null;
    }
    if (outcome === "domain_full" || outcome === "pool_full" || outcome === "ramp_full") {
      if (warmup && outcome === "pool_full") run.poolFull.add(warmup.teamId);
      else if (warmup && outcome === "domain_full") run.warmupFull.add(warmup.key);
      if (domainId) run.heldDomains.add(domainId);
      return null;
    }
    if (outcome === "raced") return null;
    if (ramp) ramp.released += units;
    const { id, teamId, broadcastId, region } = email;
    return {
      id,
      teamId,
      broadcastId,
      scheduledAt: throttleAt ?? email.scheduledAt,
      region,
      units,
      quota,
    };
  } catch (err) {
    run.failures.push(err);
    return null;
  }
}

/** Rows per page in the reconcile sweeps. */
const RECONCILE_BATCH = 1000;
/** Sends re-enqueued per sweep; a larger backlog waits for the next run. */
const RECONCILE_MAX_PER_RUN = 20_000;

/**
 * Safety net for the enqueue-after-commit gap: an accepted email whose
 * email.send job was lost (API crashed before enqueueing, drain crashed
 * between commit and enqueue) is re-enqueued. Idempotent by construction —
 * the queue collapses duplicates per emailId while a job is queued, and the
 * send handler's claim makes a stray extra job harmless. Attempts are capped
 * by the queue's dead-letter path, which fails the row after its retries.
 *
 * A claim (sentAt set) that never recorded an SES MessageId is a send
 * interrupted between claim and accept (worker killed mid-flight, or the
 * send cut off at its deadline). Nothing else ever picks such a row up, so
 * after a generous window it is failed with an event and email.failed
 * rather than left queued forever.
 */
export async function reconcileStalledSends(
  db: Db,
  deps: {
    enqueueSends: EnqueueEmailSends;
    enqueueWebhookDelivery?: WebhookEnqueue | undefined;
    now?: Date;
  },
): Promise<number> {
  const now = deps.now ?? new Date();
  const staleBefore = new Date(now.getTime() - 15 * 60 * 1000);
  const e = schema.emails;
  const hooks = webhookBatch(deps.enqueueWebhookDelivery);
  await db.transaction((tx) =>
    endQueuedEmails(tx as unknown as Db, {
      status: "failed",
      where: and(eq(e.latestStatus, "queued"), isNotNull(e.sentAt), lt(e.sentAt, staleBefore)),
      data: { source: "worker", reason: "send_interrupted" },
      now,
      enqueue: hooks.collect,
    }),
  );
  await hooks.flush();
  // A row scheduled for later is waiting by design, not lost; its job is due
  // with it and would only be re-enqueued every sweep until then.
  const stalled = and(
    eq(e.latestStatus, "queued"),
    isNull(e.sentAt),
    lt(e.createdAt, staleBefore),
    or(isNull(e.scheduledAt), lte(e.scheduledAt, now)),
  );
  // Keyset pages over (createdAt, id), capped per run, one enqueue per page.
  let cursorId: string | undefined;
  let requeued = 0;
  while (requeued < RECONCILE_MAX_PER_RUN) {
    const page = await db
      .select({ id: e.id, broadcastId: e.broadcastId, scheduledAt: e.scheduledAt })
      .from(e)
      .where(and(stalled, cursorId ? keysetCursorWhere(e.createdAt, e.id, cursorId) : undefined))
      .orderBy(asc(e.createdAt), asc(e.id))
      .limit(Math.min(RECONCILE_BATCH, RECONCILE_MAX_PER_RUN - requeued));
    const last = page.at(-1);
    if (!last) break;
    cursorId = last.id;
    await deps.enqueueSends(
      page.map((email) => ({
        emailId: email.id,
        startAfter: email.scheduledAt ?? undefined,
        priority: emailSendPriority(email),
      })),
    );
    requeued += page.length;
    if (page.length < RECONCILE_BATCH) break;
  }
  return requeued;
}

/**
 * Nulls body columns past the retention window and stamps bodyPurgedAt;
 * metadata, events, and aggregates keep their own lifecycles. Emails whose
 * scheduled send is still in the future keep their body (the send needs it);
 * everything else past the cutoff is purged unconditionally — retention is
 * a compliance promise, so even a zombie still-queued email loses its body
 * (the send handler then marks it failed on the missing body).
 */
export async function purgeExpiredEmailBodies(
  db: Db,
  params: { defaultRetentionDays: number; now?: Date },
): Promise<number> {
  // Read the instance setting fresh each run so a Settings → Instance change
  // applies to the next purge without a worker restart; NULL falls back to
  // the env-derived default.
  const { emailRetentionDays } = await getInstanceSettings(db);
  const retentionDays = emailRetentionDays ?? params.defaultRetentionDays;
  const now = params.now ?? new Date();
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
  const e = schema.emails;
  // Batched like the metadata purge: a backlog (a shortened retention, a
  // worker outage) must not become one statement returning millions of ids.
  let purged = 0;
  for (;;) {
    const batch = affectedRows(
      await db
        .update(e)
        .set(purgedEmailBodyColumns(now))
        .where(
          inArray(
            e.id,
            db
              .select({ id: e.id })
              .from(e)
              .where(
                and(
                  lt(e.createdAt, cutoff),
                  isNull(e.bodyPurgedAt),
                  or(isNull(e.scheduledAt), lt(e.scheduledAt, cutoff)),
                ),
              )
              .orderBy(asc(e.createdAt))
              .limit(PURGE_BATCH),
          ),
        ),
    );
    purged += batch;
    if (batch < PURGE_BATCH) break;
  }
  return purged;
}

/**
 * Received mail on the content clock (the email bodies' window: instance
 * setting > env default): the sealed raw message and attachment list go,
 * contentPurgedAt is stamped, and the metadata row stays for its own window.
 * After this a received email reads `raw: null`, which is what makes Resend's
 * forward() report the raw content as unavailable.
 */
export async function purgeExpiredReceivedContent(
  db: Db,
  params: { defaultRetentionDays: number; now?: Date },
): Promise<number> {
  const { emailRetentionDays } = await getInstanceSettings(db);
  const retentionDays = emailRetentionDays ?? params.defaultRetentionDays;
  const now = params.now ?? new Date();
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
  const r = schema.receivedEmails;
  let purged = 0;
  for (;;) {
    const batch = affectedRows(
      await db
        .update(r)
        .set({
          rawCiphertext: null,
          rawIv: null,
          rawWrappedDek: null,
          rawKeyVersion: null,
          attachments: null,
          extracted: null,
          contentPurgedAt: now,
        })
        .where(
          inArray(
            r.id,
            db
              .select({ id: r.id })
              .from(r)
              .where(and(lt(r.createdAt, cutoff), isNull(r.contentPurgedAt)))
              .orderBy(asc(r.createdAt))
              .limit(PURGE_BATCH),
          ),
        ),
    );
    purged += batch;
    if (batch < PURGE_BATCH) break;
  }
  return purged;
}

/** Received mail on the metadata clock: whole rows past EMAIL_METADATA_RETENTION_DAYS, in batches. */
export async function purgeExpiredReceivedMetadata(
  db: Db,
  params: { retentionDays: number; now?: Date },
): Promise<number> {
  const now = params.now ?? new Date();
  const cutoff = new Date(now.getTime() - params.retentionDays * DAY_MS);
  const r = schema.receivedEmails;
  let deleted = 0;
  for (;;) {
    const batch = affectedRows(
      await db
        .delete(r)
        .where(
          inArray(
            r.id,
            db
              .select({ id: r.id })
              .from(r)
              .where(lt(r.createdAt, cutoff))
              .orderBy(asc(r.createdAt))
              .limit(PURGE_BATCH),
          ),
        ),
    );
    deleted += batch;
    if (batch < PURGE_BATCH) break;
  }
  return deleted;
}

/**
 * Deletes api_requests rows past the SAME effective retention window as
 * email bodies (instance setting > env default): request logs carry
 * request/response payload fragments, so they age out with content.
 */
export async function purgeExpiredApiRequests(
  db: Db,
  params: { defaultRetentionDays: number; now?: Date },
): Promise<number> {
  const { emailRetentionDays } = await getInstanceSettings(db);
  const retentionDays = emailRetentionDays ?? params.defaultRetentionDays;
  const now = params.now ?? new Date();
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
  const r = schema.apiRequests;
  let purged = 0;
  for (;;) {
    const batch = affectedRows(
      await db
        .delete(r)
        .where(
          inArray(
            r.id,
            db
              .select({ id: r.id })
              .from(r)
              .where(lt(r.createdAt, cutoff))
              .orderBy(asc(r.createdAt))
              .limit(PURGE_BATCH),
          ),
        ),
    );
    purged += batch;
    if (batch < PURGE_BATCH) break;
  }
  return purged;
}

/** Domains whose live DNS is re-checked at most this often (bounds SES/DNS load). */
const REVERIFY_STALE_MS = 10 * 60 * 1000;
/** Upper bound on domains reverified per run; oldest lastCheckedAt first. */
const REVERIFY_BATCH = 100;

export interface ReverifyDomainsDeps {
  clientForRegion: (region: string) => SesIdentityClient;
  resolver: DnsResolver;
  /** The domain.age job, asked again when a domain verifies. */
  enqueueDomainAge?: ((domainId: string) => Promise<void>) | undefined;
  now?: Date;
  batchSize?: number;
}

export interface ReverifyResult {
  checked: number;
  failed: number;
  capped: boolean;
}

/**
 * Background re-verification of sender domains. The send gate keys off the
 * stored domains.status (verifySenderDomain), so a required DNS record removed
 * AFTER a domain verified would keep passing the gate until someone reopened
 * the domain page. Running computeDomainVerification on a schedule closes that
 * window: a verified domain that lost a required record now computes `pending`
 * and is demoted, blocking further sends; a pending domain gone fully live is
 * promoted. Terminally-failed domains are skipped (SES DKIM hard-failed —
 * re-adding is the only path forward); temporary_failure and pending are not.
 *
 * verifiedAt is stamped on first promotion only; a demotion keeps the historical
 * value. One domain's DNS/SES error is caught and logged so it can't abort the
 * batch. The batch is capped and ordered oldest-first, so a cap just defers the
 * freshest-checked domains to the next run rather than dropping any.
 */
export async function reverifyDomains(db: Db, deps: ReverifyDomainsDeps): Promise<ReverifyResult> {
  const now = deps.now ?? new Date();
  const batchSize = deps.batchSize ?? REVERIFY_BATCH;
  const staleBefore = new Date(now.getTime() - REVERIFY_STALE_MS);
  const due = await db
    .select({
      id: schema.domains.id,
      name: schema.domains.name,
      region: schema.domains.region,
      mailFromSubdomain: schema.domains.mailFromSubdomain,
      dkimSelector: schema.domains.dkimSelector,
      dkimPublicKey: schema.domains.dkimPublicKey,
      trackingSubdomain: schema.domains.trackingSubdomain,
      status: schema.domains.status,
      verifiedAt: schema.domains.verifiedAt,
    })
    .from(schema.domains)
    .where(
      and(
        ne(schema.domains.status, "failed"),
        or(isNull(schema.domains.lastCheckedAt), lt(schema.domains.lastCheckedAt, staleBefore)),
      ),
    )
    // Never-checked domains (NULL) are the most stale, so they sort first.
    .orderBy(sql`${schema.domains.lastCheckedAt} asc nulls first`)
    .limit(batchSize + 1);

  const capped = due.length > batchSize;
  const batch = capped ? due.slice(0, batchSize) : due;
  if (capped) {
    console.warn(`domains.reverify: batch capped at ${batchSize}; remainder deferred to next run`);
  }

  let failed = 0;
  for (const domain of batch) {
    try {
      const result = await computeDomainVerification(
        deps.clientForRegion(domain.region),
        deps.resolver,
        domain,
      );
      const { status } = result;
      await db
        .update(schema.domains)
        .set({
          status,
          lastCheckedAt: now,
          ...verificationDbPatch(result, now),
          ...(status === "verified" && !domain.verifiedAt ? { verifiedAt: now } : {}),
        })
        .where(eq(schema.domains.id, domain.id));
      if (status === "verified" && domain.status !== "verified") {
        await deps.enqueueDomainAge?.(domain.id).catch((err) => {
          console.warn(`domains.reverify: ${domain.name} age lookup not queued`, err);
        });
      }
    } catch (err) {
      if ((err as { name?: string }).name === "NotFoundException") {
        // The SES identity is gone (deleted outside the app): the stored
        // status is a lie the send gate would keep trusting. Terminal —
        // re-adding the domain is the only way back.
        await db
          .update(schema.domains)
          .set({ status: "failed", lastCheckedAt: now })
          .where(eq(schema.domains.id, domain.id));
        console.warn(`domains.reverify: ${domain.name} has no SES identity; marked failed`);
        continue;
      }
      failed += 1;
      console.warn(`domains.reverify: ${domain.name} failed`, err);
    }
  }
  return { checked: batch.length, failed, capped };
}

/**
 * Never-verified domains older than this are reaped. SES stops searching DNS
 * for the DKIM records 72 hours after identity creation and hard-fails the
 * identity, so past this window the row can never verify again — deleting it
 * costs its team nothing and frees the (name, region) slot.
 */
const REAP_UNVERIFIED_AFTER_MS = 72 * 60 * 60 * 1000;

/** Sentinel: the domain verified between the sweep select and the delete. */
class ReapRaced extends Error {}

export interface ReapUnverifiedDomainsDeps {
  clientForRegion: (region: string) => SesIdentityClient;
  /** Arms the webhook drain for the failed emails' rows; absent, the reconcile sweep sends them. */
  enqueueWebhookDelivery?: WebhookEnqueue | undefined;
  now?: Date;
}

/**
 * Cloud-only sweep completing the exclusive domain claim: the create path
 * 409s while any team holds (name, region), so an added-but-never-verified
 * domain would squat the slot forever against the real DNS owner. Only rows
 * that never verified are touched — verifiedAt survives demotion, so a domain
 * that verified even once belongs to a team that proved DNS control and is
 * never auto-deleted (its sends are already gated by status).
 *
 * Same guards as a user-initiated delete: the shared SES identity goes only
 * with the last row referencing it, queued emails fail terminally, and
 * domain-scoped api keys are revoked. Before the irreversible identity delete
 * SES itself is asked — DKIM SUCCESS skips the reap — and the row delete is
 * conditioned on verifiedAt still being null, so a promotion racing the sweep
 * keeps both its identity and its row. One domain's failure never blocks the
 * rest; an SES error leaves the row for the next run to retry.
 */
export async function reapUnverifiedDomains(
  db: Db,
  deps: ReapUnverifiedDomainsDeps,
): Promise<number> {
  const now = deps.now ?? new Date();
  const cutoff = new Date(now.getTime() - REAP_UNVERIFIED_AFTER_MS);
  const d = schema.domains;
  const stale = await db
    .select({ id: d.id })
    .from(d)
    .where(and(isNull(d.verifiedAt), lt(d.createdAt, cutoff)))
    .orderBy(asc(d.createdAt));
  let reaped = 0;
  for (const { id } of stale) {
    try {
      const [domain] = await db
        .select({
          id: d.id,
          teamId: d.teamId,
          name: d.name,
          region: d.region,
          sesTenantAssociatedAt: d.sesTenantAssociatedAt,
        })
        .from(d)
        .where(and(eq(d.id, id), isNull(d.verifiedAt)));
      if (!domain) continue;
      if (!(await isIdentitySharedByOtherDomains(db, domain))) {
        try {
          // The stored verifiedAt lags SES by up to a reverify cycle: a DKIM
          // check that succeeded right at SES's 72h deadline may not be
          // stamped yet. SUCCESS is proof the DNS owner published this row's
          // token — never a squatter — so leave it for reverify to promote.
          const live = await getDomainVerification(deps.clientForRegion(domain.region), {
            domain: domain.name,
          });
          if (live.dkimStatus === "SUCCESS") continue;
          if (domain.sesTenantAssociatedAt) {
            await disassociateIdentity(deps.clientForRegion(domain.region), {
              tenantName: domain.teamId,
              region: domain.region,
              identity: domain.name,
            });
          }
          await deleteDomainIdentity(deps.clientForRegion(domain.region), {
            domain: domain.name,
          });
        } catch (err) {
          // An identity already gone from SES must not block removing the row.
          if ((err as { name?: string }).name !== "NotFoundException") throw err;
        }
      }
      const hooks = webhookBatch(deps.enqueueWebhookDelivery);
      const deleted = await db
        .transaction(async (tx) => {
          const txDb = tx as unknown as Db;
          await failQueuedEmailsForDomain(txDb, {
            teamId: domain.teamId,
            domainId: domain.id,
            enqueue: hooks.collect,
          });
          await txDb
            .update(schema.apiKeys)
            .set({ revokedAt: now, domainId: null })
            .where(
              and(eq(schema.apiKeys.teamId, domain.teamId), eq(schema.apiKeys.domainId, domain.id)),
            );
          const rows = await txDb
            .delete(d)
            .where(and(eq(d.id, domain.id), isNull(d.verifiedAt)))
            .returning({ id: d.id });
          if (rows.length === 0) throw new ReapRaced();
          return true;
        })
        .catch((err) => {
          if (err instanceof ReapRaced) return false;
          throw err;
        });
      if (!deleted) continue;
      await hooks.flush();
      await recordAudit(db, {
        teamId: domain.teamId,
        actor: "system",
        action: "domain.deleted",
        target: { type: "domain", id: domain.id },
        metadata: { name: domain.name, region: domain.region, reason: "unverified_expired" },
      });
      reaped += 1;
      console.log(`domains.reap: removed never-verified ${domain.name} (${domain.region})`);
    } catch (err) {
      console.warn(`domains.reap: domain ${id} failed`, err);
    }
  }
  return reaped;
}

export interface ReapTrackingSubdomainsDeps {
  resolver: DnsResolver;
  /** Expected CNAME target (app or edge host); null when it can't be computed. */
  trackingCnameValue: string | null;
  now?: Date;
}

/**
 * Companion to the domain reaper for branded tracking subdomains, which unlike
 * the main DNS records never gate domain status and so are never reverified.
 * A subdomain whose CNAME resolves clears its 72h clock for good — a later DNS
 * flap never re-arms it, mirroring how verifiedAt survives demotion. One still
 * unconfigured 72h after being set is unset, so the domain falls back to the
 * default host cleanly instead of shipping untracked links behind a dead
 * subdomain. A transient resolver failure (unknown) is left for the next run
 * rather than risking a false unset. No-ops when the target host is unknown
 * (no APP_BASE_URL and no tracking edge host).
 */
export async function reapStaleTrackingSubdomains(
  db: Db,
  deps: ReapTrackingSubdomainsDeps,
): Promise<{ verified: number; unset: number }> {
  const target = deps.trackingCnameValue;
  if (!target) return { verified: 0, unset: 0 };
  const now = deps.now ?? new Date();
  const cutoff = new Date(now.getTime() - REAP_UNVERIFIED_AFTER_MS);
  const d = schema.domains;
  const rows = await db
    .select({
      id: d.id,
      name: d.name,
      trackingSubdomain: d.trackingSubdomain,
      setAt: d.trackingSubdomainSetAt,
    })
    .from(d)
    .where(and(isNotNull(d.trackingSubdomain), isNotNull(d.trackingSubdomainSetAt)));
  let verified = 0;
  let unset = 0;
  for (const row of rows) {
    if (!row.trackingSubdomain) continue;
    try {
      const [live] = await checkDnsRecords(
        [{ type: "CNAME", name: `${row.trackingSubdomain}.${row.name}`, value: target }],
        deps.resolver,
      );
      if (live === "found") {
        await db.update(d).set({ trackingSubdomainSetAt: null }).where(eq(d.id, row.id));
        verified += 1;
      } else if ((live === "missing" || live === "mismatch") && row.setAt && row.setAt < cutoff) {
        await db
          .update(d)
          .set({ trackingSubdomain: null, trackingSubdomainSetAt: null })
          .where(eq(d.id, row.id));
        unset += 1;
        console.log(`domains.reap-tracking: unset unverified ${row.trackingSubdomain}.${row.name}`);
      }
    } catch (err) {
      console.warn(`domains.reap-tracking: ${row.name} failed`, err);
    }
  }
  return { verified, unset };
}

/** Rows per statement in the retention loops; keeps each lock window short on a backlog. */
const PURGE_BATCH = 1000;

/**
 * Metadata retention: whole email rows (recipients, subject, headers, tags —
 * events cascade with them) past the metadata window are deleted in batches.
 * Webhook deliveries are a log with their own, shorter window
 * (`deliveryRetentionDays`), purged here on the same schedule.
 * Future-scheduled rows are kept like the body purge does. Env-only
 * windows; no instance setting overrides them.
 */
export async function purgeExpiredEmailMetadata(
  db: Db,
  params: { retentionDays: number; deliveryRetentionDays?: number; now?: Date },
): Promise<{ emails: number; deliveries: number; broadcasts: number }> {
  const now = params.now ?? new Date();
  const cutoff = new Date(now.getTime() - params.retentionDays * DAY_MS);
  const deliveryCutoff = new Date(
    now.getTime() - (params.deliveryRetentionDays ?? params.retentionDays) * DAY_MS,
  );
  const e = schema.emails;
  // Broadcast results outlive the emails they are counted from: a sent
  // broadcast whose fan-out is about to leave the window records its
  // delivered, bounced and complained counts once, before the rows go. Two
  // days of slack cover a fan-out that ran past its sent_at.
  const b = schema.broadcasts;
  const freezeBefore = new Date(cutoff.getTime() + 2 * DAY_MS);
  const broadcasts = affectedRows(
    await db.execute(sql`
    update ${b} set
      recipient_count = coalesce(${b.recipientCount}, s.total),
      delivered_count = s.delivered,
      bounced_count = s.bounced,
      complained_count = s.complained
    from (
      select
        ${e.broadcastId} as broadcast_id,
        count(*)::int as total,
        count(*) filter (where ${deliveredEmail})::int as delivered,
        count(*) filter (where ${e.latestStatus} = 'bounced')::int as bounced,
        count(*) filter (where ${complainedEmail})::int as complained
      from ${e}
      where ${e.broadcastId} in (
        select ${b.id} from ${b}
        where ${b.status} = 'sent' and ${b.sentAt} < ${freezeBefore} and ${b.deliveredCount} is null
      )
      group by ${e.broadcastId}
    ) s
    where ${b.id} = s.broadcast_id
  `),
  );
  let emails = 0;
  for (;;) {
    const batch = affectedRows(
      await db.delete(e).where(
        inArray(
          e.id,
          db
            .select({ id: e.id })
            .from(e)
            .where(
              and(lt(e.createdAt, cutoff), or(isNull(e.scheduledAt), lt(e.scheduledAt, cutoff))),
            )
            .orderBy(asc(e.createdAt))
            .limit(PURGE_BATCH),
        ),
      ),
    );
    emails += batch;
    if (batch < PURGE_BATCH) break;
  }
  const d = schema.webhookDeliveries;
  let deliveries = 0;
  for (;;) {
    const batch = affectedRows(
      await db
        .delete(d)
        .where(
          inArray(
            d.id,
            db
              .select({ id: d.id })
              .from(d)
              .where(lt(d.createdAt, deliveryCutoff))
              .orderBy(asc(d.createdAt))
              .limit(PURGE_BATCH),
          ),
        ),
    );
    deliveries += batch;
    if (batch < PURGE_BATCH) break;
  }
  return { emails, deliveries, broadcasts };
}

/**
 * Content-window strip for provider and webhook payloads, on the SAME
 * effective window as email bodies. email_events.data is the raw SES subset
 * (recipient addresses, diagnostics, remote MTAs) and is dropped whole — the
 * typed `type` column keeps the timeline readable. A `suppressed` event keeps
 * its data: it is only {source, reason}, no personal data, and the dashboard
 * reads its source to tell a refusal at accept, which never stored a body.
 * Webhook deliveries keep their envelope (type, created_at, test marker) and
 * lose `data` and the captured response body.
 */
export async function stripExpiredEventPayloads(
  db: Db,
  params: { defaultRetentionDays: number; now?: Date },
): Promise<{ events: number; deliveries: number }> {
  const { emailRetentionDays } = await getInstanceSettings(db);
  const retentionDays = emailRetentionDays ?? params.defaultRetentionDays;
  const now = params.now ?? new Date();
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
  const ev = schema.emailEvents;
  let events = 0;
  // Each batch resumes after the last row the batch before took, so a kept
  // suppressed row is read once a run rather than once a batch.
  // ponytail: kept rows stay in the unstripped index, so every run still
  // walks them once; a partial index that leaves them out is the upgrade.
  let cursorId: string | undefined;
  for (;;) {
    const page = await db
      .select({ id: ev.id })
      .from(ev)
      .where(
        and(
          lt(ev.occurredAt, cutoff),
          isNotNull(ev.data),
          ne(ev.type, "suppressed"),
          cursorId ? keysetCursorWhere(ev.occurredAt, ev.id, cursorId) : undefined,
        ),
      )
      .orderBy(asc(ev.occurredAt), asc(ev.id))
      .limit(PURGE_BATCH);
    const last = page.at(-1);
    if (!last) break;
    cursorId = last.id;
    events += affectedRows(
      await db
        .update(ev)
        .set({ data: null })
        .where(
          inArray(
            ev.id,
            page.map((row) => row.id),
          ),
        ),
    );
    if (page.length < PURGE_BATCH) break;
  }
  const d = schema.webhookDeliveries;
  let deliveries = 0;
  for (;;) {
    const batch = affectedRows(
      await db
        .update(d)
        .set({ payload: sql`${d.payload} - 'data'`, lastResponseBody: null })
        .where(
          inArray(
            d.id,
            db
              .select({ id: d.id })
              .from(d)
              .where(
                and(
                  lt(d.createdAt, cutoff),
                  or(sql`${d.payload} ? 'data'`, isNotNull(d.lastResponseBody)),
                ),
              )
              .orderBy(asc(d.createdAt))
              .limit(PURGE_BATCH),
          ),
        ),
    );
    deliveries += batch;
    if (batch < PURGE_BATCH) break;
  }
  return { events, deliveries };
}

/** Better Auth never deletes expired sessions; their IP/user-agent would otherwise sit forever. */
/**
 * The hourly counters feed only the 30-day Metrics chart; 45 days covers the
 * window from any timezone. The daily table they mirror is kept forever.
 */
export async function purgeStaleHourlyUsage(db: Db, now = new Date()): Promise<number> {
  const h = schema.usageCountersHourly;
  const cutoff = new Date(now.getTime() - 45 * DAY_MS);
  let purged = 0;
  for (;;) {
    const batch = affectedRows(
      await db
        .delete(h)
        .where(
          inArray(
            sql`(${h.teamId}, ${h.hour})`,
            db
              .select({ teamId: h.teamId, hour: h.hour })
              .from(h)
              .where(lt(h.hour, cutoff))
              .orderBy(asc(h.hour))
              .limit(PURGE_BATCH),
          ),
        ),
    );
    purged += batch;
    if (batch < PURGE_BATCH) break;
  }
  return purged;
}

export async function purgeExpiredSessions(db: Db, now = new Date()): Promise<number> {
  return affectedRows(await db.delete(schema.session).where(lt(schema.session.expiresAt, now)));
}

/**
 * Daily plan reconcile against Stripe for every team with a customer: covers
 * webhooks that were dropped or arrived out of order. One team's failure is
 * logged and never blocks the rest. A plan the reconcile moved is reported
 * through `onPlanMoved`, since the webhook that would have said so never
 * came (or will find nothing left to say when it does).
 */
export async function reconcileBillingPlans(
  db: Db,
  deps: {
    reconcileTeam: (teamId: string) => Promise<void>;
    onPlanMoved?: (
      team: { id: string; name: string },
      before: PlanSnapshot,
      after: PlanSnapshot,
    ) => Promise<void>;
  },
): Promise<{ reconciled: number; failed: number }> {
  const columns = {
    id: schema.teams.id,
    name: schema.teams.name,
    plan: schema.teams.plan,
    planQuota: schema.teams.planQuota,
    currentPeriodEnd: schema.teams.currentPeriodEnd,
    cancelAt: schema.teams.cancelAt,
  };
  const teams = await db
    .select(columns)
    .from(schema.teams)
    .where(isNotNull(schema.teams.stripeCustomerId))
    .orderBy(asc(schema.teams.id));
  let failed = 0;
  for (const team of teams) {
    try {
      await deps.reconcileTeam(team.id);
      if (deps.onPlanMoved) {
        const [after] = await db
          .select(columns)
          .from(schema.teams)
          .where(eq(schema.teams.id, team.id));
        if (after && (after.plan !== team.plan || after.planQuota !== team.planQuota)) {
          await deps.onPlanMoved(team, team, after);
        }
      }
    } catch (err) {
      failed += 1;
      console.warn(`billing.reconcile: team ${team.id} failed`, err);
    }
  }
  return { reconciled: teams.length - failed, failed };
}

/** Daily inbox usage kept: the dashboard reads the last 30 days. */
const INBOX_USAGE_DAYS = 35;

/** Deletes `table` rows matching `where` in PURGE_BATCH slices; how many went. */
async function deleteInBatches(
  db: Db,
  table: typeof schema.inboxActivity | typeof schema.inboxDrafts | typeof schema.inboxThreads,
  where: SQL,
): Promise<number> {
  let deleted = 0;
  for (;;) {
    const batch = affectedRows(
      await db.execute(sql`
        delete from ${table} where id in (select id from ${table} where ${where} limit ${PURGE_BATCH})
      `),
    );
    deleted += batch;
    if (batch < PURGE_BATCH) return deleted;
  }
}

/**
 * The inbox data steps of retention.purge, after the received metadata
 * purge (whose deletes cascade to memberships): threads left empty, draft
 * bodies on the content clock and draft rows on the metadata clock, the
 * activity trail and correspondents on the metadata clock, daily inbox
 * usage past the 30 days the dashboard reads, and received-secret MACs
 * after their day. Counts by step name.
 */
export async function purgeInboxData(
  db: Db,
  p: { contentDays: number; metadataDays: number; now?: Date | undefined },
): Promise<Record<string, number>> {
  const now = p.now ?? new Date();
  const contentCutoff = new Date(now.getTime() - p.contentDays * DAY_MS);
  const metadataCutoff = new Date(now.getTime() - p.metadataDays * DAY_MS);
  const t = schema.inboxThreads;
  const d = schema.inboxDrafts;
  const emptyThreads = await deleteInBatches(
    db,
    t,
    sql`not exists (select 1 from ${schema.receivedEmailInboxes} m where m.thread_id = ${t.id})
      and not exists (select 1 from ${schema.emails} e where e.thread_id = ${t.id})
      and not exists (select 1 from ${d} x where x.thread_id = ${t.id} and x.status in ('draft', 'pending_approval'))`,
  );
  let draftBodies = 0;
  for (;;) {
    const batch = affectedRows(
      await db
        .update(d)
        .set({
          bodyCiphertext: null,
          bodyIv: null,
          bodyWrappedDek: null,
          bodyKeyVersion: null,
          bodyPurgedAt: now,
        })
        .where(
          inArray(
            d.id,
            db
              .select({ id: d.id })
              .from(d)
              .where(and(isNull(d.bodyPurgedAt), lt(d.updatedAt, contentCutoff)))
              .limit(PURGE_BATCH),
          ),
        ),
    );
    draftBodies += batch;
    if (batch < PURGE_BATCH) break;
  }
  const drafts = await deleteInBatches(db, d, sql`${d.updatedAt} < ${metadataCutoff}`);
  const a = schema.inboxActivity;
  const activity = await deleteInBatches(db, a, sql`${a.createdAt} < ${metadataCutoff}`);
  const c = schema.inboxCorrespondents;
  const correspondents = affectedRows(await db.delete(c).where(lt(c.lastSeenAt, metadataCutoff)));
  const u = schema.inboxUsageDaily;
  const usage = affectedRows(
    await db.delete(u).where(lt(u.day, utcDay(now.getTime() - INBOX_USAGE_DAYS * DAY_MS))),
  );
  const rs = schema.receivedSecrets;
  const secrets = affectedRows(
    await db.delete(rs).where(lt(rs.createdAt, new Date(now.getTime() - RECEIVED_SECRET_WINDOW))),
  );
  return {
    inboxEmptyThreads: emptyThreads,
    inboxDraftBodies: draftBodies,
    inboxDrafts: drafts,
    inboxActivity: activity,
    inboxCorrespondents: correspondents,
    inboxUsage: usage,
    receivedSecrets: secrets,
  };
}
