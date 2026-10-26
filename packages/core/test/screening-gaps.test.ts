import { randomUUID } from "node:crypto";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyJudgedSample,
  type MonitorDeps,
  markLostSamples,
  planBroadcastSamples,
} from "../src/abuse-monitor.js";
import {
  forgetPhishingPrints,
  linkTeam,
  recordPhishingFingerprints,
} from "../src/campaign-linkage.js";
import type { DomainAge, DomainAgeResolver } from "../src/domain-age.js";
import { MONITOR_SETTING_DEFAULTS } from "../src/monitor-settings.js";
import {
  anyYoungLinkDomain,
  clearDestinations,
  destinationStanding,
  LINK_AGE_LOOKUPS_PER_VERDICT,
  releaseWaitingEmails,
  revokeDestinations,
  screenBeforeSend,
  spareWaitingSamples,
  verdictClearsDestinations,
} from "../src/screening.js";
import { suspendTeam } from "../src/team-standing.js";
import { DAY_MS } from "../src/utc-day.js";

/**
 * Where screening could fail open, one check each: caps, clearing and its
 * probation, novelty bounds, link ages, broadcast samples, the review
 * list's release and the linkage's fingerprint read.
 */

const S = MONITOR_SETTING_DEFAULTS;
const NOW = new Date("2026-10-11T12:00:00Z");

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

const deps = (settings = S, queued: string[] = []): MonitorDeps => ({
  samplingKey: Buffer.alloc(32),
  settings: async () => settings,
  enqueueJudge: async (id) => void queued.push(id),
});

function resolver(ages: Record<string, Date | null | Error>, delays: Record<string, number> = {}) {
  const asked: string[] = [];
  const r: DomainAgeResolver = {
    async lookup(hostname): Promise<DomainAge> {
      asked.push(hostname);
      const delay = delays[hostname] ?? 0;
      if (delay) await new Promise((done) => setTimeout(done, delay));
      const age = ages[hostname] ?? null;
      if (age instanceof Error) throw age;
      return { domain: hostname, registeredAt: age, source: age ? "rdap" : "unknown" };
    },
  };
  return { r, asked };
}

describe("the daily caps", () => {
  it("never stop a new team's broadcast from being screened", async () => {
    const teamId = await createTeam(db, "capped-broadcast");
    const [broadcast] = await db
      .insert(schema.broadcasts)
      .values({ teamId, from: "B <hi@capped.dev>", subject: "news", html: "<p>Hi</p>" })
      .returning({ id: schema.broadcasts.id });
    const capped = { ...S, teamDailyCap: 0, instanceDailyCap: 0 };
    const plan = await planBroadcastSamples(db, deps(capped), {
      teamId,
      broadcastId: broadcast?.id ?? "",
      now: NOW,
    });
    expect(plan).toMatchObject({ screen: true, tier: "new" });
    expect(plan.skeletonSampleId).not.toBeNull();
  });
});

describe("clearing a destination", () => {
  it("takes a verdict under 70 naming nothing phishing-type, on at most 5 new destinations", () => {
    const clean = { score: 60, categories: [], reasons: [] };
    expect(verdictClearsDestinations(clean, 5)).toBe(true);
    expect(verdictClearsDestinations(clean, 6)).toBe(false);
    expect(verdictClearsDestinations({ ...clean, score: 70 }, 1)).toBe(false);
    expect(verdictClearsDestinations({ ...clean, categories: ["phishing_credentials"] }, 1)).toBe(
      false,
    );
    expect(verdictClearsDestinations({ ...clean, reasons: ["impersonation"] }, 1)).toBe(false);
  });

  it("keeps it in probation for 7 days, and a revocation makes it new again until an operator clears it", async () => {
    const teamId = await createTeam(db, "probation");
    await clearDestinations(db, teamId, ["lately.example"], new Date(NOW.getTime() - 2 * DAY_MS));
    await clearDestinations(db, teamId, ["long-ago.example"], new Date(NOW.getTime() - 9 * DAY_MS));
    const all = ["lately.example", "long-ago.example", "never.example"];
    expect(await destinationStanding(db, teamId, all, NOW)).toEqual({
      novel: ["never.example"],
      probation: ["lately.example"],
      vouched: [],
    });
    expect(await revokeDestinations(db, teamId, ["lately.example"], NOW)).toEqual([
      "lately.example",
    ]);
    // No verdict clears it again; an operator's release does.
    await clearDestinations(db, teamId, ["lately.example"], NOW);
    expect((await destinationStanding(db, teamId, all, NOW)).novel).toContain("lately.example");
    await clearDestinations(db, teamId, ["lately.example"], NOW, { operator: true });
    expect(await destinationStanding(db, teamId, all, NOW)).toEqual({
      novel: ["never.example"],
      probation: ["lately.example"],
      vouched: ["lately.example"],
    });
    // An operator's clearance marks a name a verdict had cleared, and keeps its date.
    await clearDestinations(db, teamId, ["long-ago.example"], NOW, { operator: true });
    expect(await destinationStanding(db, teamId, all, NOW)).toEqual({
      novel: ["never.example"],
      probation: ["lately.example"],
      vouched: ["lately.example", "long-ago.example"],
    });
  });
});

describe("link domain ages", () => {
  it(`looks up at most ${LINK_AGE_LOOKUPS_PER_VERDICT} per verdict, the rest in the background, each once`, async () => {
    const old = new Date(NOW.getTime() - 900 * DAY_MS);
    const domains = ["bound-1.com", "bound-2.com", "bound-3.com", "bound-4.com", "bound-5.com"];
    const { r, asked } = resolver(Object.fromEntries(domains.map((d) => [d, old])));
    // Two ages wait their turn, so the answer is not known yet.
    expect(await anyYoungLinkDomain(db, r, domains, NOW, { budgetMs: 1000 })).toBeNull();
    expect(asked.length).toBeGreaterThanOrEqual(LINK_AGE_LOOKUPS_PER_VERDICT);
    await new Promise((done) => setTimeout(done, 50));
    expect([...asked].sort()).toEqual(domains);
    expect(await anyYoungLinkDomain(db, r, domains, NOW, { budgetMs: 1000 })).toBe(false);
    expect(asked).toHaveLength(domains.length);
  });

  it("remembers a failed lookup for an hour, its age not known meanwhile", async () => {
    const { r, asked } = resolver({ "flaky-registry.com": new Error("registry down") });
    const ask = () => anyYoungLinkDomain(db, r, ["flaky-registry.com"], NOW, { budgetMs: 1000 });
    expect(await ask()).toBeNull();
    expect(await ask()).toBeNull();
    expect(asked).toEqual(["flaky-registry.com"]);
  });

  it("answers young as soon as one lookup does, whatever a slow decoy is doing", async () => {
    const { r } = resolver(
      {
        "slow-decoy.com": new Date(NOW.getTime() - 900 * DAY_MS),
        "fresh-lure-2.com": new Date(NOW.getTime() - DAY_MS),
      },
      { "slow-decoy.com": 5_000 },
    );
    const started = Date.now();
    expect(
      await anyYoungLinkDomain(db, r, ["slow-decoy.com", "fresh-lure-2.com"], NOW, {
        budgetMs: 10_000,
      }),
    ).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("lost samples", () => {
  it("queues a screening sample again, and marks only an after-send draw unjudged", async () => {
    const teamId = await createTeam(db, "lost");
    const long = new Date(NOW.getTime() - 4 * 3600_000);
    const [waiting, drawn] = await db
      .insert(schema.monitorSamples)
      .values([
        { teamId, kind: "first_sends", screening: true, createdAt: long },
        { teamId, kind: "tier", createdAt: long },
      ])
      .returning({ id: schema.monitorSamples.id });
    const requeued: string[] = [];
    expect(
      await markLostSamples(db, NOW, async (id, opts) => {
        expect(opts?.screening).toBe(true);
        requeued.push(id);
      }),
    ).toBe(1);
    expect(requeued).toEqual([waiting?.id]);
    const status = async (id: string | undefined) =>
      (
        await db
          .select({ status: schema.monitorSamples.status })
          .from(schema.monitorSamples)
          .where(eq(schema.monitorSamples.id, id ?? ""))
      )[0]?.status;
    expect(await status(waiting?.id)).toBe("pending");
    expect(await status(drawn?.id)).toBe("unjudged");
  });
});

describe("broadcast samples", () => {
  it("pause a new team's broadcasts on a lure whatever the sample's kind", async () => {
    const judged = async (slug: string, broadcast: boolean) => {
      const teamId = await createTeam(db, slug);
      await db.insert(schema.teamMonitor).values({ teamId, sentTotal: 1, firstSendAt: NOW });
      return applyJudgedSample(db, S, {
        teamId,
        score: 85,
        verdict: { verdict: "abuse", categories: ["phishing_credentials"], reasons: [] },
        kind: "destination",
        broadcast,
        now: NOW,
      });
    };
    expect(await judged("copy-for-destination", true)).toMatchObject({ paused: true });
    expect(await judged("transactional-destination", false)).toMatchObject({ paused: false });
  });
});

describe("the review list's release", () => {
  it("takes only mail parked by the time shown, and clears only what a destination park vouched for", async () => {
    const teamId = await createTeam(db, "release-scope");
    const shown = new Date(NOW.getTime() - 60_000);
    const park = async (reason: "destination" | "media", parkedAt: Date, destination: string) => {
      const id = randomUUID();
      await db.insert(schema.emails).values({
        id,
        teamId,
        from: "T <hi@release-scope.dev>",
        to: ["r@example.org"],
        subject: "s",
        latestStatus: "queued_quota",
        parkReason: reason,
        parkedAt,
      });
      await db.insert(schema.monitorSamples).values({
        teamId,
        emailId: id,
        kind: "destination",
        screening: true,
        status: "judged",
        destinations: [destination],
      });
      return id;
    };
    const vouched = await park("destination", new Date(shown.getTime() - 1000), "vouched.example");
    const media = await park("media", new Date(shown.getTime() - 1000), "media-only.example");
    const later = await park("destination", new Date(shown.getTime() + 1000), "later.example");
    await clearDestinations(db, teamId, ["vouched.example"], new Date(0));
    await revokeDestinations(db, teamId, ["vouched.example"], new Date(0));

    expect(
      await releaseWaitingEmails(db, { teamId, parkedBefore: shown, holdLine: 80, now: NOW }),
    ).toEqual({ parked: 2, queued: [] });
    const reasons = await db
      .select({ id: schema.emails.id, parkReason: schema.emails.parkReason })
      .from(schema.emails)
      .where(eq(schema.emails.teamId, teamId));
    expect(reasons.find((row) => row.id === later)?.parkReason).toBe("destination");
    expect(reasons.find((row) => row.id === vouched)?.parkReason).toBeNull();
    expect(reasons.find((row) => row.id === media)?.parkReason).toBeNull();
    expect(
      await destinationStanding(
        db,
        teamId,
        ["vouched.example", "media-only.example", "later.example"],
        NOW,
      ),
    ).toEqual({
      novel: ["media-only.example", "later.example"],
      probation: ["vouched.example"],
      vouched: ["vouched.example"],
    });
  });
});

describe("the suspension of a held team", () => {
  it("cancels the mail its hold or an operator parked unless the suspension is the hold itself", async () => {
    const teamId = await createTeam(db, "held-then-phishing");
    const park = async (parkReason: "review" | "recipient") => {
      const id = randomUUID();
      await db.insert(schema.emails).values({
        id,
        teamId,
        from: "T <hi@held.dev>",
        to: ["r@example.org"],
        subject: "s",
        latestStatus: "queued_quota",
        parkReason,
      });
      return id;
    };
    await park("review");
    await park("recipient");
    await suspendTeam(db, { teamId, reason: "review" });
    const statuses = async () =>
      (
        await db
          .select({ status: schema.emails.latestStatus })
          .from(schema.emails)
          .where(eq(schema.emails.teamId, teamId))
      ).map((row) => row.status);
    expect(await statuses()).toEqual(["queued_quota", "queued_quota"]);
    await suspendTeam(db, { teamId, reason: "manual" });
    expect(await statuses()).toEqual(["canceled", "canceled"]);
    const [audit] = await db
      .select({ action: schema.auditLog.action, data: schema.auditLog.data })
      .from(schema.auditLog)
      .where(
        and(eq(schema.auditLog.teamId, teamId), eq(schema.auditLog.action, "screening.canceled")),
      );
    expect(audit?.data).toEqual({ emails: 2, reason: "manual" });
  });
});

describe("the phishing fingerprints a send compares with", () => {
  it("are read once per process for a while, and again when a suspension writes new ones", async () => {
    const member = async (teamId: string, email: string) => {
      const userId = randomUUID();
      await db.insert(schema.user).values({ id: userId, name: "Person", email });
      await db.insert(schema.teamMembers).values({ teamId, userId, role: "owner" });
    };
    const phisher = await createTeam(db, "prints-phisher");
    await member(phisher, "lure.sender@gmail.com");
    await suspendTeam(db, { teamId: phisher, reason: "phishing" });
    await recordPhishingFingerprints(db, { teamId: phisher, reason: "phishing" });
    const returning = async (slug: string, email: string) => {
      const teamId = await createTeam(db, slug);
      await member(teamId, email);
      return linkTeam(db, { teamId, trigger: "team" });
    };
    expect(await returning("prints-a", "luresender@gmail.com")).not.toBeNull();
    // Gone from the table, still in this process's read.
    await db
      .delete(schema.campaignFingerprints)
      .where(eq(schema.campaignFingerprints.teamId, phisher));
    expect(await returning("prints-b", "lure.sender+b@gmail.com")).not.toBeNull();
    forgetPhishingPrints(db);
    expect(await returning("prints-c", "LureSender@googlemail.com")).toBeNull();
    // A suspension that writes new fingerprints is read at once.
    const other = await createTeam(db, "prints-other");
    await member(other, "other.lure@gmail.com");
    await suspendTeam(db, { teamId: other, reason: "phishing" });
    await recordPhishingFingerprints(db, { teamId: other, reason: "phishing" });
    expect(await returning("prints-d", "otherlure@gmail.com")).not.toBeNull();
  });
});

describe("a link to a local address", () => {
  it("is never a new destination, never in probation and never clears, not even on an operator's release", async () => {
    const teamId = await createTeam(db, "local-links");
    const all = ["app.localhost", "127.0.0.1", "lately.example"];
    await clearDestinations(db, teamId, all, NOW, { operator: true });
    expect(await destinationStanding(db, teamId, [...all, "[::1]"], NOW)).toEqual({
      novel: [],
      probation: ["lately.example"],
      vouched: ["lately.example"],
    });
  });
});

describe("the gate's read of the team", () => {
  it("is the one its caller made this send, not a second", async () => {
    const teamId = await createTeam(db, "read-once");
    const decision = await screenBeforeSend(db, deps(), {
      email: {
        id: randomUUID(),
        teamId,
        domainId: null,
        broadcastId: null,
        from: "T <hi@read-once.dev>",
        to: ["r@example.org"],
        cc: null,
        bcc: null,
        replyTo: null,
        inboxId: null,
        threadId: null,
        screenReleasedAt: null,
      },
      body: { html: "<p>Hello</p>", text: null },
      // The database would read this team as new; the caller read it exempt.
      team: { tier: "exempt", firstWindow: false },
      now: NOW,
    });
    expect(decision).toEqual({ action: "send", sample: null, probation: false });
  });
});

describe("a spared verdict's burst", () => {
  it("parks the team's waiting phishing-type mail, queued or parked for quota, and nothing else", async () => {
    const teamId = await createTeam(db, "burst-scope");
    const LURE = {
      verdict: "abuse",
      categories: ["phishing_credentials"],
      reasons: ["off_domain_lure", "harvests_secrets"],
    };
    const mail = async (
      status: "queued" | "queued_quota" | "sent",
      parkReason: "destination" | null,
      sample: Partial<typeof schema.monitorSamples.$inferInsert>,
    ) => {
      const id = randomUUID();
      await db.insert(schema.emails).values({
        id,
        teamId,
        from: "T <hi@burst-scope.dev>",
        to: ["r@example.org"],
        subject: "s",
        latestStatus: status,
        parkReason,
        sentAt: status === "sent" ? NOW : null,
      });
      const [row] = await db
        .insert(schema.monitorSamples)
        .values({
          teamId,
          emailId: id,
          kind: "first_sends",
          screening: true,
          status: "judged",
          score: 85,
          ...LURE,
          ...sample,
        })
        .returning({ id: schema.monitorSamples.id });
      return row?.id ?? "";
    };
    const queued = await mail("queued", null, {});
    const quota = await mail("queued_quota", null, {});
    const operatorParked = await mail("queued_quota", "destination", {});
    const vouched = await mail("queued", null, { sparedHold: "vouched" });
    const clean = await mail("queued", null, {
      score: 40,
      verdict: "clean",
      categories: [],
      reasons: [],
    });
    const spam = await mail("queued", null, { categories: ["unsolicited_bulk"], reasons: [] });
    const sent = await mail("sent", null, { score: 95 });
    expect(await spareWaitingSamples(db, { teamId, holdRepeatScore: 80 })).toBe(2);
    const marks = new Map(
      (
        await db
          .select({ id: schema.monitorSamples.id, sparedHold: schema.monitorSamples.sparedHold })
          .from(schema.monitorSamples)
          .where(eq(schema.monitorSamples.teamId, teamId))
      ).map((row) => [row.id, row.sparedHold]),
    );
    expect(marks.get(queued)).toBe("burst");
    expect(marks.get(quota)).toBe("burst");
    for (const id of [operatorParked, clean, spam, sent]) expect(marks.get(id)).toBeNull();
    expect(marks.get(vouched)).toBe("vouched");
  });
});
