import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb, LURE_NAMES, mailLinks } from "@millionsend/test-utils";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { type PlatformBreakerDeps, runPlatformBreaker } from "../src/handlers/platform-breaker.js";
import { regionPausedMail } from "../src/notifications/templates.js";

let db: Db;
let close: () => Promise<void>;
let sends: { to: string; subject: string; text: string; kind: string }[];
let teamId: string;

const NOW = new Date("2026-09-03T12:00:00Z");
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const at = (ms: number) => new Date(NOW.getTime() + ms);
const mailer = {
  send: async (to: string, m: { subject: string; text: string; kind: string }) => {
    sends.push({ to, subject: m.subject, text: m.text, kind: m.kind });
  },
};
/** SES's complaint rate as CloudWatch would answer it; an Error makes the read fail. */
let sesRate: number | null | Error = null;
/** SES's enforcement status as GetAccount would answer it. */
let enforcement: string | null = null;
const ses = {
  regions: ["sa-east-1"],
  complaintRate: async () => {
    if (sesRate instanceof Error) throw sesRate;
    return sesRate;
  },
  enforcementStatus: async () => enforcement,
  loggedAt: new Map<string, Date>(),
};
const UNREADABLE =
  "platform.breaker: SES complaint rate unreadable in sa-east-1; without a reading from the last day, our own complaint count is judged";
const run = (now = NOW, over: Partial<PlatformBreakerDeps> = {}) =>
  runPlatformBreaker(db, {
    mailer,
    appBaseUrl: "https://app.example.test",
    now,
    isCloud: false,
    defaultRegion: "sa-east-1",
    ses,
    ...over,
  });

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  sends = [];
  await db.insert(schema.user).values([
    { id: "op", name: "Operator", email: "op@example.com", createdAt: new Date(0) },
    { id: "later", name: "Later", email: "later@example.com", createdAt: new Date(1) },
  ]);
  teamId = await createTeam(db, "Noisy Sender");
  const [domain] = await db
    .insert(schema.domains)
    .values({ teamId, name: "noisy.example", region: "sa-east-1", status: "verified" })
    .returning({ id: schema.domains.id });
  if (!domain) throw new Error("seed failed");
  const sentAt = new Date(NOW.getTime() - 3_600_000);
  const rows = await db
    .insert(schema.emails)
    .values(
      Array.from({ length: 2000 }, (_, i) => ({
        teamId,
        domainId: domain.id,
        from: "f@noisy.example",
        // Half to Gmail, which never reports a complaint to SES.
        to: [i < 1000 ? `r${i}@example.com` : `r${i}@gmail.com`],
        subject: "s",
        sentAt,
      })),
    )
    .returning({ id: schema.emails.id });
  for (const email of rows.slice(0, 5)) {
    await db.insert(schema.emailEvents).values({
      emailId: email.id,
      type: "complained",
      occurredAt: sentAt,
      createdAt: sentAt,
      snsMessageId: `sns-${email.id}`,
      data: {},
    });
  }
});
afterAll(() => close());

it("trips on our own complaint count while SES's rate can't be read, holding the team drawing them, logging the failed read once an hour", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const unreadable = () => warn.mock.calls.filter(([line]) => line === UNREADABLE).length;
  // An IAM policy from before the CloudWatch read: every read fails.
  sesRate = new Error("AccessDenied");
  // 5 complaints in the 1000 sends that can draw one over the last 24 hours,
  // past the 0.1% line.
  expect(await run()).toEqual({ tripped: ["sa-east-1"], resumed: [] });
  expect(sends).toHaveLength(1);
  expect(sends[0]?.subject).toBe(
    "Broadcasts paused in sa-east-1 for the teams drawing complaints: platform complaint rate at 0.50%",
  );
  expect(sends[0]?.text).toContain(
    "the complaint rate over the last 24 hours is 0.50% (5 of 1000 sends to providers that report complaints), at or over the breaker's 0.10% line. SES reviews an account from 0.10% and pauses its sending at 0.50%.",
  );
  expect(sends[0]?.text).toContain(
    "SES's own complaint rate wasn't available (reading it takes cloudwatch:GetMetricData in the instance's IAM policy), so the breaker estimated it from our own count of complaints, leaving out mail to providers that never report them, such as Gmail.",
  );
  // Self-hosted, every team counts as paid and nobody is held for review.
  expect(sends[0]?.text).toContain(
    "Only the broadcasts of the teams at or over 0.10% complaints over their own last 30 days are held: Noisy Sender. Every other team keeps sending, transactional email keeps flowing, and the pause lifts once the rate is back under 0.08%.",
  );
  expect(sends[0]?.text).not.toContain("Free");
  expect(sends[0]?.text).toContain(
    "Teams behind the hard bounces and complaints about mail sent in the last 30 days:",
  );
  expect(sends[0]?.text).toContain("Noisy Sender: 0 hard bounces, 5 complaints");
  expect(sends[0]?.text).not.toContain("no email row");
  const [row] = await db.select().from(schema.regionBreakers);
  expect(row?.reason).toEqual({
    metric: "complaint",
    source: "events",
    rate: 0.005,
    limit: 0.001,
    windowHours: 24,
    sent: 1000,
    events: 5,
  });
  expect(row?.heldTeams).toEqual([teamId]);
  expect(unreadable()).toBe(1);
  await run(at(15 * 60_000));
  await run(at(45 * 60_000));
  expect(unreadable()).toBe(1);
  await run(at(HOUR_MS));
  expect(unreadable()).toBe(2);
  warn.mockRestore();

  // Once SES's rate reads, it alone judges complaints: ours no longer counts.
  sesRate = 0.0005;
  expect(await run(at(2 * HOUR_MS))).toEqual({ tripped: [], resumed: ["sa-east-1"] });
  expect(sends[1]?.subject).toBe("Broadcasts resumed in sa-east-1");
  expect(sends[1]?.text).toContain(
    "and so is the complaint rate the breaker judges: SES's own, or our estimate of it while that isn't available (a pause the complaints tripped waits until it is under 0.08%). Held broadcasts resume on their own; teams held for review stay held until you release them.",
  );
  sends = [];
});

it("alerts the operator at 0.08%, at most once a day, and never for a failed read", async () => {
  const t = at(3 * HOUR_MS);
  sesRate = 0.0009;
  expect(await run(t)).toEqual({ tripped: [], resumed: [] });
  expect(sends).toHaveLength(1);
  expect(sends[0]).toMatchObject({ to: "op@example.com", kind: "region.ses_complaints" });
  expect(sends[0]?.subject).toBe("SES complaint rate in sa-east-1 at 0.09%");
  expect(sends[0]?.text).toContain(
    "at 0.10% the region's breaker holds the broadcasts of the teams drawing the complaints",
  );
  expect(sends[0]?.text).toContain("Noisy Sender: 0 hard bounces, 5 complaints");
  expect(sends[0]?.text).toContain(
    "Sent to the instance operator when SES's complaint rate in a region is at or over 0.08%, at most once a day.",
  );
  expect((await db.select().from(schema.regionBreakers))[0]).toMatchObject({
    sesComplaintRate: 0.0009,
    paused: false,
  });

  await run(new Date(t.getTime() + HOUR_MS));
  expect(sends).toHaveLength(1);

  // CloudWatch down for a while: the stored reading stands, so our own count
  // (still past its line) trips nothing, and nobody is told twice.
  sesRate = new Error("Throttling");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(await run(new Date(t.getTime() + 2 * HOUR_MS))).toEqual({ tripped: [], resumed: [] });
  expect(warn).toHaveBeenCalledWith(UNREADABLE, sesRate);
  warn.mockRestore();
  expect(sends).toHaveLength(1);
  expect((await db.select().from(schema.regionBreakers))[0]?.sesComplaintRate).toBe(0.0009);

  sesRate = 0.00092;
  await run(new Date(t.getTime() + DAY_MS));
  expect(sends).toHaveLength(2);
  expect(sends[1]?.subject).toBe("SES complaint rate in sa-east-1 at 0.09%");
  sends = [];
});

it("trips the region at 0.1% with the pause notice alone, keeps alerting a day apart while paused, and resumes only under 0.08%", async () => {
  const later = new Date(NOW.getTime() + 3 * DAY_MS);
  sesRate = 0.0012;
  expect(await run(later)).toEqual({ tripped: ["sa-east-1"], resumed: [] });
  expect(sends).toHaveLength(1);
  expect(sends[0]?.kind).toBe("region.paused");
  expect(sends[0]?.subject).toBe(
    "Broadcasts paused in sa-east-1 for the teams drawing complaints: SES complaint rate at 0.12%",
  );
  expect(sends[0]?.text).toContain("Noisy Sender: 0 hard bounces, 5 complaints");
  // The dashboard carries no hold banner: the details live in the console.
  expect(sends[0]?.text).toContain("Open console: https://app.example.test/console/regions");
  expect((await db.select().from(schema.regionBreakers))[0]?.reason).toEqual({
    metric: "complaint",
    source: "ses",
    rate: 0.0012,
    limit: 0.001,
  });

  // Paused: no second pause notice, and the daily alert only a day later.
  expect(await run(new Date(later.getTime() + HOUR_MS))).toEqual({ tripped: [], resumed: [] });
  expect(sends).toHaveLength(1);
  expect(await run(new Date(later.getTime() + DAY_MS))).toEqual({ tripped: [], resumed: [] });
  expect(sends.map((s) => s.kind)).toEqual(["region.paused", "region.ses_complaints"]);
  expect(sends[1]?.subject).toBe("SES complaint rate in sa-east-1 at 0.12%");

  // Under the trip line but over the alert line: still paused.
  sesRate = 0.0009;
  expect(await run(new Date(later.getTime() + DAY_MS + HOUR_MS))).toEqual({
    tripped: [],
    resumed: [],
  });
  sesRate = 0.0007;
  expect(await run(new Date(later.getTime() + DAY_MS + 2 * HOUR_MS))).toEqual({
    tripped: [],
    resumed: ["sa-east-1"],
  });
  expect(sends.at(-1)?.subject).toBe("Broadcasts resumed in sa-east-1");
  expect((await db.select().from(schema.regionBreakers))[0]?.paused).toBe(false);
  sends = [];
});

it("adds the month's complaints on mail with no email row to the alert, and names domainless mail's team", async () => {
  const later = new Date(NOW.getTime() + 6 * DAY_MS);
  // A shared inbox domain's mail has no domain row: it went out in the default region.
  const inboxTeam = await createTeam(db, "Inbox Sender");
  const [email] = await db
    .insert(schema.emails)
    .values({
      teamId: inboxTeam,
      from: "a@shared.example",
      to: ["r@example.com"],
      subject: "s",
      sentAt: new Date(later.getTime() - DAY_MS),
    })
    .returning({ id: schema.emails.id });
  if (!email) throw new Error("seed failed");
  for (let i = 0; i < 9; i++) {
    await db.insert(schema.emailEvents).values({
      emailId: email.id,
      type: "complained",
      occurredAt: later,
      createdAt: later,
      snsMessageId: `sns-inbox-${i}`,
      data: {},
    });
  }
  await db.insert(schema.sesUnmatchedEvents).values([
    { sesMessageId: "gone-1", type: "complained", occurredAt: later, createdAt: later },
    { sesMessageId: "gone-2", type: "complained", occurredAt: later, createdAt: later },
    // SES never attempted it: not in its rates either.
    {
      sesMessageId: "gone-3",
      type: "complained",
      subType: "OnAccountSuppressionList",
      occurredAt: later,
      createdAt: later,
    },
  ]);
  sesRate = 0.0009;
  await run(later);
  expect(sends.map((s) => s.kind)).toEqual(["region.ses_complaints"]);
  expect(sends[0]?.text).toContain("Inbox Sender: 0 hard bounces, 9 complaints");
  expect(sends[0]?.text).toContain(
    "SES also reported 2 complaints in the last 30 days about mail with no email row left (expired, a deleted team's, or sent outside MillionSend), which no team above accounts for.",
  );
  expect(sends[0]?.text.indexOf("Inbox Sender")).toBeLessThan(
    sends[0]?.text.indexOf("Noisy Sender") ?? 0,
  );
  sesRate = 0.0005;
  sends = [];
});

it("tells the operator when SES changes the account's enforcement status, a first HEALTHY read saying nothing", async () => {
  const later = new Date(NOW.getTime() + 9 * DAY_MS);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  enforcement = "HEALTHY";
  await run(later);
  expect(sends).toEqual([]);
  enforcement = "PROBATION";
  await run(new Date(later.getTime() + HOUR_MS));
  await run(new Date(later.getTime() + 2 * HOUR_MS));
  expect(sends).toHaveLength(1);
  expect(sends[0]).toMatchObject({
    kind: "region.ses_enforcement",
    subject: "SES account status in sa-east-1: PROBATION",
  });
  expect(sends[0]?.text).toContain(
    "SES moved the account's enforcement status in sa-east-1 from HEALTHY to PROBATION.",
  );
  // A read that fails or names no status keeps the last one.
  enforcement = null;
  await run(new Date(later.getTime() + 3 * HOUR_MS));
  expect(sends).toHaveLength(1);
  warn.mockRestore();
  sends = [];
});

it("names contributing teams called like lures with no link but the console's", () => {
  const url = "https://app.example.test/console";
  const mail = regionPausedMail({
    region: "sa-east-1",
    reason: { metric: "complaint", source: "ses", rate: 0.0045, limit: 0.001 },
    contributors: LURE_NAMES.map((team) => ({ team, hardBounced: 0, complained: 1 })),
    heldTeams: [...LURE_NAMES],
    isCloud: true,
    unmatched: 0,
    url,
  });
  expect(
    mailLinks(mail).filter((link) => link !== url && link !== "https://millionsend.com"),
  ).toEqual([]);
});

it("counts a bounce trip over every send, holding every team's broadcasts", () => {
  const mail = regionPausedMail({
    region: "sa-east-1",
    reason: {
      metric: "bounce",
      rate: 0.045,
      limit: 0.04,
      windowHours: 168,
      sent: 1000,
      events: 45,
    },
    contributors: [],
    heldTeams: null,
    isCloud: false,
    unmatched: 0,
    url: "https://app.example.test/console",
  });
  expect(mail.subject).toBe("Broadcasts paused in sa-east-1: platform hard-bounce rate at 4.50%");
  expect(mail.text).toContain(
    "the hard-bounce rate over the last 168 hours is 4.50% (45 of 1000 sends), at or over the breaker's 4.00% line, set short of SES's own review line for the whole account.",
  );
  expect(mail.text).toContain(
    "Every team's broadcasts in this region are held until the rate drops back under the line; transactional email keeps flowing.",
  );
  expect(mail.text).not.toContain("cloudwatch");
});
