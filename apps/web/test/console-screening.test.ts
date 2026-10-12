import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createCaller } from "@/server/routers";

const h = vi.hoisted(() => ({ sent: [] as string[], drains: 0 }));
vi.mock("@/server/system-mail", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/system-mail")>();
  return { ...actual, sendAccountMail: () => {} };
});
vi.mock("@/server/queue", () => ({
  getQueue: async () => ({
    runCronNow: async () => {
      h.drains += 1;
    },
  }),
  enqueueEmailSend: async (emailId: string) => {
    h.sent.push(emailId);
  },
  enqueueWebhookDeliveries: async () => {},
  enqueueRecipientErase: async () => {},
}));

let db: Db;
let close: () => Promise<void>;
const OPERATOR = "op";

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await db
    .insert(schema.user)
    .values({ id: OPERATOR, name: "Operator", email: "op@example.com", createdAt: new Date(0) });
});
afterAll(() => close());

const operator = () =>
  createCaller({
    db,
    session: {
      user: { id: OPERATOR, email: "op@example.com", name: "Operator" },
      session: { id: "s-op", createdAt: new Date() },
    },
    teamId: null,
    role: null,
  });

async function waiting(
  teamId: string,
  status: "queued" | "queued_quota",
  parkReason: "screening" | "review" | null,
) {
  const [row] = await db
    .insert(schema.emails)
    .values({
      teamId,
      from: "Lure <a@lure.dev>",
      to: ["r@example.org", "s@example.org"],
      subject: "s",
      latestStatus: status,
      parkReason,
    })
    .returning({ id: schema.emails.id });
  return row?.id ?? "";
}

async function verdict(teamId: string, emailId: string, score: number) {
  await db.insert(schema.monitorSamples).values({
    teamId,
    emailId,
    kind: "first_sends",
    status: "judged",
    screening: true,
    score,
    verdict: "abuse",
    categories: ["phishing_credentials"],
    reasons: [],
    judgedAt: new Date(),
  });
}

it("lists what screening stopped, grouped by team, and releases or cancels it", async () => {
  const open = await createTeam(db, "screened");
  const outage = await waiting(open, "queued_quota", "screening");
  const shortWait = await waiting(open, "queued", null);
  await verdict(open, shortWait, 85);
  // Judged clean and about to go: not waiting on anyone.
  const clean = await waiting(open, "queued", null);
  await verdict(open, clean, 85);
  await db
    .update(schema.monitorSamples)
    .set({ verdict: "clean", categories: [] })
    .where(eq(schema.monitorSamples.emailId, clean));

  const held = await createTeam(db, "held");
  await db
    .update(schema.teams)
    .set({ suspendedAt: new Date(), suspensionReason: "review" })
    .where(eq(schema.teams.id, held));
  const heldMail = await waiting(held, "queued_quota", "review");
  // A hold already turned into a phishing suspension: nothing left to decide.
  const converted = await createTeam(db, "converted");
  await db
    .update(schema.teams)
    .set({ suspendedAt: new Date(), suspensionReason: "phishing" })
    .where(eq(schema.teams.id, converted));
  await waiting(converted, "queued_quota", "review");

  const { groups } = await operator().console.safety.waiting({});
  expect(groups.map((g) => g.team.name).sort()).toEqual(["held", "screened"]);
  const screened = groups.find((g) => g.team.id === open);
  expect(screened?.total).toBe(2);
  expect(screened?.emails.map((e) => [e.id, e.why, e.score, e.recipients]).sort()).toEqual(
    [
      [outage, "outage", null, 2],
      [shortWait, "verdict", 85, 2],
    ].sort(),
  );
  expect(groups.find((g) => g.team.id === held)?.emails).toMatchObject([
    { id: heldMail, why: "held" },
  ]);
  const one = await operator().console.safety.waiting({ teamId: held });
  expect(one.groups.map((g) => g.team.id)).toEqual([held]);

  // A held team's mail goes with its hold, never one by one.
  await expect(
    operator().console.safety.releaseWaiting({ teamId: held, emailIds: [heldMail] }),
  ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

  expect(
    await operator().console.safety.releaseWaiting({ teamId: open, parkedBefore: new Date() }),
  ).toEqual({
    released: 2,
  });
  expect(h.sent).toEqual([shortWait]);
  expect(h.drains).toBe(1);
  const [released] = await db.select().from(schema.emails).where(eq(schema.emails.id, outage));
  expect(released).toMatchObject({ parkReason: null, latestStatus: "queued_quota" });
  expect(released?.screenReleasedAt).not.toBeNull();

  expect(
    await operator().console.safety.cancelWaiting({ teamId: held, emailIds: [heldMail] }),
  ).toEqual({ canceled: 1 });
  const [canceled] = await db.select().from(schema.emails).where(eq(schema.emails.id, heldMail));
  expect(canceled?.latestStatus).toBe("canceled");

  const audits = await db.select().from(schema.auditLog).where(isNull(schema.auditLog.teamId));
  expect(audits.map((a) => [a.action, a.target]).sort()).toEqual(
    [
      ["screening.canceled", `team:${held}`],
      ["screening.released", `team:${open}`],
    ].sort(),
  );
  expect((await operator().console.safety.waiting({})).groups).toEqual([]);
});

it("lets the review page open a held email that never went out", async () => {
  const teamId = await createTeam(db, "review-held");
  const unsent = await waiting(teamId, "queued_quota", "review");
  await verdict(teamId, unsent, 92);
  const review = await operator().console.safety.review({ teamId });
  expect(review.flaggedEmails).toMatchObject([{ id: unsent, sentAt: null, check: null }]);
  const rows = await db
    .select()
    .from(schema.monitorSamples)
    .where(and(eq(schema.monitorSamples.emailId, unsent)));
  expect(rows).toHaveLength(1);
});

it("lists mail parked for a new destination with it, and a release clears the destination", async () => {
  const teamId = await createTeam(db, "destination");
  const [parked] = await db
    .insert(schema.emails)
    .values({
      teamId,
      from: "Shop <a@shop.dev>",
      to: ["r@example.org"],
      subject: "s",
      latestStatus: "queued_quota",
      parkReason: "destination",
    })
    .returning({ id: schema.emails.id });
  await db.insert(schema.monitorSamples).values({
    teamId,
    emailId: parked?.id,
    kind: "destination",
    status: "judged",
    screening: true,
    score: 93,
    verdict: "abuse",
    categories: ["phishing_credentials"],
    reasons: [],
    destinations: ["evil-pay.com"],
    judgedAt: new Date(),
  });
  const { groups } = await operator().console.safety.waiting({ teamId });
  expect(groups[0]?.emails).toMatchObject([
    { id: parked?.id, why: "destination", score: 93, destinations: ["evil-pay.com"] },
  ]);
  expect(
    await operator().console.safety.releaseWaiting({ teamId, parkedBefore: new Date() }),
  ).toEqual({ released: 1 });
  const cleared = await db
    .select({ domain: schema.teamDestinations.domain })
    .from(schema.teamDestinations)
    .where(eq(schema.teamDestinations.teamId, teamId));
  expect(cleared).toEqual([{ domain: "evil-pay.com" }]);
});

it("releases only what the list showed: named emails, or those parked by the time it was read", async () => {
  const teamId = await createTeam(db, "release-shown");
  const park = async (parkedAt: Date) => {
    const [row] = await db
      .insert(schema.emails)
      .values({
        teamId,
        from: "Team <a@release-shown.dev>",
        to: ["r@example.org"],
        subject: "s",
        latestStatus: "queued_quota",
        parkReason: "screening",
        parkedAt,
      })
      .returning({ id: schema.emails.id });
    return row?.id ?? "";
  };
  const shown = await park(new Date(Date.now() - 60_000));
  const { asOf } = await operator().console.safety.waiting({ teamId });
  const later = await park(new Date(asOf.getTime() + 1_000));
  // "All" with nothing to bound it is refused.
  await expect(operator().console.safety.releaseWaiting({ teamId })).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
  await expect(operator().console.safety.cancelWaiting({ teamId })).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
  expect(await operator().console.safety.releaseWaiting({ teamId, parkedBefore: asOf })).toEqual({
    released: 1,
  });
  const reasons = await db
    .select({ id: schema.emails.id, parkReason: schema.emails.parkReason })
    .from(schema.emails)
    .where(eq(schema.emails.teamId, teamId));
  expect(reasons.find((row) => row.id === shown)?.parkReason).toBeNull();
  expect(reasons.find((row) => row.id === later)?.parkReason).toBe("screening");
});
