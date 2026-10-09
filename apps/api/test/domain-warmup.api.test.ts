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

const post = (token: string, path: string, payload: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
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

it("answers 429 naming the warm-up, never the plan, once the parked backlog is full", async () => {
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
    const body = (await res.json()) as { name: string; message: string };
    expect(body.name).toBe("daily_quota_exceeded");
    expect(body.message).toBe(
      `${prefix}New domain warm-up: this sending domain ramps up gradually and enough of its emails are already waiting; retry after the UTC day rolls over`,
    );
    expect(body.message).not.toMatch(/upgrade|plan/i);
  }
});
