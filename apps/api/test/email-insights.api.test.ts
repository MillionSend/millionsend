import { randomBytes } from "node:crypto";
import { EnvKeyring, generateApiKey, utcDay } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import type { EmailInsightCheck } from "@millionsend/db/schema";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/app.js";

let db: Db;
let close: () => Promise<void>;
let app: ReturnType<typeof createApi>;
let teamId: string;
let token: string;
let sendOnlyToken: string;
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));

const get = (path: string, tok = token) =>
  app.request(path, { headers: { authorization: `Bearer ${tok}` } });

async function seedEmail(values: Partial<typeof schema.emails.$inferInsert> = {}) {
  const [row] = await db
    .insert(schema.emails)
    .values({
      teamId,
      from: "Acme <a@acme.dev>",
      to: ["r@example.com"],
      subject: "s",
      latestStatus: "sent",
      ...values,
    })
    .returning({ id: schema.emails.id });
  if (!row) throw new Error("email insert returned no row");
  return row.id;
}

const passingChecks: EmailInsightCheck[] = [
  { id: "dmarc_record", severity: "critical", status: "pass", penaltyHundredths: 0 },
];

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "insights-team");
  const key = generateApiKey();
  token = key.token;
  await db.insert(schema.apiKeys).values({
    teamId,
    name: "full",
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
  });
  const sendKey = generateApiKey();
  sendOnlyToken = sendKey.token;
  await db.insert(schema.apiKeys).values({
    teamId,
    name: "send-only",
    tokenPrefix: sendKey.tokenPrefix,
    keyHash: sendKey.keyHash,
    last4: sendKey.last4,
    permission: "sending_access",
  });
  app = createApi({ db, keyring, isCloud: true, enqueueEmailSend: async () => {} });
});
afterAll(() => close());

describe("GET /emails/{id}/insights", () => {
  it("404s an unknown email id", async () => {
    const res = await get("/emails/00000000-0000-4000-8000-000000000000/insights");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ name: "not_found", message: "Email not found" });
  });

  it("404s an email that has no insights row yet", async () => {
    const id = await seedEmail();
    const res = await get(`/emails/${id}/insights`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      name: "not_found",
      message: "Insights are not available for this email yet",
    });
  });

  it("returns the full wire shape for a seeded row", async () => {
    const id = await seedEmail();
    const checks: EmailInsightCheck[] = [
      { id: "dmarc_record", severity: "critical", status: "pass", penaltyHundredths: 0 },
      {
        id: "no_shorteners",
        severity: "major",
        status: "fail",
        penaltyHundredths: 125,
        detail: { shorteners: ["bit.ly"] },
      },
    ];
    await db.insert(schema.emailInsights).values({
      teamId,
      emailId: id,
      marketing: false,
      checks,
      scoreTenths: 87,
      scoreVersion: 1,
      htmlSizeBytes: 2048,
      computedAt: new Date("2026-08-30T12:00:00Z"),
    });
    const res = await get(`/emails/${id}/insights`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      object: "email_insights",
      email_id: id,
      score: 8.7,
      score_version: 1,
      band: "good",
      marketing: false,
      html_size_bytes: 2048,
      computed_at: "2026-08-30T12:00:00.000Z",
      checks: [
        { id: "dmarc_record", severity: "critical", status: "pass", penalty: 0 },
        {
          id: "no_shorteners",
          severity: "major",
          status: "fail",
          penalty: 1.25,
          detail: { shorteners: ["bit.ly"] },
        },
      ],
    });
  });

  it("404s a cross-team email even when it has an insights row", async () => {
    const otherTeam = await createTeam(db, "insights-other");
    const [foreign] = await db
      .insert(schema.emails)
      .values({
        teamId: otherTeam,
        from: "O <o@other.dev>",
        to: ["x@example.com"],
        subject: "s",
        latestStatus: "sent",
      })
      .returning({ id: schema.emails.id });
    if (!foreign) throw new Error("insert failed");
    await db.insert(schema.emailInsights).values({
      teamId: otherTeam,
      emailId: foreign.id,
      marketing: false,
      checks: passingChecks,
      scoreTenths: 100,
      scoreVersion: 1,
    });
    expect((await get(`/emails/${foreign.id}/insights`)).status).toBe(404);
  });

  it("403s a sending_access key", async () => {
    const id = await seedEmail();
    const res = await get(`/emails/${id}/insights`, sendOnlyToken);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ name: "restricted_api_key" });
  });
});

describe("score on GET /emails/{id}", () => {
  it("is null when no insights row exists", async () => {
    const id = await seedEmail();
    const body = (await (await get(`/emails/${id}`)).json()) as { score: number | null };
    expect(body.score).toBeNull();
  });

  it("comes from the email-keyed row", async () => {
    const id = await seedEmail();
    await db.insert(schema.emailInsights).values({
      teamId,
      emailId: id,
      marketing: false,
      checks: passingChecks,
      scoreTenths: 87,
      scoreVersion: 1,
    });
    const body = (await (await get(`/emails/${id}`)).json()) as { score: number | null };
    expect(body.score).toBe(8.7);
  });

  it("resolves through the broadcast-keyed shared row", async () => {
    const [broadcast] = await db
      .insert(schema.broadcasts)
      .values({ teamId, from: "Acme <a@acme.dev>", subject: "b", status: "sent" })
      .returning({ id: schema.broadcasts.id });
    if (!broadcast) throw new Error("broadcast insert failed");
    const emailId = await seedEmail({ broadcastId: broadcast.id });
    await db.insert(schema.emailInsights).values({
      teamId,
      broadcastId: broadcast.id,
      marketing: true,
      checks: passingChecks,
      scoreTenths: 63,
      scoreVersion: 1,
    });
    const body = (await (await get(`/emails/${emailId}`)).json()) as { score: number | null };
    expect(body.score).toBe(6.3);

    // The insights endpoint resolves through the same shared row.
    const insights = (await (await get(`/emails/${emailId}/insights`)).json()) as {
      email_id: string;
      score: number;
      marketing: boolean;
    };
    expect(insights).toMatchObject({ email_id: emailId, score: 6.3, marketing: true });
  });
});

describe("GET /deliverability", () => {
  it("returns the wire shape for a seeded counters window", async () => {
    // Yesterday's counters (inside both the 30-day score window and the 7-day
    // guardrail window). 200 sends clears the 100-send outcome floor.
    await db.insert(schema.usageCounters).values({
      teamId,
      day: utcDay(Date.now() - 24 * 3_600_000),
      accepted: 200,
      sent: 200,
      bounced: 0,
      hardBounced: 0,
      complained: 0,
    });
    // One scored + sent email feeds the content sub-score (1 recipient x 80).
    const scoredId = await seedEmail({ to: ["scored@example.com"], sentAt: new Date() });
    await db.insert(schema.emailInsights).values({
      teamId,
      emailId: scoredId,
      marketing: false,
      checks: passingChecks,
      scoreTenths: 80,
      scoreVersion: 1,
    });

    const res = await get("/deliverability");
    expect(res.status).toBe(200);
    // Outcome 10.0 (clean rates), content 8.0 -> headline round(0.4*80 + 0.6*100) = 92.
    expect(await res.json()).toEqual({
      object: "deliverability",
      score: 9.2,
      band: "excellent",
      content_score: 8,
      outcome_score: 10,
      complaint_rate: 0,
      hard_bounce_rate: 0,
      emails_sent: 200,
      scored_recipients: 1,
      window_days: 30,
      insufficient_outcome_data: false,
      guardrail_status: "ok",
      score_version: 1,
    });
  });

  it("403s a sending_access key", async () => {
    const res = await get("/deliverability", sendOnlyToken);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ name: "restricted_api_key" });
  });

  it("401s without a key", async () => {
    expect((await app.request("/deliverability")).status).toBe(401);
  });
});
