import { randomBytes, randomUUID } from "node:crypto";
import {
  type AbuseJudge,
  EnvKeyring,
  encryptEmailBody,
  type JudgeVerdict,
  MONITOR_SETTING_DEFAULTS,
  type MonitorSettings,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { judgeSample } from "../src/handlers/abuse-judge.js";
import { sendEmail } from "../src/handlers/send-email.js";

let db: Db;
let close: () => Promise<void>;
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
const FIRST_SEND = new Date("2026-10-09T12:00:00Z");
const JUDGED = new Date(FIRST_SEND.getTime() + 3 * 60_000);

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

async function email(teamId: string, latestStatus: "sent" | "queued"): Promise<string> {
  const id = randomUUID();
  const body = await encryptEmailBody(
    {
      html: '<p>Your account is locked. <a href="https://secure-login.example">Verify</a></p>',
      text: null,
    },
    keyring,
    { teamId, rowId: id },
  );
  await db.insert(schema.emails).values({
    id,
    teamId,
    from: "Support <no-reply@lure.example>",
    to: ["victim@example.org"],
    subject: "Action required",
    latestStatus,
    bodyCiphertext: body.ciphertext,
    bodyIv: body.iv,
    bodyWrappedDek: body.wrappedDek,
    bodyKeyVersion: body.keyVersion,
  });
  return id;
}

// A new free team's first campaign posed as a brand: the judge scored the
// first sampled message 96 (brand_impersonation) minutes after SES took it,
// and the team went on sending until a person stepped in.
it("holds a new team on its first phishing verdict, and parks what it sends next", async () => {
  await db.insert(schema.user).values([
    { id: "op", name: "Operator", email: "op@example.com", createdAt: new Date(0) },
    { id: "owner", name: "Owner", email: "owner@lure.example", createdAt: FIRST_SEND },
  ]);
  const teamId = await createTeam(db, "lure");
  await db.insert(schema.teamMembers).values({ teamId, userId: "owner", role: "owner" });
  await db.insert(schema.teamMonitor).values({ teamId, sentTotal: 1, firstSendAt: FIRST_SEND });
  const [sample] = await db
    .insert(schema.monitorSamples)
    .values({ teamId, emailId: await email(teamId, "sent"), kind: "first_sends" })
    .returning({ id: schema.monitorSamples.id });

  const judge: AbuseJudge = {
    provider: "typesafe",
    model: "fake-model",
    judge: async () => ({
      score: 96,
      verdict: "abuse",
      categories: ["brand_impersonation"],
      impersonatedBrand: null,
      reasons: ["impersonation", "off_domain_lure"],
      language: "en",
    }),
  };
  const mails: { to: string; kind: string; text: string }[] = [];
  const tenants: string[] = [];
  expect(
    await judgeSample(
      db,
      {
        judge,
        keyring,
        settings: async () => MONITOR_SETTING_DEFAULTS,
        mailer: { send: async (to, m) => void mails.push({ to, kind: m.kind, text: m.text }) },
        appBaseUrl: "https://app.example.test",
        now: () => JUDGED,
        syncTenant: async (id) => void tenants.push(id),
      },
      { sampleId: sample?.id ?? "" },
    ),
  ).toBe("judged");

  const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
  expect(team).toMatchObject({ suspendedAt: JUDGED, suspensionReason: "review" });
  expect(tenants).toEqual([teamId]);
  // The operator hears at once; the owner never does.
  expect(mails).toMatchObject([{ to: "op@example.com", kind: "monitor.team_held" }]);
  expect(mails[0]?.text).toContain(`https://app.example.test/console/safety/${teamId}`);
  expect(mails[0]?.text).toContain("96 (brand_impersonation, impersonation, off_domain_lure)");

  const next = await email(teamId, "queued");
  const ses = {
    sendRaw: async () => {
      throw new Error("a held team's mail reached SES");
    },
  };
  expect(await sendEmail(db, { keyring, ses }, { emailId: next })).toBe("parked");
  const [parked] = await db.select().from(schema.emails).where(eq(schema.emails.id, next));
  expect(parked?.latestStatus).toBe("queued_quota");
});

// The first phishing campaign the monitor judged, verdict by verdict: one
// test message, then the campaign, every message sampled in the first window.
const LURE = ["impersonation", "off_domain_lure"];
const BULK_LURE = [...LURE, "unsolicited_bulk"];
const BRAND = ["brand_impersonation"];
const INCIDENT: Pick<JudgeVerdict, "score" | "verdict" | "categories" | "reasons">[] = [
  { score: 38, verdict: "clean", categories: [], reasons: [] },
  { score: 15, verdict: "clean", categories: [], reasons: [] },
  { score: 13, verdict: "clean", categories: [], reasons: [] },
  { score: 41, verdict: "clean", categories: [], reasons: ["off_domain_lure"] },
  { score: 42, verdict: "clean", categories: [], reasons: ["off_domain_lure"] },
  { score: 96, verdict: "abuse", categories: BRAND, reasons: LURE },
  { score: 95, verdict: "abuse", categories: BRAND, reasons: LURE },
  { score: 83, verdict: "abuse", categories: BRAND, reasons: BULK_LURE },
  { score: 84, verdict: "abuse", categories: BRAND, reasons: BULK_LURE },
  { score: 69, verdict: "abuse", categories: BRAND, reasons: LURE },
  { score: 80, verdict: "abuse", categories: BRAND, reasons: BULK_LURE },
];

it("replays the first phishing campaign: held on its 5th message, or its 10th by the repeat hold alone", async () => {
  /** The campaign message whose verdict held the team; 0 is the test message. */
  async function heldOn(slug: string, settings: MonitorSettings): Promise<number | null> {
    const teamId = await createTeam(db, slug);
    await db
      .update(schema.teams)
      .set({ createdAt: new Date(FIRST_SEND.getTime() - 3600_000) })
      .where(eq(schema.teams.id, teamId));
    await db.insert(schema.teamMonitor).values({ teamId, sentTotal: 1, firstSendAt: FIRST_SEND });
    for (const [i, verdict] of INCIDENT.entries()) {
      const at = new Date(FIRST_SEND.getTime() + i * 60_000);
      const [sample] = await db
        .insert(schema.monitorSamples)
        .values({
          teamId,
          emailId: await email(teamId, "sent"),
          kind: "first_sends",
          createdAt: at,
        })
        .returning({ id: schema.monitorSamples.id });
      const judge: AbuseJudge = {
        provider: "typesafe",
        model: "fake-model",
        judge: async () => ({ ...verdict, impersonatedBrand: null, language: "other" }),
      };
      await judgeSample(
        db,
        { judge, keyring, settings: async () => settings, now: () => at },
        { sampleId: sample?.id ?? "" },
      );
      const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
      if (team?.suspensionReason === "review") return i;
    }
    return null;
  }
  expect(await heldOn("incident", MONITOR_SETTING_DEFAULTS)).toBe(5);
  // A hold score out of the campaign's reach leaves the repeat hold to act.
  expect(await heldOn("incident-repeat", { ...MONITOR_SETTING_DEFAULTS, holdScore: 100 })).toBe(10);
});
