import { randomBytes } from "node:crypto";
import { EnvKeyring, generateApiKey, utcDay } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createApi } from "../src/app.js";

let db: Db;
let close: () => Promise<void>;
let app: ReturnType<typeof createApi>;

// One instant for the whole test: the warm-up counts per UTC day, and a
// rollover between seeding a counter and sending would read a fresh day.
const NOW = new Date("2026-10-09T10:00:00Z");

/** A team sending from a domain registered an hour ago, with today's warm-up already at `used`. */
async function youngSender(
  slug: string,
  plan: Partial<typeof schema.teams.$inferInsert>,
  used: number,
): Promise<{ teamId: string; domainId: string; token: string }> {
  const teamId = await createTeam(db, slug);
  await db.update(schema.teams).set(plan).where(eq(schema.teams.id, teamId));
  const [domain] = await db
    .insert(schema.domains)
    .values({
      teamId,
      name: `mail.${slug}.com`,
      region: "us-east-1",
      status: "verified",
      verifiedAt: NOW,
      registeredAt: new Date(NOW.getTime() - 3600_000),
      ageSource: "rdap",
    })
    .returning({ id: schema.domains.id });
  if (!domain) throw new Error("domain insert failed");
  await db
    .insert(schema.domainWarmupUsage)
    .values({ registrableDomain: `${slug}.com`, day: utcDay(NOW), accepted: used });
  const key = generateApiKey();
  await db.insert(schema.apiKeys).values({
    teamId,
    name: "t",
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
  });
  return { teamId, domainId: domain.id, token: key.token };
}

const post = (
  token: string,
  path: string,
  payload: unknown,
  headers: Record<string, string> = {},
  via: ReturnType<typeof createApi> = app,
) =>
  via.request(path, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });

const get = async (token: string, path: string, via: ReturnType<typeof createApi> = app) =>
  (await via.request(path, { headers: { authorization: `Bearer ${token}` } })).json();

/** The reset after NOW, as the API writes it. */
const MIDNIGHT = "2026-10-10T00:00:00.000Z";

/** The warning a send held by the limit of `slug`'s domain carries. */
const heldWarning = (slug: string) => ({
  code: "new_domain_limit",
  message: `mail.${slug}.com sent its 100 emails for today. This email goes out after 00:00 UTC.`,
  sends_after: MIDNIGHT,
});

const email = (slug: string, to: string) => ({
  from: `Acme <hello@mail.${slug}.com>`,
  to: [to],
  subject: "s",
  text: "t",
});

const rowsOf = async (ids: string[]) => {
  const rows = await db
    .select({
      id: schema.emails.id,
      status: schema.emails.latestStatus,
      reason: schema.emails.parkReason,
    })
    .from(schema.emails)
    .where(inArray(schema.emails.id, ids));
  return ids.map((id) => rows.find((r) => r.id === id));
};

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await db.insert(schema.instanceSettings).values({ id: 1, warmupEnabled: true });
  app = createApi({
    db,
    keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
    isCloud: true,
    enqueueEmailSend: async () => {},
    enqueueBroadcastSend: async () => {},
    appBaseUrl: "https://app.example.test",
  });
});
afterAll(() => close());
beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

it("a batch from a young domain sends what fits its warm-up and parks the rest, on a paid plan too", async () => {
  const { token } = await youngSender("batch-warmup", { plan: "pro", planQuota: 100_000 }, 98);
  const res = await post(
    token,
    "/emails/batch",
    [1, 2, 3].map((i) => email("batch-warmup", `r${i}@example.com`)),
  );
  expect(res.status).toBe(200);
  const { data } = (await res.json()) as { data: { id: string }[] };
  expect(await rowsOf(data.map((d) => d.id))).toMatchObject([
    { status: "queued", reason: null },
    { status: "queued", reason: null },
    { status: "queued_quota", reason: "warmup" },
  ]);
});

it("a batch from two young domains of one team shares one day's warm-up between them", async () => {
  const { teamId, token } = await youngSender("pool-batch", { plan: "pro", planQuota: 100_000 }, 0);
  await db.insert(schema.domains).values({
    teamId,
    name: "mail.pool-batch-two.com",
    region: "us-east-1",
    status: "verified",
    verifiedAt: NOW,
    registeredAt: new Date(NOW.getTime() - 3600_000),
    ageSource: "rdap",
  });
  const fifty = (prefix: string) =>
    Array.from({ length: 50 }, (_, i) => `${prefix}${i}@example.com`);
  const res = await post(token, "/emails/batch", [
    { ...email("pool-batch", ""), to: fifty("a") },
    { ...email("pool-batch-two", ""), to: fifty("b") },
    email("pool-batch-two", "c@example.com"),
  ]);
  expect(res.status).toBe(200);
  const { data } = (await res.json()) as { data: { id: string }[] };
  expect(await rowsOf(data.map((d) => d.id))).toMatchObject([
    { status: "queued", reason: null },
    { status: "queued", reason: null },
    { status: "queued_quota", reason: "warmup" },
  ]);
});

it("a single send over the warm-up is accepted and waits", async () => {
  const { token } = await youngSender("single-warmup", { plan: "pro", planQuota: 100_000 }, 100);
  const res = await post(token, "/emails", email("single-warmup", "r@example.com"));
  expect(res.status).toBe(200);
  const { id } = (await res.json()) as { id: string };
  const [row] = await db
    .select({ status: schema.emails.latestStatus, reason: schema.emails.parkReason })
    .from(schema.emails)
    .where(eq(schema.emails.id, id));
  expect(row).toEqual({ status: "queued_quota", reason: "warmup" });
});

it("a send scheduled in the past counts against today's warm-up, single or batch", async () => {
  const { token } = await youngSender("backdated-warmup", { plan: "pro", planQuota: 100_000 }, 100);
  const past = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
  const single = await post(token, "/emails", {
    ...email("backdated-warmup", "r@example.com"),
    scheduled_at: past(2),
  });
  expect(single.status).toBe(200);
  const batch = await post(
    token,
    "/emails/batch",
    [3, 4].map((days) => ({
      ...email("backdated-warmup", `r${days}@example.com`),
      scheduled_at: past(days),
    })),
  );
  expect(batch.status).toBe(200);
  const { id } = (await single.json()) as { id: string };
  const { data } = (await batch.json()) as { data: { id: string }[] };
  const held = { status: "queued_quota", reason: "warmup" };
  expect(await rowsOf([id, ...data.map((d) => d.id)])).toMatchObject([held, held, held]);
});

it("answers 429 naming the limit, never the plan, with Retry-After, once the parked backlog is full", async () => {
  const { teamId, domainId, token } = await youngSender("full-warmup", { plan: "free" }, 100);
  // Free's backlog: three days of its 100 a day.
  await db.insert(schema.emails).values(
    Array.from({ length: 300 }, () => ({
      teamId,
      domainId,
      from: "hello@mail.full-warmup.com",
      to: ["r@example.com"],
      subject: "s",
      latestStatus: "queued_quota" as const,
      parkReason: "warmup" as const,
    })),
  );
  for (const [path, payload, prefix] of [
    ["/emails", email("full-warmup", "r@example.com"), ""],
    ["/emails/batch", [email("full-warmup", "r@example.com")], "emails.0: "],
  ] as const) {
    const res = await post(token, path, payload);
    expect(res.status).toBe(429);
    // 10:00 UTC: fourteen hours to the reset.
    expect(res.headers.get("retry-after")).toBe(String(14 * 3600));
    const body = (await res.json()) as { name: string; message: string };
    expect(body.name).toBe("daily_quota_exceeded");
    expect(body.message).toBe(
      `${prefix}mail.full-warmup.com sends up to 100 emails a day for now, and 300 are already waiting. Retry after 00:00 UTC.`,
    );
    expect(body.message).not.toMatch(/upgrade|plan|warm-up|tier/i);
  }
});

it("a send the limit holds answers with a warning, on a replay too, and reads back why and until when", async () => {
  const { token } = await youngSender("warn-single", { plan: "pro", planQuota: 100_000 }, 100);
  const headers = { "idempotency-key": "warn-once" };
  const res = await post(token, "/emails", email("warn-single", "r@example.com"), headers);
  expect(res.status).toBe(200);
  const first = (await res.json()) as { id: string };
  const { id } = first;
  const answer = { id, warning: heldWarning("warn-single") };
  expect(first).toEqual(answer);
  expect(
    await (await post(token, "/emails", email("warn-single", "r@example.com"), headers)).json(),
  ).toEqual(answer);
  const waiting = {
    last_event: "queued",
    queued_reason: "new_domain_limit",
    sends_after: MIDNIGHT,
  };
  expect(await get(token, `/emails/${id}`)).toMatchObject(waiting);
  const list = (await get(token, "/emails")) as { data: { id: string }[] };
  expect(list.data.find((e) => e.id === id)).toMatchObject(waiting);
});

it("a batch warns on the items the limit holds and no other", async () => {
  const { token } = await youngSender("warn-batch", { plan: "pro", planQuota: 100_000 }, 99);
  const res = await post(
    token,
    "/emails/batch",
    [1, 2].map((i) => email("warn-batch", `r${i}@example.com`)),
  );
  expect(res.status).toBe(200);
  const { data } = (await res.json()) as { data: { id: string }[] };
  expect(data).toEqual([
    { id: data[0]?.id },
    { id: data[1]?.id, warning: heldWarning("warn-batch") },
  ]);
});

it("names the shared volume when the team's new domains used it up between them", async () => {
  const { teamId, token } = await youngSender("warn-pool", { plan: "pro", planQuota: 100_000 }, 0);
  await db.insert(schema.domains).values({
    teamId,
    name: "mail.warn-pool-two.com",
    region: "us-east-1",
    status: "verified",
    verifiedAt: NOW,
    registeredAt: new Date(NOW.getTime() - 3600_000),
    ageSource: "rdap",
  });
  await db.insert(schema.teamWarmupUsage).values({ teamId, day: utcDay(NOW), accepted: 100 });
  const res = await post(token, "/emails", email("warn-pool", "r@example.com"));
  expect(((await res.json()) as { warning?: unknown }).warning).toEqual({
    code: "new_domain_limit",
    message:
      "Your new domains sent their 100 emails for today. This email goes out after 00:00 UTC.",
    sends_after: MIDNIGHT,
  });
});

it("a review hold of a young domain's team reads as a plain accept and a capacity wait", async () => {
  const { teamId, token } = await youngSender(
    "warn-review",
    { plan: "pro", planQuota: 100_000 },
    100,
  );
  await db
    .update(schema.teams)
    .set({ suspendedAt: NOW, suspensionReason: "review" })
    .where(eq(schema.teams.id, teamId));
  const single = await post(token, "/emails", email("warn-review", "r@example.com"));
  const sent = (await single.json()) as { id: string };
  // A plain accept, nothing more.
  expect(Object.keys(sent)).toEqual(["id"]);
  const { id } = sent;
  const batch = await post(token, "/emails/batch", [email("warn-review", "b@example.com")]);
  const { data } = (await batch.json()) as { data: { id: string }[] };
  expect(data).toEqual([{ id: data[0]?.id }]);
  expect(await rowsOf([id])).toMatchObject([{ status: "queued_quota", reason: "review" }]);
  for (const emailId of [id, data[0]?.id]) {
    expect(await get(token, `/emails/${emailId}`)).toMatchObject({
      last_event: "queued",
      queued_reason: "capacity",
      sends_after: null,
    });
  }
});

it("reads every other wait back by its own reason: the plan's day and month, the warm-up, capacity", async () => {
  const daily = await youngSender("wait-daily", { plan: "free" }, 0);
  await db
    .update(schema.domains)
    .set({ registeredAt: new Date("2014-03-01T00:00:00Z") })
    .where(eq(schema.domains.id, daily.domainId));
  await db
    .insert(schema.usageCounters)
    .values({ teamId: daily.teamId, day: utcDay(NOW), accepted: 1_000 });
  const res = await post(daily.token, "/emails", email("wait-daily", "r@example.com"));
  expect(res.status).toBe(200);
  const planned = (await res.json()) as { id: string };
  expect(Object.keys(planned)).toEqual(["id"]);
  expect(await get(daily.token, `/emails/${planned.id}`)).toMatchObject({
    queued_reason: "daily_quota",
    sends_after: MIDNIGHT,
  });

  const monthly = await youngSender("wait-monthly", { plan: "pro", planQuota: 100_000 }, 0);
  const start = new Date(NOW.getTime() - 5 * 86_400_000);
  const end = new Date(start.getTime() + 30 * 86_400_000);
  await db
    .update(schema.teams)
    .set({ currentPeriodStart: start, currentPeriodEnd: end, overageEnabled: false })
    .where(eq(schema.teams.id, monthly.teamId));
  await db
    .insert(schema.usagePeriods)
    .values({ teamId: monthly.teamId, periodStart: start, accepted: 100_000 });
  const [broadcast] = await db
    .insert(schema.broadcasts)
    .values({
      teamId: monthly.teamId,
      from: "hi@mail.wait-monthly.com",
      subject: "s",
      status: "sending",
    })
    .returning({ id: schema.broadcasts.id });
  await db.insert(schema.domainWarmups).values({
    domainId: monthly.domainId,
    teamId: monthly.teamId,
    volume: 1500,
    startVolume: 1500,
    dailyTarget: 10_000,
  });
  const parked = async (over: Partial<typeof schema.emails.$inferInsert>) => {
    const [row] = await db
      .insert(schema.emails)
      .values({
        teamId: monthly.teamId,
        domainId: monthly.domainId,
        from: "hi@mail.wait-monthly.com",
        to: ["r@example.com"],
        subject: "s",
        latestStatus: "queued_quota",
        ...over,
      })
      .returning({ id: schema.emails.id });
    return row?.id ?? "";
  };
  const expected = [
    [await parked({ parkReason: null }), "monthly_quota", end.toISOString()],
    [
      await parked({ parkReason: "warmup", broadcastId: broadcast?.id ?? null }),
      "warming_up",
      null,
    ],
    // A silent hold reads exactly as a capacity wait does, the plan's cap included.
    [await parked({ parkReason: "screening" }), "monthly_quota", end.toISOString()],
    [await parked({ parkReason: "destination" }), "monthly_quota", end.toISOString()],
    [await parked({ latestStatus: "delivered", sentAt: NOW }), null, null],
  ] as const;
  const list = (await get(monthly.token, "/emails")) as {
    data: { id: string; queued_reason: string | null; sends_after: string | null }[];
  };
  for (const [id, reason, at] of expected) {
    expect(await get(monthly.token, `/emails/${id}`)).toMatchObject({
      queued_reason: reason,
      sends_after: at,
    });
    expect(list.data.find((e) => e.id === id)).toMatchObject({
      queued_reason: reason,
      sends_after: at,
    });
  }
});

it("plans a broadcast from a young domain under its limit: the warning names it and the finish moves to the next day", async () => {
  const paced = createApi({
    db,
    keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
    isCloud: true,
    enqueueEmailSend: async () => {},
    enqueueBroadcastSend: async () => {},
    appBaseUrl: "https://app.example.test",
    pacing: {
      regionAccount: async () => ({ max24h: 100_000, sentLast24h: 0, maxSendRate: 14 }),
      reservePercent: async () => 30,
      rateCeiling: async () => 14,
      horizonDays: async () => 24,
    },
  });
  const { teamId, token } = await youngSender("bc-limit", { plan: "pro", planQuota: 100_000 }, 98);
  await db
    .insert(schema.contacts)
    .values([1, 2, 3, 4, 5].map((i) => ({ teamId, email: `c${i}@example.com` })));
  const [broadcast] = await db
    .insert(schema.broadcasts)
    .values({ teamId, from: "Acme <hi@mail.bc-limit.com>", subject: "s", html: "<p>hi</p>" })
    .returning({ id: schema.broadcasts.id });
  const res = await post(token, `/broadcasts/${broadcast?.id}/send`, {}, {}, paced);
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    finishes_at: string | null;
    warning?: { code: string; days: number; message: string };
  };
  // Two of today's hundred are left; the other three go after midnight.
  expect(body.warning).toEqual({
    code: "new_domain_limit",
    days: 1,
    message:
      "mail.bc-limit.com sends up to 100 emails a day for now, so this broadcast goes out over about 1 day.",
  });
  const finish = new Date(body.finishes_at ?? 0).getTime();
  expect(finish).toBeGreaterThan(Date.parse(MIDNIGHT));
  expect(finish).toBeLessThan(Date.parse(MIDNIGHT) + 3600_000);
});
