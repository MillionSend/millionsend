import { accountEmailFrom } from "@millionsend/config";
import {
  type AccountMailKind,
  accountLocale,
  accountMailPhrase,
  buildAccountMail,
  CANCEL_REMINDER_DAYS,
  claimNotification,
  clearNotifications,
  DAY_MS,
  type DeliverabilityReason,
  effectivePlan,
  enqueueTeamWebhookDeliveries,
  fetchDeliverabilityHealth,
  formatMailDate,
  formatMailDateTime,
  type MailLocale,
  nextUtcDayStart,
  PAUSE_BOUNCE_RATE,
  PAUSE_COMPLAINT_RATE,
  PLAN_DAILY_LIMIT,
  PLAN_NAME,
  type PlanSnapshot,
  parseAuditActor,
  planCapPhrase,
  planMove,
  QUOTA_TOLERANCE,
  resultRows,
  type SystemMailKind,
  utcDay,
  WARN_BOUNCE_RATE,
  WARN_COMPLAINT_RATE,
  WEBHOOK_BACKLOG_AGE_MS,
  WEBHOOK_BACKLOG_COUNT,
  WEBHOOK_FAILING_STREAK,
  type WebhookEnqueue,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import {
  and,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  like,
  lt,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import {
  deliverabilityPausedMail,
  deliverabilityWarningMail,
  type MailContent,
  quotaPausedMail,
  quotaReachedMail,
  quotaWarningMail,
  webhookAutoDisabledMail,
  webhookBacklogMail,
  webhookFailingMail,
} from "../notifications/templates.js";
import { mailOwners as mailTeamOwners, type SystemMailer } from "../system-mail.js";
import { COUNTED_SETTLED_SQL, WEBHOOK_AUTO_DISABLE_AFTER } from "./deliver-webhook.js";

export interface NotifyDeps {
  isCloud: boolean;
  mailer: SystemMailer;
  enqueueWebhook: WebhookEnqueue;
  appBaseUrl?: string | undefined;
  now?: Date;
}

/** Share of the daily quota at which owners hear about it. */
export const QUOTA_WARNING_RATIO = 0.8;
/** Audit actions owners hear about; rows older than a day are never read. */
const AUDIT_MAILED = ["api_key.created", "webhook.secret_rotated", "member.joined"] as const;
type AuditMailed = (typeof AUDIT_MAILED)[number];
/**
 * A deliverability episode ends only once the 7-day rates are this far under
 * the warning lines: a sender hovering at the line would otherwise be
 * re-notified on every crossing, one sweep apart.
 */
export const DELIVERABILITY_CLEAR_RATIO = 0.9;

type NotificationType =
  | "quota.warning"
  | "quota.reached"
  | "quota.paused"
  | "deliverability.warning"
  | "deliverability.paused"
  | "webhook.failing"
  | "webhook.auto_disabled"
  | "webhook.backlog";

interface EndpointStanding {
  id: string;
  url: string;
  status: "enabled" | "auto_disabled";
  team_id: string;
  team: string;
  settled: number;
  succeeded: number;
  newest_ok: boolean;
  queued: number;
  oldest_ms: number | null;
}

/**
 * Every live endpoint with the two facts the webhook notifications judge:
 * its last WEBHOOK_FAILING_STREAK counted settled deliveries (off the
 * settled index; see COUNTED_SETTLED_SQL) and its open backlog, counted no
 * further than WEBHOOK_BACKLOG_COUNT + 1 rows down the due index for the
 * mail's figure. One statement for the whole sweep.
 * ponytail: unpaged; page by endpoint id if endpoints ever number in the
 * tens of thousands.
 */
async function endpointStandings(db: Db): Promise<EndpointStanding[]> {
  const d = schema.webhookDeliveries;
  const e = schema.webhookEndpoints;
  const t = schema.teams;
  return resultRows<EndpointStanding>(
    await db.execute(sql`
      select ${e.id} as id, ${e.url} as url, ${e.status} as status,
             ${e.teamId} as team_id, ${t.name} as team,
             recent.settled, recent.succeeded, recent.newest_ok,
             open.queued, open.oldest_ms
      from ${e}
      inner join ${t} on ${t.id} = ${e.teamId}
      cross join lateral (
        select count(*)::int as settled,
               count(*) filter (where r.status = 'success')::int as succeeded,
               coalesce(bool_or(r.status = 'success' and r.rn = 1), false) as newest_ok
        from (
          select ${d.status} as status,
                 row_number() over (order by ${d.createdAt} desc nulls last, ${d.id} desc nulls last) as rn
          from ${d}
          where ${d.endpointId} = ${e.id} and ${COUNTED_SETTLED_SQL}
          order by ${d.createdAt} desc nulls last, ${d.id} desc nulls last
          limit ${WEBHOOK_FAILING_STREAK}
        ) r
      ) recent
      cross join lateral (
        select count(*)::int as queued,
               (extract(epoch from min(q.at)) * 1000)::float8 as oldest_ms
        from (
          select ${d.nextAttemptAt} as at
          from ${d}
          where ${d.endpointId} = ${e.id}
            and ${d.status} in ('pending', 'failed')
            and ${d.nextAttemptAt} is not null
          order by ${d.nextAttemptAt}
          limit ${WEBHOOK_BACKLOG_COUNT + 1}
        ) q
      ) open
      where ${e.status} in ('enabled', 'auto_disabled')
    `),
  );
}

const lineFor = (r: DeliverabilityReason): number =>
  r.tier === "paused"
    ? r.metric === "bounce"
      ? PAUSE_BOUNCE_RATE
      : PAUSE_COMPLAINT_RATE
    : r.metric === "bounce"
      ? WARN_BOUNCE_RATE
      : WARN_COMPLAINT_RATE;

/**
 * Mails a plan move to the team's owners, claimed with the key the Stripe
 * webhook route computes for the same move, so whichever surface notices
 * first (the route, the daily reconcile, the grace sweep) is the one that
 * speaks. True when it did.
 */
export async function reportPlanMove(
  db: Db,
  mailer: SystemMailer,
  base: string,
  team: { id: string; name: string },
  before: PlanSnapshot,
  after: PlanSnapshot,
): Promise<boolean> {
  const move = planMove(before, after);
  if (!move) return false;
  const claimed = await claimNotification(db, {
    teamId: team.id,
    kind: move.kind,
    periodKey: move.periodKey,
  });
  if (!claimed) return false;
  await mailTeamOwners(db, mailer, team.id, move.kind, (locale) =>
    buildAccountMail({
      kind: move.kind,
      locale,
      url: `${base}/settings/billing`,
      values: move.values(locale, team.name),
    }),
  );
  return true;
}

/**
 * One pass over every team's standing: quota (cloud only) and deliverability.
 * Runs on a schedule rather than inline in the send paths so API, SMTP,
 * broadcast fan-out and the midnight drain share one detector; the claim
 * table makes each notification fire once per period or episode no matter
 * how many passes see the same condition. Returns how many went out.
 */
export async function sweepNotifications(db: Db, deps: NotifyDeps): Promise<{ sent: number }> {
  const now = deps.now ?? new Date();
  const base = deps.appBaseUrl ?? "";
  let sent = 0;

  // The claim is already taken, so a failing side effect is logged and
  // skipped rather than retried: at-most-once, and one team's broken mail
  // never stops the sweep for the others.
  const attempt = async (
    teamId: string,
    type: SystemMailKind,
    what: string,
    fn: () => Promise<void>,
  ) => {
    try {
      await fn();
    } catch (err) {
      console.error(`notifications.sweep: ${type} for team ${teamId} failed (${what})`, err);
    }
  };
  const mailOwners = async (
    teamId: string,
    kind: SystemMailKind,
    mail: MailContent | ((locale: MailLocale) => MailContent),
    opts?: { except?: string; also?: { email: string; locale: MailLocale } },
  ) => {
    await mailTeamOwners(
      db,
      deps.mailer,
      teamId,
      kind,
      typeof mail === "function" ? mail : () => mail,
      opts,
    );
    sent += 1;
  };
  const account =
    (kind: AccountMailKind, path: string, values: (locale: MailLocale) => Record<string, string>) =>
    (locale: MailLocale) =>
      buildAccountMail({ kind, locale, url: `${base}${path}`, values: values(locale) });
  const notify = async (
    teamId: string,
    type: Exclude<NotificationType, `webhook.${string}`>,
    data: Record<string, unknown>,
    mail: MailContent,
  ) => {
    await attempt(teamId, type, "webhook", () =>
      enqueueTeamWebhookDeliveries(db, {
        teamId,
        type,
        occurredAt: now,
        data,
        enqueue: deps.enqueueWebhook,
      }),
    );
    await mailOwners(teamId, type, mail);
  };

  // Webhook trouble goes out by mail only: the endpoint in trouble is the one
  // that would have received the event.
  const today = utcDay(now.getTime());
  // Backlog claims are per UTC day and nothing else clears them.
  await db
    .delete(schema.teamNotifications)
    .where(
      and(
        like(schema.teamNotifications.kind, "webhook.backlog:%"),
        lt(schema.teamNotifications.periodKey, today),
      ),
    );
  const webhookClaims = new Set(
    (
      await db
        .select({ teamId: schema.teamNotifications.teamId, kind: schema.teamNotifications.kind })
        .from(schema.teamNotifications)
        .where(
          or(
            like(schema.teamNotifications.kind, "webhook.failing:%"),
            like(schema.teamNotifications.kind, "webhook.auto_disabled:%"),
          ),
        )
    ).map((c) => `${c.teamId}:${c.kind}`),
  );
  const clearIfClaimed = async (teamId: string, kind: string) => {
    if (webhookClaims.has(`${teamId}:${kind}`)) await clearNotifications(db, { teamId, kind });
  };
  for (const e of await endpointStandings(db)) {
    const teamId = e.team_id;
    const input = { team: e.team, endpoint: e.url, url: `${base}/webhooks/${e.id}` };
    const failingKind = `webhook.failing:${e.id}`;
    const disabledKind = `webhook.auto_disabled:${e.id}`;
    if (e.status === "auto_disabled") {
      if (await claimNotification(db, { teamId, kind: disabledKind, periodKey: "episode" })) {
        await mailOwners(
          teamId,
          "webhook.auto_disabled",
          webhookAutoDisabledMail({ ...input, after: WEBHOOK_AUTO_DISABLE_AFTER }),
        );
      }
      continue;
    }
    await clearIfClaimed(teamId, disabledKind);
    if (e.newest_ok) await clearIfClaimed(teamId, failingKind);
    if (
      e.settled >= WEBHOOK_FAILING_STREAK &&
      e.succeeded === 0 &&
      (await claimNotification(db, { teamId, kind: failingKind, periodKey: "episode" }))
    ) {
      await mailOwners(
        teamId,
        "webhook.failing",
        webhookFailingMail({
          ...input,
          streak: WEBHOOK_FAILING_STREAK,
          disableAfter: WEBHOOK_AUTO_DISABLE_AFTER,
        }),
      );
    }
    const oldestAgeMs = e.oldest_ms === null ? 0 : now.getTime() - e.oldest_ms;
    if (
      oldestAgeMs > WEBHOOK_BACKLOG_AGE_MS &&
      (await claimNotification(db, { teamId, kind: `webhook.backlog:${e.id}`, periodKey: today }))
    ) {
      await mailOwners(
        teamId,
        "webhook.backlog",
        webhookBacklogMail({ ...input, queued: e.queued, cap: WEBHOOK_BACKLOG_COUNT, oldestAgeMs }),
      );
    }
  }

  if (deps.isCloud) {
    const rows = await db
      .select({
        teamId: schema.usageCounters.teamId,
        accepted: schema.usageCounters.accepted,
        name: schema.teams.name,
        plan: schema.teams.plan,
        currentPeriodEnd: schema.teams.currentPeriodEnd,
      })
      .from(schema.usageCounters)
      .innerJoin(schema.teams, eq(schema.teams.id, schema.usageCounters.teamId))
      .where(and(eq(schema.usageCounters.day, today), gt(schema.usageCounters.accepted, 0)));
    for (const row of rows) {
      const limit = PLAN_DAILY_LIMIT[effectivePlan(row.plan, row.currentPeriodEnd, now)];
      if (limit === null) continue;
      // The ceiling is where reserveDailyQuota starts parking: reaching it
      // means new sends now wait for the reset (or a higher plan).
      const ceiling = Math.floor(limit * (1 + QUOTA_TOLERANCE));
      const kind =
        row.accepted >= ceiling
          ? "quota.paused"
          : row.accepted >= limit
            ? "quota.reached"
            : row.accepted >= Math.ceil(limit * QUOTA_WARNING_RATIO)
              ? "quota.warning"
              : null;
      if (!kind) continue;
      if (!(await claimNotification(db, { teamId: row.teamId, kind, periodKey: today }))) continue;
      const resetsAt = nextUtcDayStart(now.getTime());
      const url = `${base}/settings/billing`;
      const input = { team: row.name, used: row.accepted, limit, ceiling, resetsAt, url };
      await notify(
        row.teamId,
        kind,
        {
          used: row.accepted,
          limit,
          ceiling,
          resets_at: resetsAt.toISOString(),
          dashboard_url: url,
        },
        kind === "quota.paused"
          ? quotaPausedMail(input)
          : kind === "quota.reached"
            ? quotaReachedMail(input)
            : quotaWarningMail(input),
      );
    }
  }

  const since = utcDay(now.getTime() - 6 * DAY_MS);
  const senders = await db
    .selectDistinct({ teamId: schema.usageCounters.teamId, name: schema.teams.name })
    .from(schema.usageCounters)
    .innerJoin(schema.teams, eq(schema.teams.id, schema.usageCounters.teamId))
    .where(and(gte(schema.usageCounters.day, since), sql`${schema.usageCounters.sent} > 0`));
  // A team with no sends left in the window has nothing to judge: its episode
  // is over even though the loop below never sees it.
  const observed = new Set(senders.map((t) => t.teamId));
  const claimants = await db
    .selectDistinct({ teamId: schema.teamNotifications.teamId })
    .from(schema.teamNotifications)
    .where(eq(schema.teamNotifications.kind, "deliverability"));
  for (const { teamId } of claimants) {
    if (!observed.has(teamId)) await clearNotifications(db, { teamId, kind: "deliverability" });
  }
  for (const team of senders) {
    const health = await fetchDeliverabilityHealth(db, team.teamId, { now });
    if (health.status === "ok") {
      if (
        health.bounceRate < DELIVERABILITY_CLEAR_RATIO * WARN_BOUNCE_RATE &&
        health.complaintRate < DELIVERABILITY_CLEAR_RATIO * WARN_COMPLAINT_RATE
      ) {
        await clearNotifications(db, { teamId: team.teamId, kind: "deliverability" });
      }
      continue;
    }
    const reason = health.reasons.find((r) => r.tier === health.status) ?? health.reasons[0];
    if (!reason) continue;
    const claimed = await claimNotification(db, {
      teamId: team.teamId,
      kind: "deliverability",
      periodKey: health.status,
    });
    if (!claimed) continue;
    const limit = lineFor(reason);
    const url = `${base}/metrics`;
    const input = {
      team: team.name,
      metric: reason.metric,
      rate: reason.rate,
      limit,
      windowDays: reason.windowDays,
      url,
    };
    await notify(
      team.teamId,
      health.status === "paused" ? "deliverability.paused" : "deliverability.warning",
      {
        metric: reason.metric,
        rate: reason.rate,
        limit,
        window_days: reason.windowDays,
        dashboard_url: url,
      },
      health.status === "paused"
        ? deliverabilityPausedMail(input)
        : deliverabilityWarningMail(input),
    );
  }

  // Sender domains: verification gained or lost is an episode per domain,
  // whichever surface moved it (dashboard, REST, the re-verify sweep). Only
  // domains that verified at least once take part; a domain that never did
  // has nothing to lose yet.
  const domainRows = await db
    .select({
      id: schema.domains.id,
      name: schema.domains.name,
      teamId: schema.domains.teamId,
      status: schema.domains.status,
    })
    .from(schema.domains)
    .where(isNotNull(schema.domains.verifiedAt));
  const domainClaims = await db
    .select({ teamId: schema.teamNotifications.teamId, kind: schema.teamNotifications.kind })
    .from(schema.teamNotifications)
    .where(like(schema.teamNotifications.kind, "domain.%"));
  const domainClaimed = new Set(domainClaims.map((c) => `${c.teamId}:${c.kind}`));
  const liveDomains = new Set(domainRows.map((d) => d.id));
  for (const c of domainClaims) {
    if (!liveDomains.has(c.kind.slice(c.kind.indexOf(":") + 1))) {
      await clearNotifications(db, { teamId: c.teamId, kind: c.kind });
    }
  }
  for (const d of domainRows) {
    const gained = `domain.verified:${d.id}`;
    const lost = `domain.lost:${d.id}`;
    const values = () => ({ domain: d.name });
    if (d.status === "verified") {
      if (domainClaimed.has(`${d.teamId}:${lost}`)) {
        await clearNotifications(db, { teamId: d.teamId, kind: lost });
      }
      if (await claimNotification(db, { teamId: d.teamId, kind: gained, periodKey: "episode" })) {
        await mailOwners(
          d.teamId,
          "domain.verified",
          account("domain.verified", `/domains/${d.id}`, values),
        );
      }
      continue;
    }
    if (domainClaimed.has(`${d.teamId}:${gained}`)) {
      await clearNotifications(db, { teamId: d.teamId, kind: gained });
    }
    if (await claimNotification(db, { teamId: d.teamId, kind: lost, periodKey: "episode" })) {
      // SES marks a domain failed for good when its identity is gone or it
      // gave up on the records; anything else is a record that can come back.
      const kind = d.status === "failed" ? "domain.lost.identity" : "domain.lost";
      const path = d.status === "failed" ? "/domains" : `/domains/${d.id}`;
      await mailOwners(d.teamId, kind, account(kind, path, values));
    }
  }

  // Security receipts off the audit trail, one per row. A row for a team
  // that is gone is skipped by the join; claims for rows that left the
  // window are dropped, since those rows are never read again.
  const auditSince = new Date(now.getTime() - DAY_MS);
  const auditActions = [...AUDIT_MAILED];
  await db.delete(schema.teamNotifications).where(
    and(
      inArray(schema.teamNotifications.kind, auditActions),
      notInArray(
        schema.teamNotifications.periodKey,
        db
          .select({ id: sql<string>`${schema.auditLog.id}::text` })
          .from(schema.auditLog)
          .where(
            and(
              inArray(schema.auditLog.action, auditActions),
              gt(schema.auditLog.createdAt, auditSince),
            ),
          ),
      ),
    ),
  );
  const auditRows = await db
    .select({
      id: schema.auditLog.id,
      teamId: schema.teams.id,
      team: schema.teams.name,
      actorId: schema.auditLog.actorId,
      action: schema.auditLog.action,
      target: schema.auditLog.target,
      data: schema.auditLog.data,
    })
    .from(schema.auditLog)
    .innerJoin(schema.teams, eq(schema.teams.id, schema.auditLog.teamId))
    .where(
      and(inArray(schema.auditLog.action, auditActions), gt(schema.auditLog.createdAt, auditSince)),
    )
    .orderBy(schema.auditLog.createdAt);
  const from = accountEmailFrom();
  for (const row of auditRows) {
    const action = row.action as AuditMailed;
    if (!(await claimNotification(db, { teamId: row.teamId, kind: action, periodKey: row.id }))) {
      continue;
    }
    await attempt(row.teamId, action, `audit row ${row.id}`, async () => {
      const targetId = row.target?.slice(row.target.indexOf(":") + 1) ?? "";
      const data = row.data ?? {};
      const actor = parseAuditActor(row.actorId);
      const actorUser =
        actor.kind === "user"
          ? (
              await db
                .select({
                  name: schema.user.name,
                  email: schema.user.email,
                  // Still a member: someone removed since must not learn the key's prefix and last four.
                  member: sql<boolean>`exists (select 1 from ${schema.teamMembers} where ${schema.teamMembers.teamId} = ${row.teamId} and ${schema.teamMembers.userId} = ${actor.id})`,
                })
                .from(schema.user)
                .where(eq(schema.user.id, actor.id))
            )[0]
          : undefined;
      const actorLabel = (locale: MailLocale) =>
        actorUser
          ? actorUser.name || actorUser.email
          : accountMailPhrase({
              locale,
              kind: "api_key.created",
              key:
                actor.kind === "api_key"
                  ? "apiKeyActor"
                  : actor.kind === "oauth"
                    ? "mcpActor"
                    : "systemActor",
            });
      if (action === "api_key.created") {
        const [key] = await db
          .select({
            name: schema.apiKeys.name,
            prefix: schema.apiKeys.tokenPrefix,
            last4: schema.apiKeys.last4,
            permission: schema.apiKeys.permission,
            domainId: schema.apiKeys.domainId,
          })
          .from(schema.apiKeys)
          .where(eq(schema.apiKeys.id, targetId));
        if (!key) throw new Error("api key row missing");
        const [domain] = key.domainId
          ? await db
              .select({ name: schema.domains.name })
              .from(schema.domains)
              .where(eq(schema.domains.id, key.domainId))
          : [];
        await mailOwners(
          row.teamId,
          action,
          account(action, "/api-keys", (locale) => ({
            team: row.team,
            actor: actorLabel(locale),
            name: typeof data.name === "string" ? data.name : key.name,
            prefix: key.prefix,
            last4: key.last4,
            permission: accountMailPhrase({ locale, kind: action, key: key.permission }),
            scope: domain
              ? accountMailPhrase({
                  locale,
                  kind: action,
                  key: "scope",
                  values: { domain: domain.name },
                })
              : "",
          })),
          actorUser?.member
            ? {
                also: {
                  email: actorUser.email,
                  locale: await accountLocale(db, from, actorUser.email),
                },
              }
            : undefined,
        );
      } else if (action === "webhook.secret_rotated") {
        const url = typeof data.url === "string" ? data.url : "";
        const expires =
          typeof data.previousSecretExpiresAt === "string"
            ? new Date(data.previousSecretExpiresAt)
            : null;
        let host = url;
        try {
          host = new URL(url).host;
        } catch {}
        await mailOwners(
          row.teamId,
          action,
          account(action, `/webhooks/${targetId}`, (locale) => ({
            team: row.team,
            actor: actorLabel(locale),
            url,
            host,
            deadline: expires
              ? accountMailPhrase({
                  locale,
                  kind: action,
                  key: "overlap",
                  values: { until: formatMailDateTime(locale, expires) },
                })
              : accountMailPhrase({ locale, kind: action, key: "immediately" }),
          })),
        );
      } else {
        const [joiner] = await db
          .select({ name: schema.user.name, email: schema.user.email })
          .from(schema.user)
          .where(eq(schema.user.id, targetId));
        if (!joiner) throw new Error("joined user missing");
        const role = typeof data.role === "string" ? data.role : "member";
        await mailOwners(
          row.teamId,
          action,
          account(action, "/settings", (locale) => ({
            team: row.team,
            name: joiner.name || joiner.email,
            email: joiner.email,
            role: accountMailPhrase({ locale, kind: action, key: role }),
          })),
          { except: joiner.email },
        );
      }
    });
  }

  if (deps.isCloud) {
    // Paid plans: a cancellation a few days out, and a period that lapsed
    // past its grace without Stripe saying so (the day effectivePlan starts
    // answering free). The downgrade claim is keyed by the period end, the
    // key the webhook route uses, so whichever notices first is the one.
    const freeCap = (locale: MailLocale) => (PLAN_DAILY_LIMIT.free ?? 0).toLocaleString(locale);
    const paid = await db
      .select({
        id: schema.teams.id,
        name: schema.teams.name,
        plan: schema.teams.plan,
        currentPeriodEnd: schema.teams.currentPeriodEnd,
        cancelAt: schema.teams.cancelAt,
      })
      .from(schema.teams)
      .where(ne(schema.teams.plan, "free"));
    for (const t of paid) {
      const endsAt = t.cancelAt;
      if (
        endsAt &&
        endsAt.getTime() > now.getTime() &&
        endsAt.getTime() <= now.getTime() + CANCEL_REMINDER_DAYS * DAY_MS &&
        (await claimNotification(db, {
          teamId: t.id,
          kind: "billing.cancel_reminder",
          periodKey: endsAt.toISOString(),
        }))
      ) {
        await mailOwners(
          t.id,
          "billing.cancel_reminder",
          account("billing.cancel_reminder", "/settings/billing", (locale) => ({
            team: t.name,
            plan: PLAN_NAME[t.plan],
            date: formatMailDate(locale, endsAt),
            cap: planCapPhrase(locale, t.plan),
            freeCap: freeCap(locale),
          })),
        );
      }
      if (
        t.currentPeriodEnd &&
        effectivePlan(t.plan, t.currentPeriodEnd, now) === "free" &&
        (await reportPlanMove(db, deps.mailer, base, t, t, { ...t, plan: "free" }))
      ) {
        sent += 1;
      }
    }
  }

  return { sent };
}
