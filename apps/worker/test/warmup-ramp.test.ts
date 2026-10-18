import { randomBytes } from "node:crypto";
import {
  DAY_MS,
  deriveUnsubscribeKey,
  EnvKeyring,
  enableWarmup,
  pauseWarmup,
  utcDay,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { drainQuotaParked } from "../src/handlers/cron.js";
import {
  type BroadcastDeps,
  type BroadcastQuotaControls,
  sendBroadcast,
} from "../src/handlers/send-broadcast.js";

// The drain's day check, switched off to stand for one that has not run yet.
const dayCheck = vi.hoisted(() => ({ on: true }));
vi.mock("@millionsend/core", async (importOriginal) => {
  const core = await importOriginal<typeof import("@millionsend/core")>();
  return {
    ...core,
    checkWarmups: async (...args: Parameters<typeof core.checkWarmups>) =>
      dayCheck.on ? core.checkWarmups(...args) : [],
  };
});

let db: Db;
let close: () => Promise<void>;
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

/** A team with an owner, sending from a verified `<label>.example.com`, its warm-up on since `since`. */
async function warmSender(
  label: string,
  opts: {
    warm?: boolean;
    since?: Date;
    settings?: { startVolume?: number; orderProperty?: string };
  } = {},
) {
  const teamId = await createTeam(db, label);
  await db
    .insert(schema.user)
    .values({ id: `${label}-owner`, name: "", email: `${label}@example.com` });
  await db.insert(schema.teamMembers).values({ teamId, userId: `${label}-owner`, role: "owner" });
  const [domain] = await db
    .insert(schema.domains)
    .values({
      teamId,
      name: `${label}.example.com`,
      region: "us-east-1",
      status: "verified",
      verifiedAt: new Date(),
      sesConfigurationSet: "ms-set",
    })
    .returning({ id: schema.domains.id });
  if (!domain) throw new Error("domain insert failed");
  if (opts.warm !== false) {
    await enableWarmup(db, {
      teamId,
      domainId: domain.id,
      settings: { startVolume: 100, ...opts.settings },
      now: opts.since ?? new Date(),
    });
  }
  const [broadcast] = await db
    .insert(schema.broadcasts)
    .values({
      teamId,
      from: `Acme <hi@${label}.example.com>`,
      subject: "launch",
      html: '<p>Hi</p><a href="{{{UNSUBSCRIBE_URL}}}">bye</a>',
      status: "scheduled",
      scheduledAt: new Date(Date.now() - 1000),
    })
    .returning({ id: schema.broadcasts.id });
  if (!broadcast) throw new Error("broadcast insert failed");
  return { teamId, domainId: domain.id, broadcastId: broadcast.id };
}

function makeDeps(overrides: Partial<BroadcastDeps> = {}) {
  const enqueued: string[] = [];
  const deps: BroadcastDeps = {
    keyring,
    unsubscribeSecretKey: deriveUnsubscribeKey(randomBytes(32)),
    unsubscribeBaseUrl: "https://app.example.com",
    isCloud: true,
    enqueueEmailSends: async (batch) => {
      enqueued.push(...batch.map((job) => job.emailId));
    },
    batchSize: 2,
    ...overrides,
  };
  return { deps, enqueued };
}

function captureMailer() {
  const sends: { to: string; kind: string; subject: string; text: string }[] = [];
  const mailer: NonNullable<BroadcastDeps["mailer"]> = {
    send: async (to, m) => {
      sends.push({ to, kind: m.kind, subject: m.subject, text: m.text });
    },
  };
  return { sends, mailer, appBaseUrl: "https://app.example.com" };
}

/** The region's room ledger, recording what the walk asks of it. */
function recordingControls(): { controls: BroadcastQuotaControls; taken: unknown[] } {
  const taken: unknown[] = [];
  return {
    taken,
    controls: {
      take: (region, id, n) => {
        taken.push([region, id, n]);
        return n;
      },
      progress: () => {},
      done: () => {},
      reserve: () => 30,
      capacity: () => ({ max24h: 100_000, sentLast24h: 0, maxSendRate: 14 }),
      rate: () => 14,
    },
  };
}

const rowsOf = (broadcastId: string) =>
  db
    .select()
    .from(schema.emails)
    .where(eq(schema.emails.broadcastId, broadcastId))
    .orderBy(asc(schema.emails.sendOrder));

async function broadcastRow(id: string) {
  const [row] = await db
    .select({
      status: schema.broadcasts.status,
      skipped: schema.broadcasts.warmupSkipped,
      recipients: schema.broadcasts.recipientCount,
    })
    .from(schema.broadcasts)
    .where(eq(schema.broadcasts.id, id));
  return row;
}

describe("a warming domain's fan-out", () => {
  it("parks every row in line by activity, skips and counts the inactive, and takes no grant", async () => {
    const s = await warmSender("ramp-fan", { settings: { orderProperty: "seen" } });
    const ago = (days: number) => new Date(Date.now() - days * DAY_MS);
    await db.insert(schema.contacts).values([
      { teamId: s.teamId, email: "recent@example.com", lastEngagedAt: ago(1) },
      { teamId: s.teamId, email: "month@example.com", lastEngagedAt: ago(30) },
      { teamId: s.teamId, email: "unknown@example.com" },
      { teamId: s.teamId, email: "lapsed@example.com", lastEngagedAt: ago(200) },
      { teamId: s.teamId, email: "receipt@example.com", lastEngagedAt: ago(200) },
      { teamId: s.teamId, email: "buyer@example.com", properties: { seen: "2020-01-01" } },
    ]);
    // A receipt two days ago brings a lapsed contact back to the front.
    await db.insert(schema.emails).values({
      teamId: s.teamId,
      domainId: s.domainId,
      from: "hi@ramp-fan.example.com",
      to: ["Receipt Reader <receipt@example.com>"],
      subject: "receipt",
      latestStatus: "delivered",
      createdAt: ago(2),
      sentAt: ago(2),
    });
    const { controls, taken } = recordingControls();
    const { deps, enqueued } = makeDeps({ sesQuota: controls });
    expect(await sendBroadcast(db, deps, { broadcastId: s.broadcastId })).toBe("sent");

    expect(taken).toEqual([]);
    expect(enqueued).toEqual([]);
    const rows = await rowsOf(s.broadcastId);
    expect(rows.map((r) => r.to[0])).toEqual([
      "recent@example.com",
      "receipt@example.com",
      "month@example.com",
      "unknown@example.com",
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({
        latestStatus: "queued_quota",
        parkReason: "warmup",
        scheduledAt: null,
      });
      expect(row.sendOrder).toEqual(expect.any(Number));
    }
    expect(await broadcastRow(s.broadcastId)).toEqual({
      status: "sending",
      skipped: 2,
      recipients: 4,
    });
    // Nothing was charged to the plan: the drain charges each row as it goes.
    const counters = await db
      .select()
      .from(schema.usageCounters)
      .where(eq(schema.usageCounters.teamId, s.teamId));
    expect(counters).toEqual([]);
  });

  it("counts the inactive it skipped exactly once across an interrupted, resumed walk", async () => {
    const s = await warmSender("ramp-resume");
    const ago = (days: number) => new Date(Date.now() - days * DAY_MS);
    const contacts = await db
      .insert(schema.contacts)
      .values(
        [1, 200, 2, 300, 3, 400].map((days, i) => ({
          teamId: s.teamId,
          email: `c${i}@example.com`,
          lastEngagedAt: ago(days),
        })),
      )
      .returning({ id: schema.contacts.id, lastEngagedAt: schema.contacts.lastEngagedAt });
    const inactive = (c: (typeof contacts)[number]) =>
      (c.lastEngagedAt?.getTime() ?? 0) < Date.now() - 90 * DAY_MS;
    const pages = [...contacts].sort((a, b) => (a.id < b.id ? -1 : 1));
    // The walk stops at the top of its third page: the second page's
    // heartbeat persisted the first page's count with its cursor.
    let checks = 0;
    const signal = {
      get aborted() {
        checks += 1;
        return checks >= 3;
      },
    } as AbortSignal;
    await expect(
      sendBroadcast(db, makeDeps({ signal }).deps, { broadcastId: s.broadcastId }),
    ).rejects.toThrow(/fan-out aborted/);
    expect((await broadcastRow(s.broadcastId))?.skipped).toBe(
      pages.slice(0, 2).filter(inactive).length,
    );

    expect(await sendBroadcast(db, makeDeps().deps, { broadcastId: s.broadcastId })).toBe("sent");
    expect(await broadcastRow(s.broadcastId)).toEqual({
      status: "sending",
      skipped: 3,
      recipients: 3,
    });
  });

  it("tells the owners when the warm-up spreads the broadcast over days", async () => {
    const s = await warmSender("ramp-note");
    await db.insert(schema.contacts).values({ teamId: s.teamId, email: "late@example.com" });
    // Three days of another broadcast's mail already wait on the domain.
    const [ahead] = await db
      .insert(schema.broadcasts)
      .values({
        teamId: s.teamId,
        from: "hi@ramp-note.example.com",
        subject: "s",
        status: "sending",
      })
      .returning({ id: schema.broadcasts.id });
    await db.insert(schema.emails).values(
      Array.from({ length: 300 }, (_, i) => ({
        teamId: s.teamId,
        domainId: s.domainId,
        broadcastId: ahead?.id ?? null,
        from: "hi@ramp-note.example.com",
        to: [`a${i}@example.com`],
        subject: "s",
        latestStatus: "queued_quota" as const,
        parkReason: "warmup" as const,
      })),
    );
    const mail = captureMailer();
    expect(await sendBroadcast(db, makeDeps(mail).deps, { broadcastId: s.broadcastId })).toBe(
      "sent",
    );
    expect(mail.sends).toHaveLength(1);
    expect(mail.sends[0]?.kind).toBe("broadcast.sending");
    expect(mail.sends[0]?.subject).toMatch(/^Your broadcast is going out over [2-9] days$/);
    expect(mail.sends[0]?.text).toContain(
      "is warming up, so it sends a little more each day, most active contacts first. The last email goes out about",
    );
  });
});

describe("the drain of a warming domain", () => {
  const NOW = new Date("2026-10-10T08:00:00Z");
  // A database of its own: every drain run walks every team's parked mail.
  beforeAll(async () => {
    await close();
    ({ db, close } = await createTestDb());
  });

  /** Parked broadcast rows in the given send orders (null for a row the warm-up did not order). */
  async function park(s: Awaited<ReturnType<typeof warmSender>>, orders: (number | null)[]) {
    await db
      .update(schema.broadcasts)
      .set({ status: "sending", recipientCount: orders.length })
      .where(eq(schema.broadcasts.id, s.broadcastId));
    const rows = await db
      .insert(schema.emails)
      .values(
        orders.map((sendOrder, i) => ({
          teamId: s.teamId,
          domainId: s.domainId,
          broadcastId: s.broadcastId,
          from: "hi@ramp.example.com",
          to: [`p${i}@example.com`],
          subject: "s",
          latestStatus: "queued_quota" as const,
          parkReason: sendOrder === null ? null : ("warmup" as const),
          sendOrder,
          createdAt: new Date(NOW.getTime() - (orders.length - i) * 60_000),
        })),
      )
      .returning({ id: schema.emails.id, sendOrder: schema.emails.sendOrder });
    return new Map(rows.map((r) => [r.id, r.sendOrder]));
  }

  async function drain() {
    const enqueued: string[] = [];
    await drainQuotaParked(db, {
      isCloud: false,
      enqueueSends: async (batch) => {
        enqueued.push(...batch.map((job) => job.emailId));
      },
      now: NOW,
    });
    return enqueued;
  }

  const today = utcDay(NOW);

  async function dayRow(domainId: string) {
    const [row] = await db
      .select({ allowance: schema.domainWarmupDays.allowance, sent: schema.domainWarmupDays.sent })
      .from(schema.domainWarmupDays)
      .where(
        and(eq(schema.domainWarmupDays.domainId, domainId), eq(schema.domainWarmupDays.day, today)),
      );
    return row;
  }

  it("releases the most active first, a 48th of the day per run, within the day's allowance, and transactional mail apart", async () => {
    const s = await warmSender("ramp-drain", { since: NOW });
    const orders = await park(s, [50, 10, null, 90, 30, 70, 20, 80, 40, 100, 60]);
    const [receipt] = await db
      .insert(schema.emails)
      .values({
        teamId: s.teamId,
        domainId: s.domainId,
        from: "hi@ramp-drain.example.com",
        to: ["r@example.com"],
        subject: "receipt",
        latestStatus: "queued_quota",
      })
      .returning({ id: schema.emails.id });
    const released = (ids: string[]) =>
      ids.filter((id) => id !== receipt?.id).map((id) => orders.get(id));

    // A day of 100 goes out at 3 a run.
    const first = await drain();
    expect(first).toContain(receipt?.id);
    expect(released(first)).toEqual([10, 20, 30]);
    expect(await dayRow(s.domainId)).toEqual({ allowance: 100, sent: 3 });
    expect(released(await drain())).toEqual([40, 50, 60]);

    await db
      .update(schema.domainWarmupDays)
      .set({ sent: 99 })
      .where(eq(schema.domainWarmupDays.domainId, s.domainId));
    expect(released(await drain())).toEqual([70]);
    expect(await drain()).toEqual([]);
  });

  it("releases nothing before yesterday is checked, nor while paused", async () => {
    const s = await warmSender("ramp-wait", { since: new Date(NOW.getTime() - 2 * DAY_MS) });
    await park(s, [1, 2, 3]);
    dayCheck.on = false;
    try {
      expect(await drain()).toEqual([]);
    } finally {
      dayCheck.on = true;
    }
    expect(await drain()).toHaveLength(3);

    const paused = await warmSender("ramp-held", { since: NOW });
    await park(paused, [1, 2, 3]);
    await pauseWarmup(db, { teamId: paused.teamId, domainId: paused.domainId, now: NOW });
    expect(await drain()).toEqual([]);
  });

  it("leaves other domains' broadcasts as they were", async () => {
    const s = await warmSender("ramp-cold", { warm: false });
    await park(s, [null, null, null, null, null]);
    expect(await drain()).toHaveLength(5);
  });

  it("tells the owners once when the day check pauses the warm-up", async () => {
    const s = await warmSender("ramp-pause", { since: new Date(NOW.getTime() - DAY_MS) });
    const yesterday = utcDay(NOW.getTime() - DAY_MS);
    await db
      .insert(schema.domainWarmupDays)
      .values({ domainId: s.domainId, day: yesterday, allowance: 100, sent: 100 });
    const sentAt = new Date(`${yesterday}T12:00:00Z`);
    const sent = await db
      .insert(schema.emails)
      .values(
        Array.from({ length: 100 }, (_, i) => ({
          teamId: s.teamId,
          domainId: s.domainId,
          broadcastId: s.broadcastId,
          from: "hi@ramp-pause.example.com",
          to: [`g${i}@gmail.com`],
          subject: "s",
          latestStatus: "delivery_delayed" as const,
          sentAt,
        })),
      )
      .returning({ id: schema.emails.id });
    await db
      .insert(schema.emailEvents)
      .values(
        sent.map((r) => ({ emailId: r.id, type: "delivery_delayed" as const, occurredAt: sentAt })),
      );
    await park(s, [1, 2]);
    const mail = captureMailer();
    const run = () =>
      drainQuotaParked(db, {
        isCloud: false,
        enqueueSends: async () => {},
        now: NOW,
        mailer: mail.mailer,
        appBaseUrl: mail.appBaseUrl,
      });
    expect(await run()).toMatchObject({ drained: 0 });
    expect(mail.sends).toEqual([
      expect.objectContaining({
        to: "ramp-pause@example.com",
        kind: "warmup.paused",
        subject: "Warm-up paused for your domain",
      }),
    ]);
    expect(mail.sends[0]?.text).toContain("Gmail delayed 100.00% of the day's mail.");
    expect(mail.sends[0]?.text).toContain("2 emails are waiting. Nothing is lost.");
    expect(mail.sends[0]?.text).toContain(`https://app.example.com/domains/${s.domainId}`);
    await run();
    expect(mail.sends).toHaveLength(1);
  });
});
