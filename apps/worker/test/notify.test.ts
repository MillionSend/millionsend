import { randomBytes, randomUUID } from "node:crypto";
import {
  EnvKeyring,
  encryptWebhookSecret,
  formatMailDate,
  generateWebhookSecret,
  type QueuedWebhookDelivery,
  utcDay,
  WEBHOOK_MAX_ATTEMPTS,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq, like, sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sweepNotifications } from "../src/handlers/notify.js";
import { createSystemMailer } from "../src/system-mail.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;
let sends: { to: string; subject: string; text: string }[];
let enqueued: string[];

const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "notify-team");
  await db.insert(schema.user).values({ id: "owner", name: "Owner", email: "owner@example.com" });
  await db.insert(schema.teamMembers).values({ teamId, userId: "owner", role: "owner" });
  const id = randomUUID();
  const secret = generateWebhookSecret();
  const encrypted = await encryptWebhookSecret(secret, keyring, { teamId, rowId: id });
  await db.insert(schema.webhookEndpoints).values({
    id,
    teamId,
    url: "https://receiver.example.com/hook",
    secretCiphertext: encrypted.ciphertext,
    secretIv: encrypted.iv,
    secretWrappedDek: encrypted.wrappedDek,
    secretKeyVersion: encrypted.keyVersion,
    secretLast4: secret.slice(-4),
    events: null,
  });
  sends = [];
  enqueued = [];
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await close();
});

const deps = (isCloud = true, now?: Date) => ({
  isCloud,
  mailer: {
    send: async (to: string, m: { subject: string; text: string }) => {
      sends.push({ to, subject: m.subject, text: m.text });
    },
  },
  enqueueWebhook: async (rows: readonly QueuedWebhookDelivery[]) => {
    enqueued.push(...rows.map((r) => r.id));
  },
  appBaseUrl: "https://app.example.test",
  ...(now ? { now } : {}),
});

async function counters(
  values: Partial<typeof schema.usageCounters.$inferInsert>,
  day = utcDay(),
  team = teamId,
) {
  await db
    .insert(schema.usageCounters)
    .values({ teamId: team, day, ...values })
    .onConflictDoUpdate({
      target: [schema.usageCounters.teamId, schema.usageCounters.day],
      set: values,
    });
}

async function deliveries() {
  return db
    .select({ type: schema.webhookDeliveries.eventType, payload: schema.webhookDeliveries.payload })
    .from(schema.webhookDeliveries);
}

it("quota warning at 80% fires once per UTC day, by email and webhook", async () => {
  await counters({ accepted: 80 });
  expect(await sweepNotifications(db, deps())).toEqual({ sent: 1 });
  expect(sends).toHaveLength(1);
  expect(sends[0]).toMatchObject({ to: "owner@example.com" });
  expect(sends[0]?.subject).toContain("80%");
  const rows = await deliveries();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.type).toBe("quota.warning");
  expect(rows[0]?.payload).toMatchObject({
    type: "quota.warning",
    data: {
      used: 80,
      limit: 100,
      period: "day",
      dashboard_url: "https://app.example.test/settings/billing",
    },
  });
  expect(enqueued).toHaveLength(1);

  expect(await sweepNotifications(db, deps())).toEqual({ sent: 0 });
  expect(sends).toHaveLength(1);
});

it("quota reached fires once, on top of the earlier warning", async () => {
  await counters({ accepted: 80 });
  await sweepNotifications(db, deps());
  await counters({ accepted: 105 });
  expect(await sweepNotifications(db, deps())).toEqual({ sent: 1 });
  expect(sends.map((s) => s.subject)).toEqual([
    expect.stringContaining("80%"),
    expect.stringContaining("quota reached"),
  ]);
  // 105 accepted against a 150 ceiling: the mail states the real headroom.
  expect(sends[1]?.text).toContain("45 more still go out today");
  expect(sends[1]?.text).toContain("50% past the quota");
  expect((await deliveries()).map((d) => d.type)).toEqual(["quota.warning", "quota.reached"]);
  expect(await sweepNotifications(db, deps())).toEqual({ sent: 0 });
});

it("quota paused fires once when the ceiling is reached, after warning and reached", async () => {
  await counters({ accepted: 80 });
  await sweepNotifications(db, deps());
  await counters({ accepted: 100 });
  await sweepNotifications(db, deps());
  await counters({ accepted: 150 });
  expect(await sweepNotifications(db, deps())).toEqual({ sent: 1 });
  expect(sends.map((s) => s.subject)).toEqual([
    expect.stringContaining("80%"),
    expect.stringContaining("quota reached"),
    expect.stringContaining("sending paused until the quota resets"),
  ]);
  expect(sends[2]?.text).toContain("50% past its 100 quota");
  expect((await deliveries()).map((d) => d.type)).toEqual([
    "quota.warning",
    "quota.reached",
    "quota.paused",
  ]);
  expect(await sweepNotifications(db, deps())).toEqual({ sent: 0 });
});

async function monthlyPlan(overage = false) {
  const periodStart = new Date(Date.now() - 10 * DAY);
  const periodEnd = new Date(Date.now() + 20 * DAY);
  await db
    .update(schema.teams)
    .set({
      plan: "pro",
      planQuota: 100_000,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      overageEnabled: overage,
    })
    .where(eq(schema.teams.id, teamId));
  const used = async (accepted: number) => {
    await db
      .insert(schema.usagePeriods)
      .values({ teamId, periodStart, accepted })
      .onConflictDoUpdate({
        target: [schema.usagePeriods.teamId, schema.usagePeriods.periodStart],
        set: { accepted },
      });
  };
  return { periodStart, periodEnd, used };
}

it("monthly quota warning and reached fire once per billing period, with the period in the payload", async () => {
  const { periodStart, periodEnd, used } = await monthlyPlan();
  // The day's counter is uncapped on a monthly plan: no daily notice.
  await counters({ accepted: 5_000 });
  await used(80_000);
  expect(await sweepNotifications(db, deps())).toEqual({ sent: 1 });
  expect(sends[0]?.subject).toContain("80% of this period's sending quota");
  expect(sends[0]?.text).toContain("80,000 of the 100,000 emails");
  expect(sends[0]?.text).toContain(formatMailDate("en", periodEnd));
  expect(sends[0]?.text).toContain("Turn on overage in Billing");
  const [row] = await deliveries();
  expect(row?.type).toBe("quota.warning");
  expect(row?.payload).toMatchObject({
    data: {
      used: 80_000,
      limit: 100_000,
      period: "month",
      overage: false,
      resets_at: periodEnd.toISOString(),
      dashboard_url: "https://app.example.test/settings/billing",
    },
  });
  expect(await sweepNotifications(db, deps())).toEqual({ sent: 0 });

  await used(100_000);
  expect(await sweepNotifications(db, deps())).toEqual({ sent: 1 });
  expect(sends[1]?.subject).toContain("this period's sending quota reached");
  expect(sends[1]?.text).toContain(
    `New API sends are refused until the period renews on ${formatMailDate("en", periodEnd)} or overage is turned on in Billing; broadcasts park until then.`,
  );
  expect((await deliveries()).map((d) => d.type)).toEqual(["quota.warning", "quota.reached"]);
  expect(
    (
      await db
        .select({ kind: schema.teamNotifications.kind, key: schema.teamNotifications.periodKey })
        .from(schema.teamNotifications)
        .where(like(schema.teamNotifications.kind, "quota.%"))
    ).sort((a, b) => a.kind.localeCompare(b.kind)),
  ).toEqual([
    { kind: "quota.reached", key: periodStart.toISOString() },
    { kind: "quota.warning", key: periodStart.toISOString() },
  ]);
  expect(await sweepNotifications(db, deps())).toEqual({ sent: 0 });
});

it("monthly quota reached with overage on says sends now bill", async () => {
  const { used } = await monthlyPlan(true);
  await used(100_500);
  expect(await sweepNotifications(db, deps())).toEqual({ sent: 1 });
  expect(sends[0]?.text).toContain(
    "Sends past the quota now bill at your plan's overage rate and show on the next invoice.",
  );
  const [row] = await deliveries();
  expect(row?.payload).toMatchObject({
    type: "quota.reached",
    data: { used: 100_500, limit: 100_000, period: "month", overage: true },
  });
});

it("a monthly period that rolled before its renewal webhook is judged by the row keyed at the old period end", async () => {
  const { periodEnd, used } = await monthlyPlan();
  // Last period's row, also full: judged in its own period, never again.
  await used(100_000);
  await db
    .insert(schema.usagePeriods)
    .values({ teamId, periodStart: periodEnd, accepted: 100_000 });
  const later = new Date(periodEnd.getTime() + 3_600_000);
  expect(await sweepNotifications(db, deps(true, later))).toEqual({ sent: 1 });
  expect(sends[0]?.subject).toContain("this period's sending quota reached");
  expect(
    await db
      .select({ kind: schema.teamNotifications.kind, key: schema.teamNotifications.periodKey })
      .from(schema.teamNotifications)
      .where(like(schema.teamNotifications.kind, "quota.%")),
  ).toEqual([{ kind: "quota.reached", key: periodEnd.toISOString() }]);
});

it("self-host has no quota to notify about", async () => {
  await counters({ accepted: 100 });
  expect(await sweepNotifications(db, deps(false))).toEqual({ sent: 0 });
  expect(sends).toHaveLength(0);
});

it("deliverability pause fires once per episode and again after recovery", async () => {
  await counters({ sent: 200, complained: 3 });
  expect(await sweepNotifications(db, deps())).toEqual({ sent: 1 });
  expect(sends[0]?.subject).toContain("sending paused");
  expect(sends[0]?.text).toContain("complaint rate");
  const [row] = await deliveries();
  expect(row?.type).toBe("deliverability.paused");
  expect(row?.payload).toMatchObject({
    data: { metric: "complaint", limit: 0.001, window_days: 2 },
  });
  expect(await sweepNotifications(db, deps())).toEqual({ sent: 0 });

  // Recovery clears the episode; a new one notifies again.
  await counters({ sent: 200, complained: 0 });
  expect(await sweepNotifications(db, deps())).toEqual({ sent: 0 });
  await counters({ sent: 200, complained: 3 });
  expect(await sweepNotifications(db, deps())).toEqual({ sent: 1 });
  expect(sends).toHaveLength(2);
});

it("a quiet week ends the episode even though the team is never observed healthy", async () => {
  await counters({ sent: 200, complained: 3 });
  expect(await sweepNotifications(db, deps())).toEqual({ sent: 1 });
  // Eight days later the last sending day has left the window: no health to
  // judge, so the claims go. A fresh bad episode then notifies again.
  const later = new Date(Date.now() + 8 * 24 * 3_600_000);
  // The drain would have settled the pause's own delivery row long before;
  // left open it would read as a week-old webhook backlog.
  await db.update(schema.webhookDeliveries).set({ status: "success", nextAttemptAt: null });
  expect(await sweepNotifications(db, deps(true, later))).toEqual({ sent: 0 });
  await counters({ sent: 200, complained: 3 }, utcDay(later.getTime()));
  expect(await sweepNotifications(db, deps(true, later))).toEqual({ sent: 1 });
  expect(sends).toHaveLength(2);
});

it("hovering at the warning line is one episode; it ends only well under the line", async () => {
  await counters({ sent: 1000, hardBounced: 40 }); // 4.00%: warning
  expect(await sweepNotifications(db, deps())).toEqual({ sent: 1 });
  await counters({ sent: 1010, hardBounced: 40 }); // 3.96%: ok, but not cleared
  expect(await sweepNotifications(db, deps())).toEqual({ sent: 0 });
  await counters({ sent: 1010, hardBounced: 41 }); // 4.06%: same episode
  expect(await sweepNotifications(db, deps())).toEqual({ sent: 0 });
  await counters({ sent: 1000, hardBounced: 35 }); // 3.5% < 0.9 × 4%: episode over
  expect(await sweepNotifications(db, deps())).toEqual({ sent: 0 });
  await counters({ sent: 1000, hardBounced: 40 });
  expect(await sweepNotifications(db, deps())).toEqual({ sent: 1 });
  expect(sends).toHaveLength(2);
});

it("one team's failing mail never stops the sweep for the others", async () => {
  const other = await createTeam(db, "notify-other");
  await db.insert(schema.user).values({ id: "o2", name: "O2", email: "other@example.com" });
  await db.insert(schema.teamMembers).values({ teamId: other, userId: "o2", role: "owner" });
  await counters({ accepted: 100 });
  await counters({ accepted: 100 }, utcDay(), other);
  const flaky = {
    ...deps(),
    mailer: {
      send: async (to: string, m: { subject: string; text: string }) => {
        if (to === "owner@example.com") throw new Error("SES down");
        sends.push({ to, subject: m.subject, text: m.text });
      },
    },
  };
  await expect(sweepNotifications(db, flaky)).resolves.toEqual({ sent: 2 });
  expect(sends.map((s) => s.to)).toEqual(["other@example.com"]);
  // The first team's webhook (the only endpoint seeded) still went out.
  expect(enqueued).toHaveLength(1);
});

it("a warning that escalates to a pause notifies both once", async () => {
  await counters({ sent: 1000, hardBounced: 45 });
  await sweepNotifications(db, deps());
  expect(sends[0]?.subject).toContain("at risk");
  await counters({ sent: 1000, hardBounced: 60 });
  await sweepNotifications(db, deps());
  expect(sends.map((s) => s.subject)).toEqual([
    expect.stringContaining("at risk"),
    expect.stringContaining("sending paused"),
  ]);
  await sweepNotifications(db, deps());
  expect(sends).toHaveLength(2);
});

it("without a configured sender the mailer is a no-op", async () => {
  vi.stubEnv("NOTIFICATIONS_EMAIL_FROM", "");
  vi.stubEnv("AUTH_EMAIL_FROM", "");
  await expect(
    createSystemMailer({ db, keyring, enqueueSend: async () => {} }).send("x@example.com", {
      subject: "s",
      html: "<p>h</p>",
      text: "t",
      kind: "quota.warning",
    }),
  ).resolves.toBeUndefined();
});

it("owners of the team are the recipients; members are not", async () => {
  await db.insert(schema.user).values({ id: "m", name: "M", email: "member@example.com" });
  await db.insert(schema.teamMembers).values({ teamId, userId: "m", role: "member" });
  await counters({ accepted: 100 });
  await sweepNotifications(db, deps());
  expect(sends.map((s) => s.to)).toEqual(["owner@example.com"]);
  const [team] = await db
    .select()
    .from(schema.teamNotifications)
    .where(eq(schema.teamNotifications.teamId, teamId));
  expect(team).toMatchObject({ kind: "quota.reached", periodKey: utcDay() });
});

async function endpoint() {
  const [row] = await db
    .select({ id: schema.webhookEndpoints.id })
    .from(schema.webhookEndpoints)
    .where(eq(schema.webhookEndpoints.teamId, teamId));
  if (!row) throw new Error("endpoint missing");
  return row.id;
}

async function setEndpointStatus(status: "enabled" | "disabled" | "auto_disabled") {
  await db.update(schema.webhookEndpoints).set({ status });
}

/**
 * Settled/open rows, each a second newer than the last so the settled order
 * is fixed. An exhausted row ran out of retries unless told otherwise.
 */
async function delivery(
  status: "pending" | "success" | "failed" | "exhausted",
  opts: { nextAttemptAt?: Date; count?: number; attempts?: number; lastResponseCode?: number } = {},
) {
  const endpointId = await endpoint();
  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.webhookDeliveries);
  const base = Date.now() - 3_600_000;
  await db.insert(schema.webhookDeliveries).values(
    Array.from({ length: opts.count ?? 1 }, (_, i) => ({
      endpointId,
      messageId: `msg_${randomUUID()}`,
      eventType: "email.sent",
      payload: {},
      status,
      attempts: opts.attempts ?? (status === "exhausted" ? WEBHOOK_MAX_ATTEMPTS : 0),
      lastResponseCode: opts.lastResponseCode ?? null,
      nextAttemptAt: opts.nextAttemptAt ?? null,
      createdAt: new Date(base + (n + i) * 1000),
    })),
  );
}

async function backlogClaims() {
  return db
    .select({ periodKey: schema.teamNotifications.periodKey })
    .from(schema.teamNotifications)
    .where(like(schema.teamNotifications.kind, "webhook.backlog:%"));
}

it("a failing endpoint mails once per episode; a success ends it", async () => {
  await delivery("exhausted", { count: 9 });
  expect(await sweepNotifications(db, deps(false))).toEqual({ sent: 0 });
  await delivery("exhausted");
  expect(await sweepNotifications(db, deps(false))).toEqual({ sent: 1 });
  expect(sends[0]?.subject).toContain("receiver.example.com are failing");
  expect(sends[0]?.text).toContain(`https://app.example.test/webhooks/${await endpoint()}`);
  expect(await sweepNotifications(db, deps(false))).toEqual({ sent: 0 });

  await delivery("success");
  expect(await sweepNotifications(db, deps(false))).toEqual({ sent: 0 });
  await delivery("exhausted", { count: 10 });
  expect(await sweepNotifications(db, deps(false))).toEqual({ sent: 1 });
  expect(sends).toHaveLength(2);
});

it("an auto-disabled endpoint mails once until it is enabled again", async () => {
  await setEndpointStatus("auto_disabled");
  expect(await sweepNotifications(db, deps(false))).toEqual({ sent: 1 });
  expect(sends[0]?.subject).toContain("disabled after repeated failures");
  expect(await sweepNotifications(db, deps(false))).toEqual({ sent: 0 });
  await setEndpointStatus("enabled");
  expect(await sweepNotifications(db, deps(false))).toEqual({ sent: 0 });
  await setEndpointStatus("auto_disabled");
  expect(await sweepNotifications(db, deps(false))).toEqual({ sent: 1 });
  expect(sends).toHaveLength(2);
  // No webhook fan-out for webhook trouble: the endpoint is the broken one.
  expect(enqueued).toHaveLength(0);
});

it("a backlog older than six hours mails once per UTC day; yesterday's claim is swept away", async () => {
  await delivery("pending", { nextAttemptAt: new Date(Date.now() - 5 * 60_000) });
  expect(await sweepNotifications(db, deps(false))).toEqual({ sent: 0 });
  await delivery("failed", { nextAttemptAt: new Date(Date.now() - 7 * 3_600_000) });
  expect(await sweepNotifications(db, deps(false))).toEqual({ sent: 1 });
  expect(sends[0]?.subject).toContain("backing up");
  expect(sends[0]?.text).toContain("2 deliveries to https://receiver.example.com/hook are waiting");
  expect(sends[0]?.text).toContain("due for 7 h");
  expect(await sweepNotifications(db, deps(false))).toEqual({ sent: 0 });
  const tomorrow = new Date(Date.now() + 24 * 3_600_000);
  expect(await sweepNotifications(db, deps(false, tomorrow))).toEqual({ sent: 1 });
  expect(sends).toHaveLength(2);
  expect(await backlogClaims()).toEqual([{ periodKey: utcDay(tomorrow.getTime()) }]);
});

it("a deep backlog that is keeping up is not an alarm", async () => {
  // 10k+ rows, none due for more than a few minutes: minutes of healthy draining.
  const endpointId = await endpoint();
  await db.execute(sql`
    insert into ${schema.webhookDeliveries} (endpoint_id, message_id, event_type, payload, status, next_attempt_at)
    select ${endpointId}::uuid, 'msg_' || g, 'email.sent', '{}'::jsonb, 'pending', now() - interval '5 minutes'
    from generate_series(1, 10001) g
  `);
  expect(await sweepNotifications(db, deps(false))).toEqual({ sent: 0 });
  expect(sends).toHaveLength(0);
});

it("rows the receiver throttled until they aged out read as a failing endpoint", async () => {
  await delivery("exhausted", { count: 10, attempts: 0, lastResponseCode: 429 });
  expect(await sweepNotifications(db, deps(false))).toEqual({ sent: 1 });
  expect(sends).toHaveLength(1);
});

it("rows exhausted without running out of retries do not read as a failing endpoint", async () => {
  // Expired by age or settled by a disable: never posted, so they say nothing about the receiver.
  await delivery("exhausted", { count: 10, attempts: 0 });
  expect(await sweepNotifications(db, deps(false))).toEqual({ sent: 0 });
  expect(sends).toHaveLength(0);
  // Real exhaustions on top still count.
  await delivery("exhausted", { count: 10 });
  expect(await sweepNotifications(db, deps(false))).toEqual({ sent: 1 });
});

const DAY = 86_400_000;

async function domain(
  status: "verified" | "pending" | "temporary_failure" | "failed" = "verified",
) {
  const [row] = await db
    .insert(schema.domains)
    .values({ teamId, name: "mail.acme.dev", region: "us-east-1", status, verifiedAt: new Date() })
    .returning({ id: schema.domains.id });
  if (!row) throw new Error("domain insert failed");
  return row.id;
}

async function setDomain(id: string, status: "verified" | "temporary_failure" | "failed") {
  await db.update(schema.domains).set({ status }).where(eq(schema.domains.id, id));
}

async function claims(prefix: string) {
  return (
    await db
      .select({ kind: schema.teamNotifications.kind })
      .from(schema.teamNotifications)
      .where(like(schema.teamNotifications.kind, `${prefix}%`))
  ).map((c) => c.kind);
}

it("a domain is announced once when it verifies; losing a record says so once and re-arms the announcement", async () => {
  const id = await domain();
  expect(await sweepNotifications(db, deps(false))).toEqual({ sent: 1 });
  expect(sends.map((s) => s.subject)).toEqual(["mail.acme.dev is verified"]);
  expect(sends[0]?.text).toContain(`https://app.example.test/domains/${id}`);
  await sweepNotifications(db, deps(false));
  expect(sends).toHaveLength(1);

  await setDomain(id, "temporary_failure");
  await sweepNotifications(db, deps(false));
  await sweepNotifications(db, deps(false));
  expect(sends.map((s) => s.subject)).toEqual([
    "mail.acme.dev is verified",
    "mail.acme.dev lost its verification",
  ]);
  expect(sends[1]?.text).toContain("DKIM or MAIL FROM");
  expect(await claims("domain.")).toEqual([`domain.lost:${id}`]);

  await setDomain(id, "verified");
  await sweepNotifications(db, deps(false));
  expect(sends).toHaveLength(3);
  expect(await claims("domain.")).toEqual([`domain.verified:${id}`]);

  // SES giving up is terminal: the mail says to add the domain again.
  await setDomain(id, "failed");
  await sweepNotifications(db, deps(false));
  expect(sends[3]?.text).toContain("given up on mail.acme.dev");
  expect(sends[3]?.text).toContain("https://app.example.test/domains\n");

  await db.delete(schema.domains).where(eq(schema.domains.id, id));
  await sweepNotifications(db, deps(false));
  expect(await claims("domain.")).toEqual([]);
});

it("a domain that verified before the sweep existed, or never did, says nothing", async () => {
  const seeded = await domain();
  await db
    .insert(schema.teamNotifications)
    .values({ teamId, kind: `domain.verified:${seeded}`, periodKey: "episode" });
  await db
    .insert(schema.domains)
    .values({ teamId, name: "new.acme.dev", region: "us-east-1", status: "pending" });
  expect(await sweepNotifications(db, deps(false))).toEqual({ sent: 0 });
  expect(sends).toEqual([]);
});

async function audit(
  action: "api_key.created" | "webhook.secret_rotated" | "member.joined",
  opts: {
    actor?: string | null;
    target?: string;
    data?: Record<string, unknown>;
    team?: string;
    createdAt?: Date;
  } = {},
) {
  const [row] = await db
    .insert(schema.auditLog)
    .values({
      teamId: opts.team ?? teamId,
      actorId: opts.actor === undefined ? "user:owner" : opts.actor,
      action,
      target: opts.target ?? null,
      data: opts.data ?? null,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    })
    .returning({ id: schema.auditLog.id });
  if (!row) throw new Error("audit insert failed");
  return row.id;
}

it("a new API key is reported once to the owners and to the person who created it", async () => {
  await db.insert(schema.user).values({ id: "adm", name: "Ada", email: "ada@example.com" });
  await db.insert(schema.teamMembers).values({ teamId, userId: "adm", role: "admin" });
  const [scoped] = await db
    .insert(schema.domains)
    .values({ teamId, name: "mail.acme.dev", region: "us-east-1", status: "verified" })
    .returning({ id: schema.domains.id });
  const [key] = await db
    .insert(schema.apiKeys)
    .values({
      teamId,
      name: "ci",
      tokenPrefix: "ms_live_abc",
      keyHash: "h1",
      last4: "wxyz",
      permission: "sending_access",
      domainId: scoped?.id,
    })
    .returning({ id: schema.apiKeys.id });
  await audit("api_key.created", {
    actor: "user:adm",
    target: `api_key:${key?.id}`,
    data: { name: "ci", permission: "sending_access", domainId: scoped?.id },
  });
  expect(await sweepNotifications(db, deps(false))).toEqual({ sent: 1 });
  expect(sends.map((s) => s.to).sort()).toEqual(["ada@example.com", "owner@example.com"]);
  expect(sends[0]?.subject).toBe("New API key in notify-team: ci");
  expect(sends[0]?.text).toContain(
    'Ada created the API key "ci" (ms_live_abc…wxyz, sending access, limited to mail.acme.dev) in notify-team.',
  );
  expect(sends[0]?.text).toContain("https://app.example.test/api-keys");
  await sweepNotifications(db, deps(false));
  expect(sends).toHaveLength(2);

  // Removed from the team since: the owners still hear it, the ex-member does not.
  await db.delete(schema.teamMembers).where(eq(schema.teamMembers.userId, "adm"));
  const [later] = await db
    .insert(schema.apiKeys)
    .values({ teamId, name: "later", tokenPrefix: "ms_live_ghi", keyHash: "h3", last4: "5678" })
    .returning({ id: schema.apiKeys.id });
  await audit("api_key.created", {
    actor: "user:adm",
    target: `api_key:${later?.id}`,
    data: { name: "later", permission: "full_access", domainId: null },
  });
  await sweepNotifications(db, deps(false));
  expect(sends.slice(2).map((s) => s.to)).toEqual(["owner@example.com"]);
  expect(sends[2]?.text).toContain('Ada created the API key "later"');

  // A key minted by another key names no person; the owner is the only reader.
  const [minted] = await db
    .insert(schema.apiKeys)
    .values({ teamId, name: "child", tokenPrefix: "ms_live_def", keyHash: "h2", last4: "1234" })
    .returning({ id: schema.apiKeys.id });
  await audit("api_key.created", {
    actor: `api_key:${key?.id}`,
    target: `api_key:${minted?.id}`,
    data: { name: "child", permission: "full_access", domainId: null },
  });
  await sweepNotifications(db, deps(false));
  expect(sends).toHaveLength(4);
  expect(sends[3]?.text).toContain(
    'an API key created the API key "child" (ms_live_def…1234, full access) in',
  );
});

it("a rotated webhook secret names the endpoint and the old secret's deadline", async () => {
  const endpointId = await endpoint();
  await audit("webhook.secret_rotated", {
    target: `webhook:${endpointId}`,
    data: {
      url: "https://receiver.example.com/hook",
      previousSecretExpiresAt: "2026-09-10T15:00:00.000Z",
    },
  });
  await sweepNotifications(db, deps(false));
  expect(sends.map((s) => s.subject)).toEqual(["Webhook secret rotated for receiver.example.com"]);
  expect(sends[0]?.text).toContain(
    "Owner rotated the signing secret of https://receiver.example.com/hook in notify-team.",
  );
  expect(sends[0]?.text).toContain("until September 10, 2026 at 3:00 PM UTC;");
  expect(sends[0]?.text).toContain(`https://app.example.test/webhooks/${endpointId}`);

  await audit("webhook.secret_rotated", {
    target: `webhook:${endpointId}`,
    data: { url: "https://receiver.example.com/hook", previousSecretExpiresAt: null },
  });
  await sweepNotifications(db, deps(false));
  expect(sends[1]?.text).toContain("The previous secret stopped verifying at once;");
  expect(sends[1]?.text).not.toContain("keeps verifying");
});

it("a member who joined is reported to the other owners, never to themselves", async () => {
  await db.insert(schema.user).values({ id: "j", name: "Jo", email: "jo@example.com" });
  await db.insert(schema.teamMembers).values({ teamId, userId: "j", role: "owner" });
  await audit("member.joined", { actor: "user:j", target: "user:j", data: { role: "owner" } });
  await sweepNotifications(db, deps(false));
  expect(sends.map((s) => s.to)).toEqual(["owner@example.com"]);
  expect(sends[0]?.subject).toBe("Jo joined notify-team");
  expect(sends[0]?.text).toContain(
    "Jo (jo@example.com) accepted the invitation and is now an owner of notify-team.",
  );
});

it("audit rows of a deleted team or older than a day are left alone, and their claims go", async () => {
  await audit("member.joined", {
    team: randomUUID(),
    target: "user:owner",
    data: { role: "member" },
  });
  await audit("member.joined", {
    target: "user:owner",
    data: { role: "member" },
    createdAt: new Date(Date.now() - 2 * DAY),
  });
  await db
    .insert(schema.teamNotifications)
    .values({ teamId, kind: "member.joined", periodKey: randomUUID() });
  expect(await sweepNotifications(db, deps(false))).toEqual({ sent: 0 });
  expect(sends).toEqual([]);
  expect(await claims("member.")).toEqual([]);
});

async function setPlan(values: Partial<typeof schema.teams.$inferInsert>) {
  await db.update(schema.teams).set(values).where(eq(schema.teams.id, teamId));
}

it("a scheduled cancellation is recalled three days out, once, on the cloud only", async () => {
  const endsAt = new Date(Date.now() + 2 * DAY);
  await setPlan({ plan: "pro", cancelAt: endsAt });
  expect(await sweepNotifications(db, deps(false))).toEqual({ sent: 0 });
  expect(await sweepNotifications(db, deps())).toEqual({ sent: 1 });
  await sweepNotifications(db, deps());
  expect(sends.map((s) => s.subject)).toEqual([
    `Reminder: notify-team's Pro 100k plan ends on ${formatMailDate("en", endsAt)}`,
  ]);
  expect(sends[0]?.text).toContain("to keep sending up to 100,000 emails a month");

  // Too far out to count down yet; a fresh date is its own reminder.
  await setPlan({ cancelAt: new Date(Date.now() + 10 * DAY) });
  await sweepNotifications(db, deps());
  expect(sends).toHaveLength(1);
});

it("a paid period that lapsed past its grace reads as the downgrade, keyed like the webhook's", async () => {
  const periodEnd = new Date(Date.now() - 8 * DAY);
  await setPlan({ plan: "scale", currentPeriodEnd: periodEnd });
  expect(await sweepNotifications(db, deps(false))).toEqual({ sent: 0 });
  expect(await sweepNotifications(db, deps())).toEqual({ sent: 1 });
  await sweepNotifications(db, deps());
  expect(sends.map((s) => s.subject)).toEqual(["notify-team is now on Free"]);
  expect(sends[0]?.text).toContain("The Scale 500k plan ended on");
  expect(
    await db
      .select({ key: schema.teamNotifications.periodKey })
      .from(schema.teamNotifications)
      .where(eq(schema.teamNotifications.kind, "billing.downgraded")),
  ).toEqual([{ key: periodEnd.toISOString() }]);

  // Still inside the grace window: nothing to say yet.
  await setPlan({ currentPeriodEnd: new Date(Date.now() - 2 * DAY) });
  await sweepNotifications(db, deps());
  expect(sends).toHaveLength(1);
});

it("an owner whose account contact is pt-BR reads the notice in pt-BR", async () => {
  vi.stubEnv("AUTH_EMAIL_FROM", "MillionSend <account@mail.example.com>");
  const home = await createTeam(db, "home");
  await db
    .insert(schema.domains)
    .values({ teamId: home, name: "mail.example.com", region: "us-east-1", status: "verified" });
  await db
    .insert(schema.contacts)
    .values({ teamId: home, email: "owner@example.com", properties: { locale: "pt-BR" } });
  await domain();
  await sweepNotifications(db, deps(false));
  expect(sends.map((s) => s.subject)).toEqual(["mail.acme.dev está verificado"]);
});

it("an owner who turned a notice off is skipped for it, and still gets a security receipt", async () => {
  await db
    .update(schema.user)
    .set({ mailOptOuts: ["domain.verified"] })
    .where(eq(schema.user.id, "owner"));
  await domain();
  await sweepNotifications(db, deps(false));
  expect(sends).toEqual([]);
  const [key] = await db
    .insert(schema.apiKeys)
    .values({ teamId, name: "ci", tokenPrefix: "ms_live_abc", keyHash: "h1", last4: "wxyz" })
    .returning({ id: schema.apiKeys.id });
  await audit("api_key.created", {
    target: `api_key:${key?.id}`,
    data: { name: "ci", permission: "full_access", domainId: null },
  });
  await sweepNotifications(db, deps(false));
  expect(sends.map((s) => [s.to, s.subject])).toEqual([
    ["owner@example.com", "New API key in notify-team: ci"],
  ]);
});
