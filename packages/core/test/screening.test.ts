import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyJudgedSample,
  type MonitorDeps,
  monitorRowWithHistory,
} from "../src/abuse-monitor.js";
import { MONITOR_SETTING_DEFAULTS } from "../src/monitor-settings.js";
import {
  releaseWaitingEmails,
  SCREEN_RETRIES,
  screenBeforeSend,
  sendingDomainYoung,
} from "../src/screening.js";
import { DAY_MS, utcDay } from "../src/utc-day.js";
import {
  addInbox,
  addThread,
  type InboxRow,
  receive,
  seedWorld,
  type World,
} from "./inbox-send-fixtures.js";

const S = MONITOR_SETTING_DEFAULTS;
const NOW = new Date("2026-10-11T12:00:00Z");
const PHISHING = {
  verdict: "abuse" as const,
  categories: ["payment_redirect"],
  reasons: ["harvests_secrets"],
};

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

async function newTeam(slug: string) {
  const teamId = await createTeam(db, slug);
  await db.insert(schema.teamMonitor).values({ teamId, sentTotal: 1, firstSendAt: NOW });
  return teamId;
}
const team = async (teamId: string) =>
  (await db.select().from(schema.teams).where(eq(schema.teams.id, teamId)))[0];

describe("the young sending domain", () => {
  it("reads a domain under 7 days old, or of unknown age, as young", async () => {
    const teamId = await createTeam(db, "ages");
    const add = async (name: string, registeredAt: Date | null) =>
      (
        await db
          .insert(schema.domains)
          .values({ teamId, name, region: "us-east-1", status: "verified", registeredAt })
          .returning({ id: schema.domains.id })
      )[0]?.id ?? "";
    const young = await add("young.dev", new Date(NOW.getTime() - 6 * DAY_MS));
    const week = await add("week.dev", new Date(NOW.getTime() - 7 * DAY_MS));
    const unknown = await add("unknown.dev", null);
    expect(await sendingDomainYoung(db, { teamId, domainId: young }, NOW)).toBe(true);
    expect(await sendingDomainYoung(db, { teamId, domainId: week }, NOW)).toBe(false);
    expect(await sendingDomainYoung(db, { teamId, domainId: unknown }, NOW)).toBe(true);
    expect(await sendingDomainYoung(db, { teamId, name: "Young.dev" }, NOW)).toBe(true);
    // Another team's domain, or none, says nothing.
    const other = await createTeam(db, "ages-other");
    expect(await sendingDomainYoung(db, { teamId: other, domainId: young }, NOW)).toBeNull();
    expect(await sendingDomainYoung(db, { teamId, domainId: null }, NOW)).toBeNull();
  });

  it("holds a new team on one phishing verdict from 80 while its sending domain is young", async () => {
    const held = await newTeam("young-held");
    expect(
      await applyJudgedSample(db, S, {
        teamId: held,
        score: 81,
        verdict: PHISHING,
        youngSendingDomain: true,
        now: NOW,
      }),
    ).toMatchObject({ held: { rule: "young_domain" } });
    expect(await team(held)).toMatchObject({ suspensionReason: "review" });

    // An aged domain, a verdict under the repeat line, or other abuse: no hold.
    const aged = await newTeam("young-aged");
    const call = (teamId: string, score: number, verdict = PHISHING, young = true) =>
      applyJudgedSample(db, S, {
        teamId,
        score,
        verdict,
        youngSendingDomain: young,
        now: NOW,
      }).then((o) => o.held);
    expect(await call(aged, 89, PHISHING, false)).toBeNull();
    expect(await call(aged, 79)).toBeNull();
    expect(
      await call(aged, 85, {
        verdict: "abuse",
        categories: ["scam"],
        reasons: ["unsolicited_bulk"],
      }),
    ).toBeNull();
    expect((await team(aged))?.suspendedAt).toBeNull();
  });
});

describe("cold shared-domain mail", () => {
  const monitor: MonitorDeps = {
    samplingKey: Buffer.alloc(32),
    settings: async () => S,
    enqueueJudge: async () => {},
  };

  /** A shared agent inbox of a team well past new. */
  async function sharedInbox(slug: string) {
    const w = await seedWorld(db, slug);
    await db.insert(schema.teamMonitor).values({
      teamId: w.teamId,
      sentTotal: 20_000,
      firstSendAt: new Date(Date.now() - 60 * DAY_MS),
    });
    return { w, inbox: await addInbox(w, { local: "agent", shared: true }) };
  }

  async function email(w: World, inbox: InboxRow, to: string, threadId?: string | null) {
    const [row] = await db
      .insert(schema.emails)
      .values({
        teamId: w.teamId,
        from: inbox.emailAddress,
        to: [to],
        subject: "Monday",
        inboxId: inbox.id,
        threadId: threadId ?? (await addThread(w, inbox.id)),
      })
      .returning();
    if (!row) throw new Error("email insert failed");
    return row;
  }

  // No link: nothing but the recipient can screen it.
  const gate = (w: World, row: typeof schema.emails.$inferSelect) =>
    screenBeforeSend(db, monitor, {
      email: row,
      body: { html: "<p>Are you free on Monday?</p>", text: null },
      sharedInboxDomain: w.sharedDomain,
      now: new Date(),
    });
  const unscreened = { action: "send", sample: null, probation: false };

  const sampleOf = async (emailId: string) =>
    (
      await db
        .select()
        .from(schema.monitorSamples)
        .where(eq(schema.monitorSamples.emailId, emailId))
    )[0];
  const answer = (
    id: string | undefined,
    set: Partial<typeof schema.monitorSamples.$inferInsert>,
  ) =>
    db
      .update(schema.monitorSamples)
      .set({ judgedAt: new Date(), ...set })
      .where(eq(schema.monitorSamples.id, id ?? ""));

  it("judges a second send to someone who never wrote in, and none once they have", async () => {
    const { w, inbox } = await sharedInbox("cold-again");
    const first = await email(w, inbox, "stranger@example.com");
    expect(await gate(w, first)).toEqual({ action: "wait", until: null });
    const judged = await sampleOf(first.id);
    expect(judged).toMatchObject({ screening: true, status: "pending" });
    await answer(judged?.id, { status: "judged", score: 5, verdict: "clean" });
    expect(await gate(w, first)).toEqual({
      action: "send",
      sample: { id: judged?.id, unjudged: false },
    });

    // Its accept wrote to them; they never wrote back.
    const c = schema.inboxCorrespondents;
    await db
      .insert(c)
      .values({ inboxId: inbox.id, address: "stranger@example.com", firstOutAt: new Date() });
    const second = await email(w, inbox, "stranger@example.com", first.threadId);
    expect(await gate(w, second)).toEqual({ action: "wait", until: null });
    expect(await sampleOf(second.id)).toMatchObject({ screening: true, status: "pending" });

    await db.update(c).set({ firstInAt: new Date() }).where(eq(c.inboxId, inbox.id));
    expect(await gate(w, await email(w, inbox, "Stranger <Stranger@Example.com>"))).toEqual(
      unscreened,
    );
  });

  it("leaves mail to a member, or to a sender its thread vouches for, unscreened", async () => {
    const { w, inbox } = await sharedInbox("cold-known");
    expect(await gate(w, await email(w, inbox, w.owner))).toEqual(unscreened);
    // A Reply-To at the From's organization: it never wrote in itself.
    const threadId = await addThread(w, inbox.id);
    await receive(w, { inbox, threadId, message: { replyTo: "desk@sender.example" } });
    expect(await gate(w, await email(w, inbox, "desk@sender.example", threadId))).toEqual(
      unscreened,
    );
  });

  it("parks an established team's cold mail on a phishing verdict with no link", async () => {
    const { w, inbox } = await sharedInbox("cold-phishing");
    const row = await email(w, inbox, "stranger@example.com");
    await gate(w, row);
    await answer((await sampleOf(row.id))?.id, { status: "judged", score: 85, ...PHISHING });
    expect(await gate(w, row)).toEqual({ action: "park", reason: "recipient" });
  });

  it("parks cold shared mail on a credential link to a platform name an operator cleared, vouched or not", async () => {
    const { w, inbox } = await sharedInbox("cold-vouched");
    const row = await email(w, inbox, "stranger@example.com");
    await gate(w, row);
    await answer((await sampleOf(row.id))?.id, {
      status: "judged",
      score: 93,
      verdict: "abuse",
      categories: ["phishing_credentials"],
      reasons: ["off_domain_lure", "harvests_secrets"],
      sparedHold: "vouched",
    });
    expect(await gate(w, row)).toEqual({ action: "park", reason: "recipient" });
  });

  it("parks shared mail the judge keeps failing on, as a young domain's", async () => {
    const { w, inbox } = await sharedInbox("cold-outage");
    const row = await email(w, inbox, "stranger@example.com");
    await gate(w, row);
    const id = (await sampleOf(row.id))?.id;
    await answer(id, { status: "unjudged", errorClass: "upstream" });
    expect(await gate(w, row)).toEqual({ action: "wait", until: null });
    expect(await sampleOf(row.id)).toMatchObject({ status: "pending", screenRetries: 1 });
    await answer(id, { status: "unjudged", errorClass: "upstream", screenRetries: SCREEN_RETRIES });
    expect(await gate(w, row)).toEqual({ action: "park", reason: "screening" });
  });
});

describe("the broadcast lure", () => {
  it("pauses a new team's broadcasts on one phishing verdict from 80 on its HTML or a copy", async () => {
    for (const kind of ["broadcast_skeleton", "broadcast_copy"] as const) {
      const teamId = await newTeam(`lure-${kind}`);
      const out = await applyJudgedSample(db, S, {
        teamId,
        score: 82,
        verdict: PHISHING,
        kind,
        now: NOW,
      });
      expect(out).toMatchObject({ paused: true, held: null });
      expect((await team(teamId))?.broadcastsPausedByOperatorAt).toEqual(NOW);
    }
    // The same verdict on a transactional email pauses nothing on its own.
    const single = await newTeam("lure-single");
    expect(
      await applyJudgedSample(db, S, {
        teamId: single,
        score: 82,
        verdict: PHISHING,
        kind: "first_sends",
        now: NOW,
      }),
    ).toMatchObject({ paused: false });
    // Nor past the new tier, nor with the policy off.
    const settled = await createTeam(db, "lure-settled");
    await db.insert(schema.teamMonitor).values({
      teamId: settled,
      sentTotal: 20_000,
      firstSendAt: new Date(NOW.getTime() - 60 * DAY_MS),
    });
    const off = await newTeam("lure-off");
    for (const [teamId, s] of [
      [settled, S],
      [off, { ...S, autoPause: false }],
    ] as const) {
      expect(
        await applyJudgedSample(db, s, {
          teamId,
          score: 95,
          verdict: PHISHING,
          kind: "broadcast_copy",
          now: NOW,
        }),
      ).toMatchObject({ paused: false });
    }
  });
});

describe("the tier read ahead of a send", () => {
  it("takes a quiet old team's history from the usage counters, and leaves a new one empty", async () => {
    const quiet = await createTeam(db, "history-quiet");
    await db.insert(schema.usageCounters).values([
      { teamId: quiet, day: utcDay(new Date(NOW.getTime() - 300 * DAY_MS)), sent: 4000 },
      { teamId: quiet, day: utcDay(new Date(NOW.getTime() - 200 * DAY_MS)), sent: 2000 },
    ]);
    const row = await monitorRowWithHistory(db, quiet, NOW);
    expect(row).toMatchObject({
      sentTotal: 6000,
      firstSendAt: new Date(`${utcDay(new Date(NOW.getTime() - 300 * DAY_MS))}T00:00:00Z`),
    });
    const fresh = await createTeam(db, "history-fresh");
    expect(await monitorRowWithHistory(db, fresh, NOW)).toMatchObject({
      sentTotal: 0,
      firstSendAt: null,
    });
  });
});

describe("the review list", () => {
  it("releases what screening parked, never what a review hold parked", async () => {
    const teamId = await createTeam(db, "release-scope");
    const insert = (parkReason: "screening" | "review") =>
      db
        .insert(schema.emails)
        .values({
          teamId,
          from: "A <a@x.dev>",
          to: ["r@example.org"],
          subject: "s",
          latestStatus: "queued_quota",
          parkReason,
        })
        .returning({ id: schema.emails.id })
        .then((r) => r[0]?.id ?? "");
    const screened = await insert("screening");
    const held = await insert("review");
    expect(await releaseWaitingEmails(db, { teamId, holdLine: 80, now: NOW })).toEqual({
      parked: 1,
      queued: [],
    });
    const rows = await db.select().from(schema.emails).where(eq(schema.emails.teamId, teamId));
    expect(rows.find((r) => r.id === screened)).toMatchObject({
      parkReason: null,
      screenReleasedAt: NOW,
    });
    expect(rows.find((r) => r.id === held)).toMatchObject({ parkReason: "review" });
  });
});
