import {
  createLimitRequest,
  DAY_MS,
  declineLimitRequest,
  type QueuedWebhookDelivery,
  setWarmupTrust,
  utcDay,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb, readable } from "@millionsend/test-utils";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sweepNotifications } from "../src/handlers/notify.js";

const NOW = new Date("2026-10-20T18:00:00Z");
const REGISTERED = new Date("2026-10-17T18:00:00Z");

let db: Db;
let close: () => Promise<void>;
let teamId: string;
let sends: { to: string; subject: string; text: string; html: string }[];

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await db.insert(schema.instanceSettings).values({ id: 1, warmupEnabled: true });
  // The first account is the instance operator.
  await db
    .insert(schema.user)
    .values({ id: "op", name: "Operator", email: "op@example.com", createdAt: new Date(0) });
  teamId = await createTeam(db, "nova");
  await db.insert(schema.user).values([
    { id: "owner", name: "Owner", email: "owner@example.com" },
    { id: "asker", name: "Asker", email: "asker@example.com" },
  ]);
  await db.insert(schema.teamMembers).values([
    { teamId, userId: "owner", role: "owner" },
    { teamId, userId: "asker", role: "member" },
  ]);
  sends = [];
});
afterEach(() => close());

const sweep = (now = NOW) =>
  sweepNotifications(db, {
    isCloud: false,
    mailer: {
      send: async (to, m) => {
        sends.push({ to, subject: m.subject, text: readable(m.text), html: m.html });
      },
    },
    enqueueWebhook: async (_rows: readonly QueuedWebhookDelivery[]) => {},
    appBaseUrl: "https://app.example.test",
    now,
  });

async function domain(
  name: string,
  registeredAt: Date | null,
  over: Partial<typeof schema.domains.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(schema.domains)
    .values({ teamId, name, region: "us-east-1", status: "verified", registeredAt, ...over })
    .returning({ id: schema.domains.id });
  if (!row) throw new Error("domain insert failed");
  return row.id;
}

async function park(domainId: string, over: Partial<typeof schema.emails.$inferInsert> = {}) {
  await db.insert(schema.emails).values({
    teamId,
    domainId,
    from: "hi@nova.example",
    to: ["r@example.com"],
    subject: "s",
    latestStatus: "queued_quota",
    parkReason: "warmup",
    ...over,
  });
}

describe("domain.verified", () => {
  it("tells a young domain's limit and how to move mail over, and an old domain nothing of it", async () => {
    await domain("nova.example", REGISTERED, { verifiedAt: NOW });
    await domain("ageless.example", null, { verifiedAt: NOW });
    await domain("old.example", new Date("2020-01-01"), { verifiedAt: NOW });
    await sweep();
    const mail = (name: string) => sends.find((s) => s.text.includes(`DNS records for ${name}`));
    expect(mail("nova.example")?.text).toBe(
      [
        "The DNS records for nova.example check out. It can send from any address on it, through the API, SMTP and broadcasts.",
        "It was registered recently, so it starts with a daily limit: up to 300 emails today, more each day, and no limit from November 16, 2026. Mail over the day's limit waits and goes out the next day, on its own.",
        "Moving mail you already send elsewhere to this domain? Reply to this email before you switch and we'll take a look.",
        "We keep re-checking the records and will tell you if one disappears.",
        `Open domain: https://app.example.test/domains/${await idOf("nova.example")}`,
        "\n",
      ].join("\n\n"),
    );
    expect(mail("ageless.example")?.text).toContain(
      "It starts with a daily limit of up to 300 emails for now, rising as it builds a sending history.",
    );
    expect(mail("old.example")?.text).not.toContain("limit");
    expect(mail("old.example")?.html).not.toMatch(/<p[^>]*><\/p>/);
  });
});

/** What the domain's registrable name, or with `team` the team's new domains together, sent on `at`'s UTC day. */
async function used(accepted: number, at: Date, name: string | { team: true }) {
  const day = utcDay(at);
  if (typeof name === "string") {
    await db.insert(schema.domainWarmupUsage).values({ registrableDomain: name, day, accepted });
  } else {
    await db.insert(schema.teamWarmupUsage).values({ teamId, day, accepted });
  }
}

async function idOf(name: string): Promise<string> {
  const [row] = await db
    .select({ id: schema.domains.id })
    .from(schema.domains)
    .where(and(eq(schema.domains.teamId, teamId), eq(schema.domains.name, name)));
  return row?.id ?? "";
}

describe("domain.waiting", () => {
  it("mails the owners once a UTC day once the limit's day is spent and holds a domain's mail", async () => {
    const id = await domain("nova.example", REGISTERED);
    await used(300, NOW, "nova.example");
    await park(id);
    await park(id);
    await park(id, { parkReason: "screening" });
    await park(id, { parkReason: null });
    expect(await sweep()).toEqual({ sent: 1 });
    expect(sends.map((s) => [s.to, s.subject])).toEqual([
      ["owner@example.com", "Your new domain reached today's limit"],
    ]);
    expect(sends[0]?.text).toBe(
      [
        "2 emails waiting",
        "nova.example reached its daily limit of 300 emails. Nothing is broken. The rest wait and go out on their own after 00:00 UTC, so there's no need to resend.",
        "The limit grows each day, and the domain sends with no limit from November 16, 2026.",
        "New domains start small because inbox providers are wary of mail from them. A higher plan doesn't change it. Moving mail you already send elsewhere? Reply to this email and we'll take a look.",
        `See waiting emails: https://app.example.test/emails?status=queued_quota&domain=${id}&source=all&range=all`,
        "You get this at most once a day per domain while its mail waits.\n",
      ].join("\n\n"),
    );
    await sweep(new Date(NOW.getTime() + 3600_000));
    expect(sends).toHaveLength(1);
    await park(id);
    await used(300, new Date(NOW.getTime() + DAY_MS), "nova.example");
    await sweep(new Date(NOW.getTime() + DAY_MS));
    expect(sends.map((s) => s.text.split("\n")[0])).toEqual([
      "2 emails waiting",
      "3 emails waiting",
    ]);
    // Yesterday's claim is gone, today's holds.
    const claims = await db
      .select({ periodKey: schema.teamNotifications.periodKey })
      .from(schema.teamNotifications)
      .where(eq(schema.teamNotifications.kind, `domain.waiting:${id}`));
    expect(claims).toEqual([{ periodKey: "2026-10-21" }]);
  });

  it("says nothing while the day still has room, so the day's one notice waits for the limit", async () => {
    const id = await domain("nova.example", REGISTERED);
    await park(id);
    await park(id);
    // Just past 00:00 UTC: yesterday's held mail is still parked and today's room is untouched.
    const midnight = new Date("2026-10-21T00:00:30Z");
    expect(await sweep(midnight)).toEqual({ sent: 0 });
    const claims = () =>
      db
        .select({ periodKey: schema.teamNotifications.periodKey })
        .from(schema.teamNotifications)
        .where(eq(schema.teamNotifications.kind, `domain.waiting:${id}`));
    expect(await claims()).toEqual([]);
    await used(300, midnight, "nova.example");
    expect(await sweep(new Date("2026-10-21T15:00:00Z"))).toEqual({ sent: 1 });
    expect(sends[0]?.text).toContain("nova.example reached its daily limit of 300 emails.");
    expect(await claims()).toEqual([{ periodKey: "2026-10-21" }]);
  });

  it("names the limit the team's new domains share when that is what is spent", async () => {
    await domain("labs.example", REGISTERED);
    const id = await domain("nova.example", REGISTERED);
    await used(300, NOW, { team: true });
    await park(id);
    expect(await sweep()).toEqual({ sent: 1 });
    expect(sends[0]?.text).toContain(
      "nova.example and your other new domains sent the 300 emails they share for today. Nothing is broken.",
    );
    expect(sends[0]?.text).not.toContain("reached its daily limit");
  });

  it("says nothing for silent holds, a reputation warm-up's copies, a trusted domain or an owner who turned it off", async () => {
    const silent = await domain("silent.example", REGISTERED);
    for (const parkReason of [
      "review",
      "screening",
      "destination",
      "media",
      "recipient",
    ] as const) {
      await park(silent, { parkReason });
    }
    const ramped = await domain("ramped.example", REGISTERED);
    await db.insert(schema.domainWarmups).values({
      domainId: ramped,
      teamId,
      volume: 1500,
      startVolume: 1500,
      dailyTarget: 10_000,
    });
    const [broadcast] = await db
      .insert(schema.broadcasts)
      .values({ teamId, from: "news@ramped.example", subject: "s", status: "sending" })
      .returning({ id: schema.broadcasts.id });
    await park(ramped, { broadcastId: broadcast?.id ?? null });
    const trusted = await domain("trusted.example", REGISTERED, { warmupTrustedAt: NOW });
    await park(trusted);
    expect(await sweep()).toEqual({ sent: 0 });

    const held = await domain("held.example", REGISTERED);
    await park(held);
    await db
      .update(schema.user)
      .set({ mailOptOuts: ["domain.waiting"] })
      .where(eq(schema.user.id, "owner"));
    await sweep();
    expect(sends).toEqual([]);
  });
});

describe("limit requests", () => {
  async function ask(domainId: string, userId = "asker") {
    const asked = await createLimitRequest(db, {
      teamId,
      domainId,
      userId,
      sends: "account",
      perDay: 2000,
      source: "new",
      note: "People sign up and get a confirmation email.",
      now: NOW,
    });
    if (!asked.ok) throw new Error(`request refused: ${asked.refusal}`);
    return asked.request.id;
  }

  it("tells the operator once about each new request, and nothing of one already answered", async () => {
    const id = await domain("nova.example", REGISTERED);
    await ask(id);
    await sweep();
    expect(sends.map((s) => [s.to, s.subject])).toEqual([
      ["op@example.com", "A team asked for a higher daily limit"],
    ]);
    expect(sends[0]?.text).toBe(
      [
        "nova asked to lift the new domain limit on nova.example.",
        "Asked for: about 2,000 emails a day. Sends: sign-up and account emails. Goes out today: nowhere yet, it's a new product.",
        "Their note: People sign up and get a confirmation email.",
        "Grant it with Trust on the domain, or decline it, from the team's review page. The team hears back by email either way.",
        `Open review: https://app.example.test/console/safety/${teamId}`,
        "Sent to the instance operator once per request.\n",
      ].join("\n\n"),
    );
    await sweep();
    expect(sends).toHaveLength(1);

    const other = await domain("labs.example", REGISTERED);
    const requestId = await ask(other);
    await declineLimitRequest(db, { requestId, operator: "op@example.com" });
    sends = [];
    await sweep();
    expect(sends.map((s) => s.subject)).toEqual([
      "We reviewed your daily limit request",
      "We reviewed your daily limit request",
    ]);
  });

  it("answers once, to the owners and whoever asked, never naming who decided", async () => {
    const kept = await domain("nova.example", REGISTERED);
    const lifted = await domain("labs.example", REGISTERED);
    const keptRequest = await ask(kept);
    await ask(lifted);
    await sweep();
    sends = [];
    await declineLimitRequest(db, { requestId: keptRequest, operator: "op@example.com" });
    await setWarmupTrust(db, {
      teamId,
      domainId: lifted,
      trusted: true,
      operator: "op@example.com",
    });
    await sweep();
    expect(sends.map((s) => [s.to, s.subject]).sort()).toEqual([
      ["asker@example.com", "We reviewed your daily limit request"],
      ["asker@example.com", "Your domain's daily limit is lifted"],
      ["owner@example.com", "We reviewed your daily limit request"],
      ["owner@example.com", "Your domain's daily limit is lifted"],
    ]);
    const text = (subject: string) => sends.find((s) => s.subject === subject)?.text ?? "";
    expect(text("We reviewed your daily limit request")).toContain(
      "nova.example keeps its daily limit for now. It grows on its own, with no limit from November 16, 2026. Reply to this email if you have questions.",
    );
    expect(text("Your domain's daily limit is lifted")).toContain(
      "labs.example now sends without the daily limit for new domains. Mail that was waiting is going out now.",
    );
    for (const s of sends) expect(s.text).not.toMatch(/op@example\.com|operator|trust/i);
    await sweep();
    expect(sends).toHaveLength(4);
  });

  it("leaves out whoever asked once they left the team, and the date when the age is unknown", async () => {
    const id = await domain("ageless.example", null);
    const requestId = await ask(id);
    await sweep();
    sends = [];
    await db.delete(schema.teamMembers).where(eq(schema.teamMembers.userId, "asker"));
    await declineLimitRequest(db, { requestId, operator: "op@example.com" });
    await sweep();
    expect(sends.map((s) => s.to)).toEqual(["owner@example.com"]);
    expect(sends[0]?.text).toContain(
      "ageless.example keeps its daily limit for now. Reply to this email if you have questions.",
    );
  });

  it("tells a declined domain that left the limit meanwhile that the limit is lifted", async () => {
    // Asked on day 25, then declined and answered once the domain is 31 days old.
    const id = await domain("nova.example", new Date(NOW.getTime() - 25 * DAY_MS));
    const requestId = await ask(id);
    await sweep();
    sends = [];
    const later = new Date(NOW.getTime() + 6 * DAY_MS);
    await declineLimitRequest(db, { requestId, operator: "op@example.com", now: later });
    await sweep(later);
    expect(sends.map((s) => s.subject)).toEqual([
      "Your domain's daily limit is lifted",
      "Your domain's daily limit is lifted",
    ]);
    expect(sends[0]?.text).not.toContain("keeps its daily limit");
  });
});
