import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildAccountMail } from "../src/account-mail.js";
import { mailPreferenceOf } from "../src/mail-preferences.js";
import { DAY_MS } from "../src/utc-day.js";
import {
  checkWarmups,
  contactActivity,
  contactPropertyDateSql,
  enableWarmup,
  getWarmup,
  isInactiveContact,
  movedWarmupVolume,
  pauseWarmup,
  planWarmupDays,
  reserveWarmupDay,
  resumeWarmup,
  roundWarmupVolume,
  turnOffWarmup,
  updateWarmupSettings,
  type WarmupDayCounts,
  warmupDayOutcome,
  warmupMailValues,
  warmupOverview,
  warmupPropertyOptions,
  warmupSendOrder,
  warmupSendPreview,
  warmupSignals,
} from "../src/warmup-ramp.js";

let db: Db;
let close: () => Promise<void>;
let seq = 0;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

// The check runs early on the 10th: the 9th is the day it judges.
const NOW = new Date("2026-10-10T06:00:00Z");
const YESTERDAY = "2026-10-09";

async function newDomain(over: Partial<typeof schema.domains.$inferInsert> = {}) {
  seq += 1;
  const teamId = await createTeam(db, `ramp-${seq}`);
  const [domain] = await db
    .insert(schema.domains)
    .values({
      teamId,
      name: `news${seq}.example.com`,
      region: "us-east-1",
      status: "verified",
      ...over,
    })
    .returning({ id: schema.domains.id });
  if (!domain) throw new Error("domain insert failed");
  const [broadcast] = await db
    .insert(schema.broadcasts)
    .values({ teamId, from: `hi@news${seq}.example.com`, subject: "s", status: "sending" })
    .returning({ id: schema.broadcasts.id });
  if (!broadcast) throw new Error("broadcast insert failed");
  return { teamId, domainId: domain.id, broadcastId: broadcast.id };
}

type Ctx = Awaited<ReturnType<typeof newDomain>>;
type EventSpec = Omit<typeof schema.emailEvents.$inferInsert, "emailId" | "occurredAt">;

/** `n` broadcast rows SES took at noon of `day`, to Gmail or elsewhere, each with `events`. */
async function seedSends(
  ctx: Ctx,
  day: string,
  n: number,
  opts: { gmail: boolean; events?: EventSpec[] },
): Promise<void> {
  if (n === 0) return;
  const sentAt = new Date(`${day}T12:00:00Z`);
  const rows = await db
    .insert(schema.emails)
    .values(
      Array.from({ length: n }, () => {
        seq += 1;
        return {
          teamId: ctx.teamId,
          domainId: ctx.domainId,
          broadcastId: ctx.broadcastId,
          from: "hi@news.example.com",
          to: [`r${seq}@${opts.gmail ? "gmail.com" : "example.com"}`],
          subject: "s",
          latestStatus: "delivered" as const,
          sentAt,
        };
      }),
    )
    .returning({ id: schema.emails.id });
  const events = rows.flatMap((row) =>
    (opts.events ?? [{ type: "delivered" as const }]).map((event) => ({
      ...event,
      emailId: row.id,
      occurredAt: sentAt,
    })),
  );
  if (events.length > 0) await db.insert(schema.emailEvents).values(events);
}

/** A domain warming since the 8th, with the 9th already sent against an allowance. */
async function warmingDomain(
  day: { allowance: number; sent: number } | null,
  settings: { dailyTarget?: number; startVolume?: number } = {},
): Promise<Ctx> {
  const ctx = await newDomain({ openTracking: true });
  await enableWarmup(db, {
    ...ctx,
    settings: { dailyTarget: 10_000, startVolume: 2_000, ...settings },
    now: new Date("2026-10-09T01:00:00Z"),
  });
  if (day) {
    await db
      .insert(schema.domainWarmupDays)
      .values({ domainId: ctx.domainId, day: YESTERDAY, ...day });
  }
  return ctx;
}

async function rowOf(ctx: Ctx) {
  const row = await getWarmup(db, ctx.teamId, ctx.domainId);
  if (!row) throw new Error("no warm-up row");
  return row;
}

async function dayOf(ctx: Ctx, day: string) {
  const [row] = await db
    .select()
    .from(schema.domainWarmupDays)
    .where(
      and(eq(schema.domainWarmupDays.domainId, ctx.domainId), eq(schema.domainWarmupDays.day, day)),
    );
  return row;
}

const delivered = { type: "delivered" as const };
const opened = { type: "opened" as const };

/** A healthy day: 200 Gmail and 800 other sends, a fifth of each opened. */
async function healthyDay(ctx: Ctx): Promise<void> {
  await seedSends(ctx, YESTERDAY, 40, { gmail: true, events: [delivered, opened] });
  await seedSends(ctx, YESTERDAY, 160, { gmail: true });
  await seedSends(ctx, YESTERDAY, 160, { gmail: false, events: [delivered, opened] });
  await seedSends(ctx, YESTERDAY, 640, { gmail: false });
}

describe("volumes", () => {
  it("round to tens under 1,000 and hundreds above, never past the target", () => {
    expect(roundWarmupVolume(994, 10_000)).toBe(990);
    expect(roundWarmupVolume(995, 10_000)).toBe(1_000);
    expect(roundWarmupVolume(1_249, 10_000)).toBe(1_200);
    expect(roundWarmupVolume(1_250, 10_000)).toBe(1_300);
    expect(roundWarmupVolume(12_345, 10_000)).toBe(10_000);
  });

  it("grow 1.5 times, step back to 0.7 and resume at half, cuts floored at 500", () => {
    expect(movedWarmupVolume(1_500, "grow", 10_000)).toBe(2_300);
    expect(movedWarmupVolume(9_000, "grow", 10_000)).toBe(10_000);
    expect(movedWarmupVolume(1_500, "step_back", 10_000)).toBe(1_100);
    expect(movedWarmupVolume(600, "step_back", 10_000)).toBe(500);
    expect(movedWarmupVolume(4_000, "resume", 10_000)).toBe(2_000);
    expect(movedWarmupVolume(800, "resume", 10_000)).toBe(500);
    // A warm-up that started under the floor is never raised by a cut.
    expect(movedWarmupVolume(300, "step_back", 10_000)).toBe(300);
  });
});

describe("signals", () => {
  const side = (gmail: number, other: number) => ({ gmail, other });
  const healthy = (): WarmupDayCounts => ({
    sent: side(200, 800),
    delayed: side(0, 0),
    delivered: side(200, 800),
    opened: side(40, 160),
    hardBounced: side(0, 0),
    mailboxFull: side(0, 0),
    feedbackDelivered: 2_000,
    complained: 0,
  });
  const result = (over: Partial<WarmupDayCounts>, tracking = true) =>
    warmupSignals({ ...healthy(), ...over }, tracking);

  it("reads a healthy day as within on every signal, as fractions per side", () => {
    expect(result({})).toEqual({
      sent: { gmail: 200, other: 800 },
      delays: { gmail: 0, other: 0, result: "within" },
      opens: { gmail: 0.2, other: 0.2, result: "within" },
      hardBounces: { gmail: 0, other: 0, result: "within" },
      mailboxFull: { gmail: 0, other: 0, result: "within" },
      complaints: { gmail: null, other: 0, result: "within" },
    });
  });

  it("judges Gmail's delays at 5% and 20%, unknown under 100 Gmail sends", () => {
    expect(result({ delayed: side(9, 0) }).delays.result).toBe("within");
    expect(result({ delayed: side(10, 0) }).delays.result).toBe("missed");
    expect(result({ delayed: side(40, 0) }).delays.result).toBe("severe");
    // Other inboxes' delays are shown, never judged.
    expect(result({ delayed: side(0, 400) }).delays).toEqual({
      gmail: 0,
      other: 0.5,
      result: "within",
    });
    expect(
      result({ sent: side(99, 800), delivered: side(99, 800), delayed: side(50, 0) }).delays.result,
    ).toBe("unknown");
  });

  it("judges Gmail's open rate against the others' at half and a quarter", () => {
    expect(result({ opened: side(20, 160) }).opens.result).toBe("within");
    expect(result({ opened: side(19, 160) }).opens.result).toBe("missed");
    expect(result({ opened: side(9, 160) }).opens.result).toBe("severe");
    expect(result({ delivered: side(99, 800) }).opens.result).toBe("unknown");
    expect(result({ delivered: side(200, 99) }).opens.result).toBe("unknown");
    expect(result({ opened: side(9, 160) }, false).opens).toEqual({
      gmail: null,
      other: null,
      result: "unknown",
    });
  });

  it("judges hard bounces and full mailboxes over every send at 2% and 5%, unknown under 100", () => {
    expect(result({ hardBounced: side(10, 9) }).hardBounces.result).toBe("within");
    expect(result({ hardBounced: side(10, 10) }).hardBounces).toEqual({
      gmail: 0.05,
      other: 0.0125,
      result: "missed",
    });
    expect(result({ hardBounced: side(0, 50) }).hardBounces.result).toBe("severe");
    expect(result({ mailboxFull: side(20, 0) }).mailboxFull.result).toBe("missed");
    expect(result({ mailboxFull: side(10, 40) }).mailboxFull.result).toBe("severe");
    const few = { sent: side(40, 59), delivered: side(40, 59), opened: side(0, 0) };
    expect(result({ ...few, hardBounced: side(40, 0) }).hardBounces.result).toBe("unknown");
    expect(result({ ...few, mailboxFull: side(40, 0) }).mailboxFull.result).toBe("unknown");
  });

  it("judges complaints where they are reported, needing two and three of them", () => {
    expect(result({ complained: 1 }).complaints).toEqual({
      gmail: null,
      other: 0.0005,
      result: "within",
    });
    expect(result({ complained: 2 }).complaints.result).toBe("missed");
    expect(result({ complained: 3 }).complaints.result).toBe("severe");
    expect(result({ feedbackDelivered: 199, complained: 50 }).complaints.result).toBe("unknown");
  });

  it("moves the day by its worst signals, then by how much of the allowance it sent", () => {
    const day = { sent: 2_000, allowance: 2_000 };
    const outcome = (over: Partial<WarmupDayCounts>, d = day, volume = 2_000) =>
      warmupDayOutcome(result(over), d, volume, 10_000);
    expect(outcome({ delayed: side(40, 0) })).toBe("paused");
    expect(outcome({ delayed: side(10, 0), hardBounced: side(0, 20) })).toBe("stepped_back");
    expect(outcome({ delayed: side(10, 0) })).toBe("held");
    expect(outcome({}, { sent: 999, allowance: 2_000 })).toBe("light");
    expect(outcome({}, { sent: 1_000, allowance: 2_000 })).toBe("grew");
    expect(outcome({}, day, 10_000)).toBe("done");
  });
});

describe("activity", () => {
  let teamId: string;
  beforeAll(async () => {
    teamId = await createTeam(db, "ramp-properties");
  });

  async function propertyDate(value: string): Promise<Date | null> {
    seq += 1;
    const [contact] = await db
      .insert(schema.contacts)
      .values({ teamId, email: `p${seq}@example.com`, properties: { seen: value } })
      .returning({ id: schema.contacts.id });
    const [row] = await db
      .select({ at: contactPropertyDateSql("seen") })
      .from(schema.contacts)
      .where(eq(schema.contacts.id, contact?.id ?? ""));
    return row?.at ?? null;
  }

  it("reads a property as an ISO date or date-time, or epoch seconds or milliseconds", async () => {
    const iso = (s: string) => new Date(s).toISOString();
    expect((await propertyDate("2026-01-08"))?.toISOString()).toBe(iso("2026-01-08T00:00:00Z"));
    expect((await propertyDate("2026-01-08T10:30:00Z"))?.toISOString()).toBe(
      iso("2026-01-08T10:30:00Z"),
    );
    expect((await propertyDate("2026-01-08T10:30:00-03:00"))?.toISOString()).toBe(
      iso("2026-01-08T13:30:00Z"),
    );
    expect((await propertyDate(" 2026-01-08 10:30 "))?.toISOString()).toBe(
      iso("2026-01-08T10:30:00Z"),
    );
    expect((await propertyDate("1767225600"))?.toISOString()).toBe(iso("2026-01-01T00:00:00Z"));
    expect((await propertyDate("1767225600000"))?.toISOString()).toBe(iso("2026-01-01T00:00:00Z"));
    expect((await propertyDate("1767225600.5"))?.toISOString()).toBe(iso("2026-01-01T00:00:00.5Z"));
  });

  it("reads anything else as no signal", async () => {
    for (const junk of [
      "",
      "yes",
      "2026-02-30",
      "2026-13-01T10:00:00Z",
      "Jan 8, 2026",
      "now",
      "12abc",
      "99999999999999999999",
    ]) {
      expect(await propertyDate(junk), junk).toBeNull();
    }
  });

  it("reads a count as no date, so it leaves the contact unknown rather than inactive since 1970", async () => {
    for (const count of ["3", "1500", "20260108"]) {
      const at = await propertyDate(count);
      expect(at, count).toBeNull();
      const activity = contactActivity(
        { orderByEngagement: false, orderByTransactional: false, orderProperty: "seen" },
        { engagedAt: null, transactionalAt: null, propertyAt: at },
        NOW,
      );
      expect(isInactiveContact(activity, NOW), count).toBe(false);
    }
  });

  it("takes the newest signal the settings order by, a future one as now", () => {
    const all = { orderByEngagement: true, orderByTransactional: true, orderProperty: "seen" };
    const at = (days: number) => new Date(NOW.getTime() - days * DAY_MS);
    const signals = { engagedAt: at(40), transactionalAt: at(5), propertyAt: at(100) };
    expect(contactActivity(all, signals, NOW)).toEqual(at(5));
    expect(contactActivity({ ...all, orderByTransactional: false }, signals, NOW)).toEqual(at(40));
    expect(
      contactActivity(
        { orderByEngagement: false, orderByTransactional: false, orderProperty: "seen" },
        signals,
        NOW,
      ),
    ).toEqual(at(100));
    expect(
      contactActivity(
        { ...all, orderProperty: null },
        { ...signals, engagedAt: null, transactionalAt: null },
        NOW,
      ),
    ).toBeNull();
    expect(contactActivity(all, { ...signals, propertyAt: at(-30) }, NOW)).toEqual(NOW);
  });

  it("orders active contacts first, newest first, then unknown, then inactive", () => {
    const at = (days: number) => new Date(NOW.getTime() - days * DAY_MS);
    const order = [at(1), at(60), null, at(91), at(400)].map((a) => warmupSendOrder(a, NOW));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(new Set(order).size).toBe(5);
    expect(isInactiveContact(at(89), NOW)).toBe(false);
    expect(isInactiveContact(at(91), NOW)).toBe(true);
    expect(isInactiveContact(null, NOW)).toBe(false);
  });
});

describe("planWarmupDays", () => {
  const base = {
    now: new Date("2026-10-10T00:00:00Z"),
    paused: false,
    volume: 1_500,
    dailyTarget: 10_000,
    today: null,
    waitingAhead: 0,
  };

  it("grows 1.5 times a day and finishes at the run that releases the last one", () => {
    expect(planWarmupDays({ ...base, count: 10_000 })).toEqual({
      perDay: [
        { day: "2026-10-10", count: 1_500 },
        { day: "2026-10-11", count: 2_300 },
        { day: "2026-10-12", count: 3_500 },
        { day: "2026-10-13", count: 2_700 },
      ],
      days: 4,
      // 2,700 at 111 a run (5,300 / 48) take 25 runs: the last at 06:00.
      finishesAt: new Date("2026-10-13T06:00:00Z"),
    });
  });

  it("stops growing at the target", () => {
    expect(planWarmupDays({ ...base, dailyTarget: 2_000, count: 5_500 }).perDay).toEqual([
      { day: "2026-10-10", count: 1_500 },
      { day: "2026-10-11", count: 2_000 },
      { day: "2026-10-12", count: 2_000 },
    ]);
  });

  it("lets the mail already waiting go first", () => {
    expect(planWarmupDays({ ...base, waitingAhead: 1_000, count: 1_000 })).toEqual({
      perDay: [
        { day: "2026-10-10", count: 500 },
        { day: "2026-10-11", count: 500 },
      ],
      days: 2,
      // 500 at 48 a run (2,300 / 48) take 11 runs.
      finishesAt: new Date("2026-10-11T02:30:00Z"),
    });
  });

  it("starts today from now, with what today already sent and the runs it has left", () => {
    const now = new Date("2026-10-10T18:00:00Z");
    // 24 runs of 32 left today: 768, under the 900 the allowance still has.
    expect(
      planWarmupDays({
        ...base,
        now,
        today: { day: "2026-10-10", allowance: 1_500, sent: 600 },
        count: 1_000,
      }),
    ).toEqual({
      perDay: [
        { day: "2026-10-10", count: 768 },
        { day: "2026-10-11", count: 232 },
      ],
      // Seven hours, across midnight: a day, as the region planner counts it.
      days: 1,
      finishesAt: new Date("2026-10-11T01:00:00Z"),
    });
    expect(
      planWarmupDays({
        ...base,
        now,
        today: { day: "2026-10-10", allowance: 1_500, sent: 600 },
        count: 500,
      }).finishesAt,
    ).toEqual(new Date("2026-10-10T21:45:00Z"));
  });

  it("has no finish while paused", () => {
    expect(planWarmupDays({ ...base, paused: true, count: 100 })).toEqual({
      perDay: [],
      days: 0,
      finishesAt: null,
    });
  });
});

describe("the day's reservation", () => {
  it("opens the day at the volume and takes more only while it fits the allowance", async () => {
    const ctx = await newDomain();
    await enableWarmup(db, { ...ctx, settings: { startVolume: 100 }, now: NOW });
    const take = (count: number, volume = 100) =>
      reserveWarmupDay(db, { domainId: ctx.domainId, day: "2026-10-10", volume, count });
    expect(await take(60)).toBe(true);
    expect(await take(40)).toBe(true);
    expect(await take(1)).toBe(false);
    expect(await dayOf(ctx, "2026-10-10")).toMatchObject({ allowance: 100, sent: 100 });
    // A fresh day never opens past its volume.
    expect(
      await reserveWarmupDay(db, {
        domainId: ctx.domainId,
        day: "2026-10-11",
        volume: 5,
        count: 6,
      }),
    ).toBe(false);
  });
});

describe("the day check", () => {
  it("grows a healthy day that sent its allowance, and counts the day", async () => {
    const ctx = await warmingDomain({ allowance: 2_000, sent: 1_000 });
    await healthyDay(ctx);
    expect(await checkWarmups(db, NOW)).toEqual([]);
    expect(await rowOf(ctx)).toMatchObject({
      status: "warming",
      volume: 3_000,
      sendingDays: 1,
      checkedThrough: YESTERDAY,
    });
    expect(await dayOf(ctx, YESTERDAY)).toMatchObject({
      outcome: "grew",
      signals: { sent: { gmail: 200, other: 800 }, opens: { result: "within" } },
      checkedAt: NOW,
    });
  });

  it("does nothing the second time it runs", async () => {
    const ctx = await warmingDomain({ allowance: 2_000, sent: 1_000 });
    await healthyDay(ctx);
    await checkWarmups(db, NOW);
    const before = await rowOf(ctx);
    expect(await checkWarmups(db, new Date(NOW.getTime() + 15 * 60_000))).toEqual([]);
    expect(await rowOf(ctx)).toEqual(before);
  });

  it("holds the volume on a light day, or one that missed a signal", async () => {
    const light = await warmingDomain({ allowance: 2_000, sent: 900 });
    await healthyDay(light);
    const missed = await warmingDomain({ allowance: 2_000, sent: 2_000 });
    // 25 hard bounces of 1,025 sends.
    await seedSends(missed, YESTERDAY, 25, {
      gmail: false,
      events: [delivered, { type: "bounced", bounceType: "Permanent" }],
    });
    await healthyDay(missed);
    await checkWarmups(db, NOW);
    expect(await rowOf(light)).toMatchObject({ volume: 2_000, sendingDays: 1 });
    expect((await dayOf(light, YESTERDAY))?.outcome).toBe("light");
    expect(await rowOf(missed)).toMatchObject({ volume: 2_000 });
    expect(await dayOf(missed, YESTERDAY)).toMatchObject({
      outcome: "held",
      signals: { hardBounces: { result: "missed" } },
    });
  });

  it("leaves bounces and complaints about mail SES never attempted out of the signals", async () => {
    const ctx = await warmingDomain({ allowance: 2_000, sent: 2_000 });
    // Each stopped by SES's own suppression list: 25 bounces and 3 complaints of 1,028 sends.
    const listed = {
      bounceSubType: "OnAccountSuppressionList",
      complaintSubType: "OnAccountSuppressionList",
    };
    await seedSends(ctx, YESTERDAY, 25, {
      gmail: false,
      events: [{ type: "bounced", bounceType: "Permanent", data: { bounce: listed } }],
    });
    await seedSends(ctx, YESTERDAY, 3, {
      gmail: false,
      events: [{ type: "complained", data: { complaint: listed } }],
    });
    await healthyDay(ctx);
    await checkWarmups(db, NOW);
    expect(await dayOf(ctx, YESTERDAY)).toMatchObject({
      outcome: "grew",
      signals: { hardBounces: { result: "within" }, complaints: { result: "within" } },
    });
  });

  it("steps back a day that missed two signals", async () => {
    const ctx = await warmingDomain({ allowance: 2_000, sent: 2_000 });
    // 25 hard bounces of 1,055 sends, and Gmail delaying 30 of 230.
    await seedSends(ctx, YESTERDAY, 30, {
      gmail: true,
      events: [
        delivered,
        {
          type: "delivery_delayed",
          data: { deliveryDelay: { delayType: "TransientCommunicationFailure" } },
        },
      ],
    });
    await seedSends(ctx, YESTERDAY, 25, {
      gmail: false,
      events: [{ type: "bounced", bounceType: "Permanent" }],
    });
    await healthyDay(ctx);
    await checkWarmups(db, NOW);
    expect(await rowOf(ctx)).toMatchObject({ status: "warming", volume: 1_400 });
    expect(await dayOf(ctx, YESTERDAY)).toMatchObject({
      outcome: "stepped_back",
      signals: { delays: { result: "missed" }, hardBounces: { result: "missed" } },
    });
  });

  it("pauses on a severe signal, keeping the signals, and says so once", async () => {
    const ctx = await warmingDomain({ allowance: 2_000, sent: 2_000 });
    const full = {
      type: "delivery_delayed" as const,
      data: {
        deliveryDelay: {
          delayType: "MailboxFull",
          delayedRecipients: [{ diagnosticCode: "smtp; 452 4.2.2 Mailbox full" }],
        },
      },
    };
    await seedSends(ctx, YESTERDAY, 60, { gmail: false, events: [full] });
    await seedSends(ctx, YESTERDAY, 1, {
      gmail: false,
      events: [
        {
          type: "bounced",
          bounceType: "Transient",
          data: {
            bounce: {
              bounceSubType: "General",
              bouncedRecipients: [{ diagnosticCode: "552 user is over quota" }],
            },
          },
        },
      ],
    });
    await healthyDay(ctx);
    // Three of the domain's broadcast emails still wait on it.
    await db.insert(schema.emails).values(
      [1, 2, 3].map((i) => ({
        teamId: ctx.teamId,
        domainId: ctx.domainId,
        broadcastId: ctx.broadcastId,
        from: "hi@news.example.com",
        to: [`w${i}@example.com`],
        subject: "s",
        latestStatus: "queued_quota" as const,
        parkReason: "warmup" as const,
      })),
    );
    const events = await checkWarmups(db, NOW);
    expect(events).toEqual([
      {
        kind: "warmup.paused",
        teamId: ctx.teamId,
        domainId: ctx.domainId,
        domain: expect.stringMatching(/\.example\.com$/),
        episode: NOW.toISOString(),
        signals: expect.objectContaining({
          mailboxFull: { gmail: 0, other: 61 / 861, result: "severe" },
        }),
        waiting: 3,
      },
    ]);
    const row = await rowOf(ctx);
    expect(row).toMatchObject({ status: "paused", pausedAt: NOW, volume: 2_000 });
    expect(row.pauseSignals?.mailboxFull.result).toBe("severe");
    expect((await dayOf(ctx, YESTERDAY))?.outcome).toBe("paused");
    expect(await checkWarmups(db, NOW)).toEqual([]);

    const [event] = events;
    if (event?.kind !== "warmup.paused") throw new Error("no pause");
    const mail = buildAccountMail({
      kind: "warmup.paused",
      locale: "en",
      url: "https://app.example/domains/d",
      values: warmupMailValues(event, "en"),
    });
    expect(mail.subject).toBe("Warm-up paused for your domain");
    // 61 of the day's 1,061 sends.
    expect(mail.text).toContain("5.75% of mailboxes were full or inactive.");
    expect(mail.text).toContain("3 emails are waiting until you resume.");
    expect(mail.text).not.toMatch(/[;—]/);
    const pt = buildAccountMail({
      kind: "warmup.paused",
      locale: "pt-BR",
      url: "https://app.example/domains/d",
      values: warmupMailValues({ ...event, waiting: 1 }, "pt-BR"),
    });
    expect(pt.text).toContain("5,75% das caixas estavam cheias ou inativas.");
    expect(pt.text).toContain("1 e-mail está esperando até você retomar.");
  });

  it("leaves a broadcast Gmail clips out of the opens: its pixel never loads there", async () => {
    const ctx = await warmingDomain({ allowance: 2_000, sent: 2_000 });
    // Gmail opens 1 in 100 against 1 in 5 elsewhere: severe, were the opens read.
    await seedSends(ctx, YESTERDAY, 2, { gmail: true, events: [delivered, opened] });
    await seedSends(ctx, YESTERDAY, 198, { gmail: true });
    await seedSends(ctx, YESTERDAY, 160, { gmail: false, events: [delivered, opened] });
    await seedSends(ctx, YESTERDAY, 640, { gmail: false });
    await db.insert(schema.emailInsights).values({
      teamId: ctx.teamId,
      broadcastId: ctx.broadcastId,
      marketing: true,
      checks: [],
      scoreTenths: 90,
      scoreVersion: 1,
      htmlSizeBytes: 150_000,
    });
    expect(await checkWarmups(db, NOW)).toEqual([]);
    expect(await rowOf(ctx)).toMatchObject({ status: "warming", volume: 3_000 });
    expect(await dayOf(ctx, YESTERDAY)).toMatchObject({
      outcome: "grew",
      signals: { opens: { result: "unknown" } },
    });
  });

  it("finishes a healthy day at the target", async () => {
    const ctx = await warmingDomain({ allowance: 10_000, sent: 9_000 }, { startVolume: 10_000 });
    await healthyDay(ctx);
    const [event] = await checkWarmups(db, NOW);
    expect(event).toMatchObject({ kind: "warmup.done", sent: 9_000 });
    expect(await rowOf(ctx)).toMatchObject({ status: "done", doneAt: NOW });
    expect(
      buildAccountMail({
        kind: "warmup.done",
        locale: "en",
        url: "https://app.example/domains/d",
        values: event ? warmupMailValues(event, "en") : {},
      }).text,
    ).toContain("sent 9,000 emails in a day with healthy delivery. Warm-up is done");
  });

  it("passes idle days, and starts over after 30 of them", async () => {
    const idle = await warmingDomain(null);
    await db
      .insert(schema.domainWarmupDays)
      .values({ domainId: idle.domainId, day: YESTERDAY, allowance: 2_000, sent: 0 });
    const gone = await newDomain();
    await enableWarmup(db, {
      ...gone,
      settings: { startVolume: 1_000 },
      now: new Date("2026-09-01T00:00:00Z"),
    });
    await db
      .update(schema.domainWarmups)
      .set({ volume: 8_000, checkedThrough: "2026-10-01" })
      .where(eq(schema.domainWarmups.domainId, gone.domainId));
    await db
      .insert(schema.domainWarmupDays)
      .values({ domainId: gone.domainId, day: "2026-09-08", allowance: 8_000, sent: 5_000 });
    expect(await checkWarmups(db, NOW)).toEqual([]);
    expect(await rowOf(idle)).toMatchObject({
      volume: 2_000,
      sendingDays: 0,
      checkedThrough: YESTERDAY,
    });
    expect(await dayOf(idle, YESTERDAY)).toMatchObject({ outcome: "idle", signals: null });
    // The 8th is thirty days past the last send.
    expect(await rowOf(gone)).toMatchObject({ volume: 1_000, checkedThrough: YESTERDAY });
  });
});

describe("turning it on and off", () => {
  it("starts at twice the best day lately, toward the team's audience, and restarts from off with its settings", async () => {
    const ctx = await newDomain();
    await seedSends(ctx, "2026-10-05", 3, { gmail: false });
    await db.insert(schema.contacts).values(
      Array.from({ length: 12 }, (_, i) => ({
        teamId: ctx.teamId,
        email: `aud${i}@example.com`,
      })),
    );
    expect(await enableWarmup(db, { ...ctx, now: NOW })).toBe(true);
    expect(await rowOf(ctx)).toMatchObject({
      status: "warming",
      volume: 1_500,
      startVolume: 1_500,
      dailyTarget: 10_000,
      sendingDays: 0,
      checkedThrough: YESTERDAY,
      startedAt: NOW,
      orderByEngagement: true,
      orderByTransactional: true,
      orderProperty: null,
      skipInactive: true,
    });

    expect(
      await updateWarmupSettings(db, {
        ...ctx,
        settings: { startVolume: 3_000, orderProperty: " last_order " },
        now: NOW,
      }),
    ).toBe(true);
    expect(await rowOf(ctx)).toMatchObject({
      startVolume: 3_000,
      volume: 3_000,
      orderProperty: "last_order",
    });
    expect(await turnOffWarmup(db, { ...ctx, now: NOW })).toBe(true);
    expect(await turnOffWarmup(db, { ...ctx, now: NOW })).toBe(false);
    // Today opened at a volume the restart is under.
    await db
      .insert(schema.domainWarmupDays)
      .values({ domainId: ctx.domainId, day: "2026-10-10", allowance: 9_000, sent: 2_000 });
    const later = new Date("2026-10-10T09:00:00Z");
    expect(await enableWarmup(db, { ...ctx, settings: { skipInactive: false }, now: later })).toBe(
      true,
    );
    expect(await rowOf(ctx)).toMatchObject({
      status: "warming",
      volume: 3_000,
      orderProperty: "last_order",
      skipInactive: false,
      startedAt: later,
    });
    expect(await dayOf(ctx, "2026-10-10")).toMatchObject({ allowance: 3_000 });
  });

  it("stamps the contacts with the opens and clicks already stored when it starts", async () => {
    const ctx = await newDomain();
    const lastWeek = new Date("2026-10-03T09:00:00Z");
    const yesterday = new Date("2026-10-09T09:00:00Z");
    const contacts = await db
      .insert(schema.contacts)
      .values([
        { teamId: ctx.teamId, email: `reader${seq}@example.com` },
        { teamId: ctx.teamId, email: `machine${seq}@example.com` },
        { teamId: ctx.teamId, email: `newer${seq}@example.com`, lastEngagedAt: yesterday },
      ])
      .returning({ id: schema.contacts.id });
    const copies = await db
      .insert(schema.emails)
      .values(
        contacts.map((c, i) => ({
          teamId: ctx.teamId,
          broadcastId: ctx.broadcastId,
          contactId: c.id,
          from: "hi@news.example.com",
          to: [`c${i}@example.com`],
          subject: "s",
          latestStatus: i === 1 ? ("delivered" as const) : ("clicked" as const),
        })),
      )
      .returning({ id: schema.emails.id });
    await db.insert(schema.emailEvents).values(
      copies.map((copy, i) => ({
        emailId: copy.id,
        type: i === 1 ? ("prefetched" as const) : ("clicked" as const),
        occurredAt: lastWeek,
      })),
    );
    await enableWarmup(db, { ...ctx, now: NOW });
    const engaged = await db
      .select({ id: schema.contacts.id, at: schema.contacts.lastEngagedAt })
      .from(schema.contacts)
      .where(eq(schema.contacts.teamId, ctx.teamId));
    const at = (id: string | undefined) => engaged.find((c) => c.id === id)?.at ?? null;
    expect(at(contacts[0]?.id)).toEqual(lastWeek);
    expect(at(contacts[1]?.id)).toBeNull();
    expect(at(contacts[2]?.id)).toEqual(yesterday);
  });

  it("pauses, resumes at half the volume from today, and refuses settings out of bounds", async () => {
    const ctx = await warmingDomain(null, { startVolume: 4_000 });
    await db
      .insert(schema.domainWarmupDays)
      .values({ domainId: ctx.domainId, day: "2026-10-10", allowance: 4_000, sent: 1_000 });
    expect(await resumeWarmup(db, { ...ctx, now: NOW })).toBe(false);
    expect(await pauseWarmup(db, { ...ctx, now: NOW })).toBe(true);
    expect(await rowOf(ctx)).toMatchObject({ status: "paused", pausedAt: NOW, pauseSignals: null });
    expect(await pauseWarmup(db, { ...ctx, now: NOW })).toBe(false);
    const later = new Date("2026-10-12T08:00:00Z");
    expect(await resumeWarmup(db, { ...ctx, now: later })).toBe(true);
    expect(await rowOf(ctx)).toMatchObject({
      status: "warming",
      volume: 2_000,
      checkedThrough: "2026-10-11",
      pausedAt: null,
    });

    const resumedToday = await warmingDomain(null, { startVolume: 4_000 });
    await db.insert(schema.domainWarmupDays).values({
      domainId: resumedToday.domainId,
      day: "2026-10-10",
      allowance: 4_000,
      sent: 2_500,
    });
    await pauseWarmup(db, { ...resumedToday, now: NOW });
    await resumeWarmup(db, { ...resumedToday, now: NOW });
    expect(await dayOf(resumedToday, "2026-10-10")).toMatchObject({ allowance: 2_500 });

    for (const settings of [
      { dailyTarget: 999 },
      { dailyTarget: 10_000_001 },
      { startVolume: 99 },
      { startVolume: 20_000 },
      { orderProperty: "x".repeat(101) },
    ]) {
      await expect(
        updateWarmupSettings(db, { ...ctx, settings, now: NOW }),
        JSON.stringify(settings),
      ).rejects.toThrow(RangeError);
    }
    // Anything past the six settings never reaches the row.
    const smuggled = { skipInactive: false, status: "done" };
    expect(await updateWarmupSettings(db, { ...ctx, settings: smuggled, now: NOW })).toBe(true);
    expect(await rowOf(ctx)).toMatchObject({ status: "warming", skipInactive: false });
  });

  it("acts on the team's own domains only", async () => {
    const ctx = await warmingDomain(null);
    const other = await createTeam(db, `ramp-other-${seq}`);
    const foreign = { teamId: other, domainId: ctx.domainId, now: NOW };
    expect(await enableWarmup(db, foreign)).toBe(false);
    expect(await pauseWarmup(db, foreign)).toBe(false);
    expect(await turnOffWarmup(db, foreign)).toBe(false);
    expect(await updateWarmupSettings(db, { ...foreign, settings: { skipInactive: false } })).toBe(
      false,
    );
    expect(await warmupOverview(db, foreign)).toBeNull();
    expect(await warmupSendPreview(db, { ...foreign, segmentId: null, topicId: null })).toBeNull();
    expect((await rowOf(ctx)).status).toBe("warming");
  });

  it("mails a pause or a finish on the deliverability switch", () => {
    expect(mailPreferenceOf("warmup.paused")).toBe("deliverability");
    expect(mailPreferenceOf("warmup.done")).toBe("deliverability");
  });
});

describe("the overview and the send preview", () => {
  it("counts the audience by the fan-out's rules, and what waits on the domain", async () => {
    const ctx = await newDomain({ openTracking: true });
    const at = (days: number) => new Date(NOW.getTime() - days * DAY_MS);
    const contacts = await db
      .insert(schema.contacts)
      .values([
        {
          teamId: ctx.teamId,
          email: "fresh@example.com",
          lastEngagedAt: at(10),
          properties: { seen: "1767225600" },
        },
        { teamId: ctx.teamId, email: "stale@example.com", lastEngagedAt: at(100) },
        { teamId: ctx.teamId, email: "Mailed@example.com", lastEngagedAt: at(200) },
        { teamId: ctx.teamId, email: "quiet@example.com" },
        { teamId: ctx.teamId, email: "old-buyer@example.com", properties: { seen: "2020-01-01" } },
        {
          teamId: ctx.teamId,
          email: "gone@example.com",
          unsubscribed: true,
          lastEngagedAt: at(300),
        },
      ])
      .returning({ id: schema.contacts.id, email: schema.contacts.email });
    // A transactional email five days ago makes the long-quiet contact active again.
    await db.insert(schema.emails).values({
      teamId: ctx.teamId,
      domainId: ctx.domainId,
      from: "hi@news.example.com",
      to: ["Mailed One <mailed@example.com>"],
      subject: "receipt",
      latestStatus: "delivered",
      createdAt: at(5),
      sentAt: at(5),
    });
    await seedSends(ctx, "2026-10-03", 5, { gmail: false });
    await seedSends(ctx, "2026-10-04", 2, { gmail: true });
    await db.insert(schema.emails).values(
      [1, 2].map((i) => ({
        teamId: ctx.teamId,
        domainId: ctx.domainId,
        broadcastId: ctx.broadcastId,
        from: "hi@news.example.com",
        to: [`w${i}@example.com`],
        subject: "s",
        latestStatus: "queued_quota" as const,
        parkReason: "warmup" as const,
      })),
    );

    const off = await warmupOverview(db, { ...ctx, now: NOW });
    expect(off).toMatchObject({
      status: "off",
      settings: {
        dailyTarget: 10_000,
        startVolume: 1_500,
        orderProperty: null,
        skipInactive: true,
      },
      today: null,
      waiting: 2,
      bestDay: 5,
      audience: { total: 5, inactive: 1, withProperty: null },
      openTracking: true,
    });
    expect(off?.projection.slice(0, 2)).toEqual([
      { day: "2026-10-11", volume: 2_300 },
      { day: "2026-10-12", volume: 3_500 },
    ]);
    expect(off?.projection.at(-1)).toEqual({ day: "2026-10-15", volume: 10_000 });

    await enableWarmup(db, { ...ctx, settings: { orderProperty: "seen" }, now: NOW });
    await reserveWarmupDay(db, {
      domainId: ctx.domainId,
      day: "2026-10-10",
      volume: 1_500,
      count: 40,
    });
    const on = await warmupOverview(db, { ...ctx, now: NOW });
    expect(on).toMatchObject({
      status: "warming",
      volume: 1_500,
      today: { day: "2026-10-10", allowance: 1_500, sent: 40, checked: true },
      audience: { total: 5, inactive: 2, withProperty: 2 },
    });
    expect(on?.days).toEqual([
      {
        day: "2026-10-10",
        allowance: 1_500,
        sent: 40,
        outcome: null,
        signals: null,
        checkedAt: null,
      },
    ]);

    // An opt-in topic two of them joined: one active, one stale.
    const [topic] = await db
      .insert(schema.topics)
      .values({ teamId: ctx.teamId, name: "News", defaultSubscribed: false })
      .returning({ id: schema.topics.id });
    const id = (email: string) => contacts.find((c) => c.email === email)?.id ?? "";
    await db.insert(schema.contactTopicSubscriptions).values(
      ["fresh@example.com", "stale@example.com"].map((email) => ({
        contactId: id(email),
        topicId: topic?.id ?? "",
        subscribed: true,
      })),
    );
    const preview = await warmupSendPreview(db, {
      ...ctx,
      segmentId: null,
      topicId: topic?.id ?? null,
      at: NOW,
      now: NOW,
    });
    expect(preview).toMatchObject({ status: "warming", bestDay: 5, eligible: 2, inactive: 1 });
    // The stale one is skipped; the one left goes after the two already waiting.
    expect(preview?.plan).toEqual({
      perDay: [{ day: "2026-10-10", count: 1 }],
      days: 1,
      finishesAt: NOW,
    });
  });
});

describe("warmupPropertyOptions", () => {
  async function teamWith(
    slug: string,
    defined: { key: string; type: "string" | "number" | "date" }[],
    properties: Record<string, string>[],
  ): Promise<string> {
    const teamId = await createTeam(db, slug);
    if (defined.length > 0) {
      await db.insert(schema.contactProperties).values(defined.map((d) => ({ teamId, ...d })));
    }
    await db
      .insert(schema.contacts)
      .values(
        properties.map((p, i) => ({ teamId, email: `${slug}${i}@example.com`, properties: p })),
      );
    return teamId;
  }

  it("lists date properties first, values or not, then keys at least half dates, the most dated first", async () => {
    const teamId = await teamWith(
      "options",
      [
        { key: "renewal", type: "date" },
        { key: "last_login", type: "date" },
        { key: "plan", type: "string" },
      ],
      [
        {
          last_login: "2026-10-01",
          seen: "2026-09-01T10:00:00Z",
          half: "2026-01-01",
          plan: "pro",
          count: "3",
        },
        { last_login: "soon", seen: "1767225600", half: "nope", plan: "free", count: "1500" },
        { seen: "not yet", half: "", count: "" },
      ],
    );
    await teamWith("options-other", [{ key: "elsewhere", type: "date" }], [{ born: "2026-01-01" }]);

    expect(await warmupPropertyOptions(db, teamId)).toEqual([
      { key: "last_login", declared: true, dated: 1, latest: new Date("2026-10-01T00:00:00Z") },
      { key: "renewal", declared: true, dated: 0, latest: null },
      { key: "seen", declared: false, dated: 2, latest: new Date("2026-09-01T10:00:00Z") },
      { key: "half", declared: false, dated: 1, latest: new Date("2026-01-01T00:00:00Z") },
    ]);
  });

  it("matches a date property to the contacts' key in any letter case, listed as they write it", async () => {
    const teamId = await teamWith(
      "options-case",
      [{ key: "LastLogin", type: "date" }],
      [{ lastLogin: "2026-10-01" }, { lastLogin: "2026-09-01T10:00:00Z" }],
    );
    expect(await warmupPropertyOptions(db, teamId)).toEqual([
      { key: "lastLogin", declared: true, dated: 2, latest: new Date("2026-10-01T00:00:00Z") },
    ]);
  });

  it("reads only the 20,000 most recently updated contacts", async () => {
    const teamId = await createTeam(db, "options-sample");
    const c = schema.contacts;
    await db.insert(c).values([
      {
        teamId,
        email: "old@example.com",
        properties: { old_seen: "2026-01-01" },
        updatedAt: new Date("2020-01-01T00:00:00Z"),
      },
      { teamId, email: "new@example.com", properties: { new_seen: "2026-01-01" } },
    ]);
    await db.execute(sql`
      insert into ${c} (team_id, email)
      select ${teamId}, 'bulk' || g || '@example.com' from generate_series(1, 19999) g
    `);
    expect((await warmupPropertyOptions(db, teamId)).map((o) => o.key)).toEqual(["new_seen"]);
  });
});
