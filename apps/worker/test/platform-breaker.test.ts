import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb, LURE_NAMES, mailLinks } from "@millionsend/test-utils";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { runPlatformBreaker } from "../src/handlers/platform-breaker.js";
import { regionPausedMail } from "../src/notifications/templates.js";

let db: Db;
let close: () => Promise<void>;
let sends: { to: string; subject: string; text: string; kind: string }[];

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
const ses = {
  regions: ["sa-east-1"],
  complaintRate: async () => {
    if (sesRate instanceof Error) throw sesRate;
    return sesRate;
  },
  loggedAt: new Map<string, Date>(),
};
const UNREADABLE =
  "platform.breaker: SES complaint rate unreadable in sa-east-1; without a reading from the last day, our own complaint count is judged";
const run = (now = NOW) =>
  runPlatformBreaker(db, { mailer, appBaseUrl: "https://app.example.test", now, ses });

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  sends = [];
  await db.insert(schema.user).values([
    { id: "op", name: "Operator", email: "op@example.com", createdAt: new Date(0) },
    { id: "later", name: "Later", email: "later@example.com", createdAt: new Date(1) },
  ]);
  const teamId = await createTeam(db, "Noisy Sender");
  const [domain] = await db
    .insert(schema.domains)
    .values({ teamId, name: "noisy.dev", region: "sa-east-1", status: "verified" })
    .returning({ id: schema.domains.id });
  if (!domain) throw new Error("seed failed");
  const sentAt = new Date(NOW.getTime() - 3_600_000);
  const rows = await db
    .insert(schema.emails)
    .values(
      Array.from({ length: 2000 }, (_, i) => ({
        teamId,
        domainId: domain.id,
        from: "f@noisy.dev",
        // Half to Gmail, which never reports a complaint to SES.
        to: [i < 1000 ? `r${i}@b.com` : `r${i}@gmail.com`],
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

it("trips on our own complaint count while SES's rate can't be read, logging the failed read once an hour", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const unreadable = () => warn.mock.calls.filter(([line]) => line === UNREADABLE).length;
  // An IAM policy from before the CloudWatch read: every read fails.
  sesRate = new Error("AccessDenied");
  // 5 complaints in the 1000 sends that can draw one over the last 24 hours,
  // past the 0.4% line.
  expect(await run()).toEqual({ tripped: ["sa-east-1"], resumed: [] });
  expect(sends).toHaveLength(1);
  expect(sends[0]?.subject).toBe(
    "Broadcasts paused in sa-east-1: platform complaint rate at 0.50%",
  );
  expect(sends[0]?.text).toContain(
    "the complaint rate over the last 24 hours is 0.50% (5 of 1000 sends to providers that report complaints), at or over the breaker's 0.40% line. SES reviews an account from 0.10% and pauses its sending at 0.50%.",
  );
  expect(sends[0]?.text).toContain(
    "SES's own complaint rate wasn't available (reading it takes cloudwatch:GetMetricData in the instance's IAM policy), so the breaker estimated it from our own count of complaints, leaving out mail to providers that never report them, such as Gmail.",
  );
  expect(sends[0]?.text).toContain("Noisy Sender: 0 hard bounces, 5 complaints");
  expect((await db.select().from(schema.regionBreakers))[0]?.reason).toEqual({
    metric: "complaint",
    source: "events",
    rate: 0.005,
    limit: 0.004,
    windowHours: 24,
    sent: 1000,
    events: 5,
  });
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
    "and so is the complaint rate the breaker judges: SES's own, or our estimate of it while that isn't available.",
  );
  sends = [];
});

it("alerts the operator at 0.3%, at most once a day, and never for a failed read", async () => {
  const t = at(3 * HOUR_MS);
  sesRate = 0.0033;
  expect(await run(t)).toEqual({ tripped: [], resumed: [] });
  expect(sends).toHaveLength(1);
  expect(sends[0]).toMatchObject({ to: "op@example.com", kind: "region.ses_complaints" });
  expect(sends[0]?.subject).toBe("SES complaint rate in sa-east-1 at 0.33%");
  expect(sends[0]?.text).toContain("pause on their own at 0.40%");
  expect(sends[0]?.text).toContain("Noisy Sender: 0 hard bounces, 5 complaints");
  expect((await db.select().from(schema.regionBreakers))[0]).toMatchObject({
    sesComplaintRate: 0.0033,
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
  expect((await db.select().from(schema.regionBreakers))[0]?.sesComplaintRate).toBe(0.0033);

  sesRate = 0.0032;
  await run(new Date(t.getTime() + DAY_MS));
  expect(sends).toHaveLength(2);
  expect(sends[1]?.subject).toBe("SES complaint rate in sa-east-1 at 0.32%");
  sends = [];
});

it("trips the region at 0.4% with the pause notice alone, and resumes once SES's rate is back under", async () => {
  const later = new Date(NOW.getTime() + 3 * DAY_MS);
  sesRate = 0.0042;
  expect(await run(later)).toEqual({ tripped: ["sa-east-1"], resumed: [] });
  expect(sends).toHaveLength(1);
  expect(sends[0]?.kind).toBe("region.paused");
  expect(sends[0]?.subject).toBe("Broadcasts paused in sa-east-1: SES complaint rate at 0.42%");
  expect(sends[0]?.text).toContain("Noisy Sender: 0 hard bounces, 5 complaints");
  // The dashboard carries no hold banner: the details live in the console.
  expect(sends[0]?.text).toContain("Open console: https://app.example.test/console/regions");
  expect((await db.select().from(schema.regionBreakers))[0]?.reason).toEqual({
    metric: "complaint",
    source: "ses",
    rate: 0.0042,
    limit: 0.004,
  });

  // Paused: neither a second pause notice nor the daily alert.
  expect(await run(new Date(later.getTime() + DAY_MS))).toEqual({ tripped: [], resumed: [] });
  expect(sends).toHaveLength(1);

  sesRate = 0.0009;
  expect(await run(new Date(later.getTime() + 2 * DAY_MS))).toEqual({
    tripped: [],
    resumed: ["sa-east-1"],
  });
  expect(sends[1]?.subject).toBe("Broadcasts resumed in sa-east-1");
  expect((await db.select().from(schema.regionBreakers))[0]?.paused).toBe(false);
});

it("names contributing teams called like lures with no link but the console's", () => {
  const url = "https://app.example.test/console";
  const mail = regionPausedMail({
    region: "sa-east-1",
    reason: { metric: "complaint", source: "ses", rate: 0.0045, limit: 0.004 },
    contributors: LURE_NAMES.map((team) => ({ team, hardBounced: 0, complained: 1 })),
    url,
  });
  expect(
    mailLinks(mail).filter((link) => link !== url && link !== "https://millionsend.com"),
  ).toEqual([]);
});

it("counts a bounce trip over every send", () => {
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
    url: "https://app.example.test/console",
  });
  expect(mail.text).toContain(
    "the hard-bounce rate over the last 168 hours is 4.50% (45 of 1000 sends), at or over the breaker's 4.00% line, set short of SES's own review line for the whole account.",
  );
  expect(mail.text).not.toContain("cloudwatch");
});
