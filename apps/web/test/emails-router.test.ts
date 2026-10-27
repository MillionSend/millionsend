import { randomBytes, randomUUID } from "node:crypto";
import {
  EnvKeyring,
  encryptEmailBody,
  hashRecipient,
  nextUtcDayStart,
  utcDay,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCaller } from "@/server/routers";
import type { Context } from "@/server/trpc";

// The router builds its keyring lazily from the validated env
// (SKIP_ENV_VALIDATION leaves env reads live), so setting the key here —
// before any procedure runs — is what production boot does via config.
const TEST_KEK = randomBytes(32).toString("base64");
process.env.MASTER_ENCRYPTION_KEY = TEST_KEK;

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await close();
});

function caller(teamId: string, role: Context["role"] = "owner") {
  const ctx: Context = {
    db,
    session: { user: { id: "u1", email: "u1@example.com", name: "u1" } },
    teamId,
    role,
  };
  return createCaller(ctx);
}

function baseEmail(teamId: string) {
  return {
    teamId,
    from: "sender@acme.test",
    to: ["ada@example.com"],
    subject: "hello",
  };
}

async function insertEmail(values: typeof schema.emails.$inferInsert): Promise<string> {
  const [row] = await db.insert(schema.emails).values(values).returning({ id: schema.emails.id });
  if (!row) throw new Error("email insert failed");
  return row.id;
}

describe("emails.list", () => {
  it("scopes rows to the caller's team", async () => {
    const teamA = await createTeam(db, "team-a");
    const teamB = await createTeam(db, "team-b");
    const a1 = await insertEmail({
      ...baseEmail(teamA),
      createdAt: new Date("2026-08-01T10:00:00Z"),
    });
    const a2 = await insertEmail({
      ...baseEmail(teamA),
      createdAt: new Date("2026-08-02T10:00:00Z"),
    });
    const b1 = await insertEmail({
      ...baseEmail(teamB),
      createdAt: new Date("2026-08-03T10:00:00Z"),
    });

    const resA = await caller(teamA).emails.list({});
    expect(resA.items.map((r) => r.id)).toEqual([a2, a1]);

    const resB = await caller(teamB).emails.list({});
    expect(resB.items.map((r) => r.id)).toEqual([b1]);
  });

  it("filters by status", async () => {
    const teamA = await createTeam(db, "team-a");
    const delivered = await insertEmail({ ...baseEmail(teamA), latestStatus: "delivered" });
    await insertEmail({ ...baseEmail(teamA), latestStatus: "bounced" });

    const res = await caller(teamA).emails.list({ status: "delivered" });
    expect(res.items.map((r) => r.id)).toEqual([delivered]);
  });

  it("searches by subject and recipient", async () => {
    const teamA = await createTeam(db, "team-a");
    const bySubject = await insertEmail({ ...baseEmail(teamA), subject: "Invoice 42" });
    const byRecipient = await insertEmail({
      ...baseEmail(teamA),
      to: ["grace@example.com"],
      subject: "unrelated",
    });
    await insertEmail({ ...baseEmail(teamA), subject: "other" });

    const subjectHits = await caller(teamA).emails.list({ search: "invoice" });
    expect(subjectHits.items.map((r) => r.id)).toEqual([bySubject]);

    const recipientHits = await caller(teamA).emails.list({ search: "grace@" });
    expect(recipientHits.items.map((r) => r.id)).toEqual([byRecipient]);
  });

  it("pages with a keyset cursor without overlap", async () => {
    const teamA = await createTeam(db, "team-a");
    const ids = [];
    for (let i = 0; i < 3; i++) {
      ids.push(
        await insertEmail({
          ...baseEmail(teamA),
          subject: `email ${i}`,
          createdAt: new Date(Date.UTC(2026, 7, 1 + i)),
        }),
      );
    }

    const page1 = await caller(teamA).emails.list({ limit: 2 });
    expect(page1.items.map((r) => r.id)).toEqual([ids[2], ids[1]]);
    expect(page1.nextCursor).not.toBeNull();

    if (!page1.nextCursor) throw new Error("expected a next cursor");
    const page2 = await caller(teamA).emails.list({ limit: 2, cursor: page1.nextCursor });
    expect(page2.items.map((r) => r.id)).toEqual([ids[0]]);
    expect(page2.nextCursor).toBeNull();
  });

  it("filters by apiKeyId and since, and reports the filter-scope total", async () => {
    const teamA = await createTeam(db, "team-a");
    const keyId = "5c1f7f60-8f4f-4f7e-9a6c-1d2e3f405060";
    const withKey = await insertEmail({
      ...baseEmail(teamA),
      apiKeyId: keyId,
      createdAt: new Date("2026-08-10T10:00:00Z"),
    });
    await insertEmail({ ...baseEmail(teamA), createdAt: new Date("2026-08-01T10:00:00Z") });

    const byKey = await caller(teamA).emails.list({ apiKeyId: keyId });
    expect(byKey.items.map((r) => r.id)).toEqual([withKey]);
    expect(byKey.total).toBe(1);

    const recent = await caller(teamA).emails.list({ since: new Date("2026-08-05T00:00:00Z") });
    expect(recent.items.map((r) => r.id)).toEqual([withKey]);
    expect(recent.total).toBe(1);

    const all = await caller(teamA).emails.list({ limit: 1 });
    expect(all.total).toBe(2);
    expect(all.items).toHaveLength(1);
  });

  it("returns oldest-first with order asc, team-scoped, paging forward", async () => {
    const teamA = await createTeam(db, "team-a");
    const teamB = await createTeam(db, "team-b");
    const ids = [];
    for (let i = 0; i < 3; i++) {
      ids.push(
        await insertEmail({
          ...baseEmail(teamA),
          subject: `email ${i}`,
          createdAt: new Date(Date.UTC(2026, 7, 1 + i)),
        }),
      );
    }
    await insertEmail({ ...baseEmail(teamB), createdAt: new Date(Date.UTC(2026, 6, 1)) });

    const page1 = await caller(teamA).emails.list({ limit: 1, order: "asc" });
    expect(page1.items.map((r) => r.id)).toEqual([ids[0]]);
    expect(page1.total).toBe(3);
    if (!page1.nextCursor) throw new Error("expected a next cursor");

    const page2 = await caller(teamA).emails.list({
      limit: 2,
      order: "asc",
      cursor: page1.nextCursor,
    });
    expect(page2.items.map((r) => r.id)).toEqual([ids[1], ids[2]]);
    expect(page2.nextCursor).toBeNull();
    // Only the first page pays for the count; the client keeps pages[0].total.
    expect(page2.total).toBeNull();
  });

  it("does not skip same-millisecond rows differing only in microseconds", async () => {
    const teamA = await createTeam(db, "team-a");
    // timestamptz keeps microseconds; a JS Date cannot represent these two
    // values distinctly, so they pin the full-precision cursor round-trip.
    const newer = await insertEmail({
      ...baseEmail(teamA),
      subject: "newer",
      createdAt: sql`timestamptz '2026-08-01 10:00:00.123456+00'` as unknown as Date,
    });
    const older = await insertEmail({
      ...baseEmail(teamA),
      subject: "older",
      createdAt: sql`timestamptz '2026-08-01 10:00:00.123400+00'` as unknown as Date,
    });

    const page1 = await caller(teamA).emails.list({ limit: 1 });
    expect(page1.items.map((r) => r.id)).toEqual([newer]);
    if (!page1.nextCursor) throw new Error("expected a next cursor");

    const page2 = await caller(teamA).emails.list({ limit: 1, cursor: page1.nextCursor });
    expect(page2.items.map((r) => r.id)).toEqual([older]);
  });
});

/** A verified domain registered 3 days ago that sent its 300 emails today: under the new domain limit. */
async function limitedDomain(teamId: string, name: string): Promise<string> {
  await db
    .insert(schema.instanceSettings)
    .values({ id: 1, warmupEnabled: true })
    .onConflictDoNothing();
  const [row] = await db
    .insert(schema.domains)
    .values({
      teamId,
      name,
      region: "us-east-1",
      status: "verified",
      registeredAt: new Date(Date.now() - 3 * 86_400_000),
      ageSource: "rdap",
    })
    .returning({ id: schema.domains.id });
  if (!row) throw new Error("domain insert failed");
  await db
    .insert(schema.domainWarmupUsage)
    .values({ registrableDomain: name, day: utcDay(), accepted: 300 })
    .onConflictDoNothing();
  return row.id;
}

describe("emails.list sources", () => {
  async function broadcastFor(teamId: string): Promise<string> {
    const [b] = await db
      .insert(schema.broadcasts)
      .values({ teamId, from: "sender@acme.test", subject: "news", status: "sending" })
      .returning({ id: schema.broadcasts.id });
    if (!b) throw new Error("broadcast insert failed");
    return b.id;
  }

  it("splits transactional sends from broadcast copies and counts both on the first page", async () => {
    const team = await createTeam(db, "team-a");
    const broadcastId = await broadcastFor(team);
    const tx = await insertEmail({ ...baseEmail(team), latestStatus: "delivered" });
    const bulk = await insertEmail({
      ...baseEmail(team),
      broadcastId,
      latestStatus: "queued_quota",
    });
    await insertEmail({ ...baseEmail(team), broadcastId, to: ["bo@example.com"] });

    const transactional = await caller(team).emails.list({ source: "transactional" });
    expect(transactional.items.map((r) => r.id)).toEqual([tx]);
    expect(transactional.total).toBe(1);
    expect(await caller(team).emails.sourceTotals({})).toEqual({ transactional: 1, broadcast: 2 });

    const broadcasts = await caller(team).emails.list({ source: "broadcast", search: "ada" });
    expect(broadcasts.items.map((r) => [r.id, r.broadcastId])).toEqual([[bulk, broadcastId]]);
    expect(broadcasts.total).toBe(1);
    expect(await caller(team).emails.sourceTotals({ search: "ada" })).toEqual({
      transactional: 1,
      broadcast: 1,
    });

    expect((await caller(team).emails.list({})).total).toBe(3);
  });

  it("leaves a broadcast's parked rows out of the cap banner's backlog", async () => {
    const team = await createTeam(db, "team-a");
    const broadcastId = await broadcastFor(team);
    await insertEmail({ ...baseEmail(team), latestStatus: "queued_quota" });
    await insertEmail({ ...baseEmail(team), broadcastId, latestStatus: "queued_quota" });
    const stats = await caller(team).emails.stats();
    expect(stats.queuedQuota).toBe(1);
    expect(stats.hasBroadcasts).toBe(true);
  });

  it("shows a row the new domain limit holds as waiting for it, apart from the plan's backlog", async () => {
    const team = await createTeam(db, "team-a");
    const domainId = await limitedDomain(team, "nova.example");
    // The plan is spent today: a warm-up row still never reads as held by it.
    await db.insert(schema.usageCounters).values({ teamId: team, day: utcDay(), accepted: 500 });
    const parked = {
      ...baseEmail(team),
      latestStatus: "queued_quota",
      parkReason: "warmup",
      domainId,
    } as const;
    const first = await insertEmail({ ...parked, createdAt: new Date(Date.now() - 60_000) });
    const second = await insertEmail(parked);
    await insertEmail({ ...baseEmail(team), latestStatus: "queued_quota" });
    const reset = nextUtcDayStart(new Date());
    const got = await caller(team).emails.get({ id: second });
    expect(got.pending).toEqual({
      kind: "newDomainLimit",
      domainId,
      domain: "nova.example",
      cap: 300,
      used: 300,
      pool: null,
      ahead: 1,
      sendsAfter: reset,
      resetsAt: reset,
    });
    expect(got.sendingDomain).toEqual({ id: domainId, name: "nova.example", cap: 300 });
    expect((await caller(team).emails.get({ id: first })).pending).toMatchObject({ ahead: 0 });
    expect((await caller(team).emails.stats()).queuedQuota).toBe(1);

    // Once the domain is out from under the limit, its held mail is a plain wait.
    await db
      .update(schema.domains)
      .set({ warmupTrustedAt: new Date() })
      .where(eq(schema.domains.id, domainId));
    const trusted = await caller(team).emails.get({ id: second });
    expect(trusted.pending).toEqual({ kind: "waiting" });
    expect(trusted.sendingDomain).toEqual({ id: domainId, name: "nova.example", cap: null });
  });

  it("tells a broadcast copy waiting on its domain's warm-up from one under the new domain limit", async () => {
    const team = await createTeam(db, "team-a");
    const broadcastId = await broadcastFor(team);
    const domain = { id: await limitedDomain(team, "acme.test") };
    const parked = {
      latestStatus: "queued_quota",
      parkReason: "warmup",
      domainId: domain.id,
    } as const;
    const copy = await insertEmail({ ...baseEmail(team), ...parked, broadcastId });
    // Transactional mail never waits on the warm-up, only on the age-based limit.
    const tx = await insertEmail({ ...baseEmail(team), ...parked });
    const pending = async (id: string) => (await caller(team).emails.get({ id })).pending?.kind;

    expect(await pending(copy)).toBe("newDomainLimit");
    await db.insert(schema.domainWarmups).values({
      domainId: domain.id,
      teamId: team,
      volume: 1_500,
      startVolume: 1_500,
      dailyTarget: 10_000,
    });
    expect(await pending(copy)).toBe("warmup");
    expect(await pending(tx)).toBe("newDomainLimit");
    await db.update(schema.domainWarmups).set({ status: "paused" });
    expect(await pending(copy)).toBe("warmupPaused");
    await db.update(schema.domainWarmups).set({ status: "off" });
    expect(await pending(copy)).toBe("newDomainLimit");

    // Another team's warm-up row for the same id never answers for this one.
    const other = await createTeam(db, "team-b");
    await db.update(schema.domainWarmups).set({ status: "warming", teamId: other });
    expect(await pending(copy)).not.toBe("warmup");
  });

  it("says on each row what it waits for, and never a silent hold's reason", async () => {
    const team = await createTeam(db, "team-a");
    const broadcastId = await broadcastFor(team);
    const young = await limitedDomain(team, "nova.example");
    const ramped = await limitedDomain(team, "news.example");
    await db.insert(schema.domainWarmups).values({
      domainId: ramped,
      teamId: team,
      volume: 1_500,
      startVolume: 1_500,
      dailyTarget: 10_000,
    });
    const parked = (over: Partial<typeof schema.emails.$inferInsert>) =>
      insertEmail({ ...baseEmail(team), latestStatus: "queued_quota", ...over });
    const ids = {
      limit: await parked({ parkReason: "warmup", domainId: young }),
      limitCopy: await parked({ parkReason: "warmup", domainId: young, broadcastId }),
      warmup: await parked({ parkReason: "warmup", domainId: ramped, broadcastId }),
      capacity: await parked({ domainId: young }),
      review: await parked({ parkReason: "review", domainId: young }),
      screening: await parked({ parkReason: "screening", domainId: young }),
      destination: await parked({ parkReason: "destination", domainId: young }),
      media: await parked({ parkReason: "media", domainId: young }),
      recipient: await parked({ parkReason: "recipient", domainId: young }),
      sent: await insertEmail({ ...baseEmail(team), latestStatus: "delivered", domainId: young }),
    };
    const rows = new Map(
      (await caller(team).emails.list({ limit: 50 })).items.map((row) => [row.id, row]),
    );
    const of = (id: string) => [rows.get(id)?.waitingFor, rows.get(id)?.domainId];
    expect(of(ids.limit)).toEqual(["domain_limit", young]);
    expect(of(ids.limitCopy)).toEqual(["domain_limit", young]);
    expect(of(ids.warmup)).toEqual(["warmup", ramped]);
    for (const id of [
      ids.capacity,
      ids.review,
      ids.screening,
      ids.destination,
      ids.media,
      ids.recipient,
      ids.sent,
    ]) {
      expect(rows.get(id)).toMatchObject({ waitingFor: null, resumesAt: null, sendsAfter: null });
    }
    // A paused warm-up's copy says so, and the limit's rows keep their own reason.
    await db.update(schema.domainWarmups).set({ status: "paused" });
    const paused = new Map(
      (await caller(team).emails.list({ limit: 50 })).items.map((row) => [row.id, row]),
    );
    expect(paused.get(ids.warmup)?.waitingFor).toBe("warmup_paused");
    expect(paused.get(ids.limit)?.waitingFor).toBe("domain_limit");
  });

  it("puts each row the limit holds at its own place in line, as the email page does", async () => {
    const team = await createTeam(db, "team-a");
    const young = await limitedDomain(team, "nova.example");
    const to = (n: number, tag: string) =>
      Array.from({ length: n }, (_, i) => `${tag}${i}@example.com`);
    const held = { latestStatus: "queued_quota", parkReason: "warmup", domainId: young } as const;
    const first = await insertEmail({
      ...baseEmail(team),
      ...held,
      to: to(250, "a"),
      createdAt: new Date(Date.now() - 60_000),
    });
    // 250 + 100 is past the next reset's 300: the second goes the day after.
    const second = await insertEmail({ ...baseEmail(team), ...held, to: to(100, "b") });
    const rows = new Map(
      (await caller(team).emails.list({})).items.map((row) => [row.id, row.sendsAfter]),
    );
    const reset = nextUtcDayStart(new Date());
    const dayAfter = new Date(reset.getTime() + 86_400_000);
    expect(rows.get(first)).toEqual(reset);
    expect(rows.get(second)).toEqual(dayAfter);
    expect((await caller(team).emails.get({ id: second })).pending).toMatchObject({
      kind: "newDomainLimit",
      ahead: 1,
      sendsAfter: dayAfter,
    });
  });

  it("names the plan's limit on a row it holds once it binds, with when it renews", async () => {
    vi.stubEnv("IS_CLOUD", "true");
    const team = await createTeam(db, "team-a");
    const capacity = await insertEmail({ ...baseEmail(team), latestStatus: "queued_quota" });
    const review = await insertEmail({
      ...baseEmail(team),
      latestStatus: "queued_quota",
      parkReason: "review",
    });
    const waitingFor = async () =>
      Object.fromEntries(
        (await caller(team).emails.list({})).items.map((row) => [
          row.id,
          [row.waitingFor, row.resumesAt],
        ]),
      );
    // Room under the plan: capacity holds it, a plain wait.
    expect(await waitingFor()).toEqual({ [capacity]: [null, null], [review]: [null, null] });
    await db
      .insert(schema.usageCounters)
      .values({ teamId: team, day: utcDay(), accepted: 1_000_000 });
    const reset = nextUtcDayStart(new Date());
    // A silent hold reads as capacity does, here and on its page: nothing sets it apart.
    expect(await waitingFor()).toEqual({
      [capacity]: ["plan", reset],
      [review]: ["plan", reset],
    });
    for (const id of [capacity, review]) {
      expect((await caller(team).emails.get({ id })).pending).toEqual({
        kind: "plan",
        resumesAt: reset,
      });
    }
  });

  it("says what an unsent row waits for, and names its broadcast", async () => {
    const team = await createTeam(db, "team-a");
    const broadcastId = await broadcastFor(team);
    const at = new Date(Date.now() + 3_600_000);
    const scheduled = await insertEmail({ ...baseEmail(team), scheduledAt: at });
    const parked = await insertEmail({
      ...baseEmail(team),
      broadcastId,
      latestStatus: "queued_quota",
    });
    const sent = await insertEmail({
      ...baseEmail(team),
      latestStatus: "delivered",
      sentAt: new Date(),
    });

    expect((await caller(team).emails.get({ id: scheduled })).pending).toEqual({
      kind: "scheduled",
      at,
    });
    const bulk = await caller(team).emails.get({ id: parked });
    expect(bulk.broadcast).toEqual({ id: broadcastId, name: "news" });
    expect(bulk.pending?.kind).toBe("paced");
    // Parked with the plan not binding: capacity holds it, never "raise your limit".
    const txParked = await insertEmail({ ...baseEmail(team), latestStatus: "queued_quota" });
    expect((await caller(team).emails.get({ id: txParked })).pending).toEqual({ kind: "waiting" });
    const done = await caller(team).emails.get({ id: sent });
    expect(done.pending).toBeNull();
    expect(done.broadcast).toBeNull();
  });

  it("shows a broadcast's waiting copies in a held region as delayed, never its other mail", async () => {
    const team = await createTeam(db, "team-a");
    const [domain] = await db
      .insert(schema.domains)
      .values({ teamId: team, name: "acme.test", region: "sa-east-1", status: "verified" })
      .returning({ id: schema.domains.id });
    if (!domain) throw new Error("domain insert failed");
    const broadcastId = await broadcastFor(team);
    const copy = (to: string, over: Partial<typeof schema.emails.$inferInsert>) =>
      insertEmail({ ...baseEmail(team), to: [to], domainId: domain.id, broadcastId, ...over });
    const parked = await copy("a@example.com", { latestStatus: "queued_quota" });
    const queued = await copy("b@example.com", { latestStatus: "queued" });
    const delivered = await copy("c@example.com", {
      latestStatus: "delivered",
      sentAt: new Date(),
    });
    const tx = await insertEmail({
      ...baseEmail(team),
      domainId: domain.id,
      latestStatus: "queued_quota",
    });
    await db.insert(schema.regionBreakers).values({
      region: "sa-east-1",
      paused: true,
      reason: {
        metric: "bounce",
        rate: 0.05,
        limit: 0.05,
        windowHours: 24,
        sent: 2000,
        events: 100,
      },
      pausedAt: new Date(),
    });

    const held = async () =>
      Object.fromEntries((await caller(team).emails.list({})).items.map((r) => [r.id, r.held]));
    expect(await held()).toEqual({
      [parked]: true,
      [queued]: true,
      [delivered]: false,
      [tx]: false,
    });
    expect((await caller(team).emails.get({ id: parked })).pending).toEqual({ kind: "held" });
    expect((await caller(team).emails.get({ id: queued })).pending).toEqual({ kind: "held" });
    expect((await caller(team).emails.get({ id: tx })).pending).toEqual({ kind: "waiting" });

    // A pause the complaints tripped holds only the teams it names.
    await db.update(schema.regionBreakers).set({ heldTeams: [randomUUID()] });
    expect(Object.values(await held()).some(Boolean)).toBe(false);
    await db.update(schema.regionBreakers).set({ heldTeams: [team] });
    expect((await held())[parked]).toBe(true);

    await db.update(schema.regionBreakers).set({ paused: false });
    expect(Object.values(await held()).some(Boolean)).toBe(false);
    expect((await caller(team).emails.get({ id: queued })).pending).toEqual({ kind: "queued" });
  });
});

describe("emails.get", () => {
  it("decrypts the body and returns events in order", async () => {
    const teamA = await createTeam(db, "team-a");
    const keyring = EnvKeyring.fromBase64(TEST_KEK);
    const encrypted = await encryptEmailBody({ html: "<p>hi</p>", text: "hi" }, keyring);
    const id = await insertEmail({
      ...baseEmail(teamA),
      latestStatus: "delivered",
      bodyCiphertext: encrypted.ciphertext,
      bodyIv: encrypted.iv,
      bodyWrappedDek: encrypted.wrappedDek,
      bodyKeyVersion: encrypted.keyVersion,
    });
    await db.insert(schema.emailEvents).values([
      { emailId: id, type: "delivered", occurredAt: new Date("2026-08-01T10:05:00Z") },
      { emailId: id, type: "sent", occurredAt: new Date("2026-08-01T10:00:00Z") },
    ]);

    const email = await caller(teamA).emails.get({ id });
    expect(email.html).toBe("<p>hi</p>");
    expect(email.text).toBe("hi");
    expect(email.bodyPurgedAt).toBeNull();
    expect(email.events.map((e) => e.type)).toEqual(["sent", "delivered"]);
    expect(email).not.toHaveProperty("bodyCiphertext");
    expect(email).not.toHaveProperty("bodyWrappedDek");
  });

  it("tolerates a corrupt body and a purged body", async () => {
    const teamA = await createTeam(db, "team-a");
    const corrupt = await insertEmail({
      ...baseEmail(teamA),
      bodyCiphertext: randomBytes(48),
      bodyIv: randomBytes(12),
      bodyWrappedDek: randomBytes(60),
      bodyKeyVersion: 1,
    });
    const purgedAt = new Date("2026-08-01T00:00:00Z");
    const purged = await insertEmail({ ...baseEmail(teamA), bodyPurgedAt: purgedAt });

    const corruptEmail = await caller(teamA).emails.get({ id: corrupt });
    expect(corruptEmail.html).toBeNull();
    expect(corruptEmail.text).toBeNull();

    const purgedEmail = await caller(teamA).emails.get({ id: purged });
    expect(purgedEmail.html).toBeNull();
    expect(purgedEmail.bodyPurgedAt?.getTime()).toBe(purgedAt.getTime());
  });

  it("hides other teams' emails", async () => {
    const teamA = await createTeam(db, "team-a");
    const teamB = await createTeam(db, "team-b");
    const id = await insertEmail(baseEmail(teamA));

    await expect(caller(teamB).emails.get({ id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("returns insights from an emailId-keyed row", async () => {
    const teamA = await createTeam(db, "team-a");
    const id = await insertEmail(baseEmail(teamA));
    await db.insert(schema.emailInsights).values({
      teamId: teamA,
      emailId: id,
      marketing: false,
      checks: [
        { id: "dmarc_record", severity: "critical", status: "fail", penaltyHundredths: 350 },
      ],
      scoreTenths: 65,
      scoreVersion: 1,
      htmlSizeBytes: 2048,
    });

    const email = await caller(teamA).emails.get({ id });
    expect(email.insights).toMatchObject({
      scoreTenths: 65,
      band: "needs_attention",
      marketing: false,
      htmlSizeBytes: 2048,
      checks: [
        { id: "dmarc_record", severity: "critical", status: "fail", penaltyHundredths: 350 },
      ],
    });
    expect(email.insights?.computedAt).toBeInstanceOf(Date);
  });

  it("resolves a broadcast email's shared broadcastId-keyed insights row", async () => {
    const teamA = await createTeam(db, "team-a");
    const [broadcast] = await db
      .insert(schema.broadcasts)
      .values({ teamId: teamA, from: "sender@acme.test", subject: "hello" })
      .returning({ id: schema.broadcasts.id });
    if (!broadcast) throw new Error("broadcast insert failed");
    const id = await insertEmail({ ...baseEmail(teamA), broadcastId: broadcast.id });
    await db.insert(schema.emailInsights).values({
      teamId: teamA,
      broadcastId: broadcast.id,
      marketing: true,
      checks: [],
      scoreTenths: 92,
      scoreVersion: 1,
    });

    const email = await caller(teamA).emails.get({ id });
    expect(email.insights).toMatchObject({ scoreTenths: 92, band: "excellent", marketing: true });
  });

  it("ignores an insights row belonging to another team", async () => {
    const teamA = await createTeam(db, "team-a");
    const teamB = await createTeam(db, "team-b");
    const id = await insertEmail(baseEmail(teamA));
    await db.insert(schema.emailInsights).values({
      teamId: teamB,
      emailId: id,
      marketing: false,
      checks: [],
      scoreTenths: 80,
      scoreVersion: 1,
    });

    const email = await caller(teamA).emails.get({ id });
    expect(email.insights).toBeNull();
  });

  it("returns null insights when no row exists (pre-feature sends have none)", async () => {
    const teamA = await createTeam(db, "team-a");
    const id = await insertEmail(baseEmail(teamA));

    const email = await caller(teamA).emails.get({ id });
    expect(email.insights).toBeNull();
  });
});

describe("emails.stats", () => {
  it("aggregates usage counters and the queued backlog per team", async () => {
    const teamA = await createTeam(db, "team-a");
    const teamB = await createTeam(db, "team-b");
    const today = utcDay();

    await db.insert(schema.usageCounters).values([
      { teamId: teamA, day: today, accepted: 90, sent: 87, delivered: 40 },
      { teamId: teamA, day: "2026-01-01", accepted: 210, sent: 200, delivered: 160 },
      { teamId: teamB, day: today, accepted: 6, sent: 5, delivered: 5 },
    ]);
    await insertEmail({ ...baseEmail(teamA), latestStatus: "queued_quota" });
    await insertEmail({ ...baseEmail(teamA), latestStatus: "delivered" });

    const stats = await caller(teamA).emails.stats();
    expect(stats).toEqual({
      hasBroadcasts: false,
      sentToday: 87,
      deliveredAllTime: 200,
      queuedQuota: 1,
    });
  });

  it("returns zeros for an empty team", async () => {
    const teamA = await createTeam(db, "team-a");
    const stats = await caller(teamA).emails.stats();
    expect(stats).toEqual({
      hasBroadcasts: false,
      sentToday: 0,
      deliveredAllTime: 0,
      queuedQuota: 0,
    });
  });
});

describe("emails.suppressions", () => {
  it("adds, lists, and removes within the team only", async () => {
    const teamA = await createTeam(db, "team-a");
    const teamB = await createTeam(db, "team-b");

    const added = await caller(teamA).emails.suppressions.add({
      email: "Block@Example.com",
      reason: "manual",
    });

    const listA = await caller(teamA).emails.suppressions.list({});
    expect(listA.items).toHaveLength(1);
    expect(listA.items[0]?.id).toBe(added.id);
    expect(listA.items[0]?.reason).toBe("manual");

    const [row] = await db
      .select()
      .from(schema.suppressions)
      .where(
        and(
          eq(schema.suppressions.teamId, teamA),
          eq(schema.suppressions.emailHash, hashRecipient("block@example.com")),
        ),
      );
    expect(row?.id).toBe(added.id);

    const listB = await caller(teamB).emails.suppressions.list({});
    expect(listB.items).toHaveLength(0);
    await expect(caller(teamB).emails.suppressions.remove({ id: added.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    // Lifting a block is admin-only; members still read the list.
    await expect(
      caller(teamA, "member").emails.suppressions.remove({ id: added.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await caller(teamA, "member").emails.suppressions.list({})).items).toHaveLength(1);

    await caller(teamA).emails.suppressions.remove({ id: added.id });
    const afterRemove = await caller(teamA).emails.suppressions.list({});
    expect(afterRemove.items).toHaveLength(0);
  });

  it("pages without skipping same-millisecond suppressions", async () => {
    const teamA = await createTeam(db, "team-a");
    async function insertSuppression(email: string, createdAt: string): Promise<string> {
      const [row] = await db
        .insert(schema.suppressions)
        .values({
          teamId: teamA,
          email,
          emailHash: hashRecipient(email),
          reason: "manual",
          createdAt: sql`${createdAt}::timestamptz` as unknown as Date,
        })
        .returning({ id: schema.suppressions.id });
      if (!row) throw new Error("suppression insert failed");
      return row.id;
    }
    const newer = await insertSuppression("a@example.com", "2026-08-01 10:00:00.123456+00");
    const older = await insertSuppression("b@example.com", "2026-08-01 10:00:00.123400+00");

    const page1 = await caller(teamA).emails.suppressions.list({ limit: 1 });
    expect(page1.items.map((r) => r.id)).toEqual([newer]);
    if (!page1.nextCursor) throw new Error("expected a next cursor");

    const page2 = await caller(teamA).emails.suppressions.list({
      limit: 1,
      cursor: page1.nextCursor,
    });
    expect(page2.items.map((r) => r.id)).toEqual([older]);
  });

  it("filters by reason, reports totals, and aggregates stats", async () => {
    const teamA = await createTeam(db, "team-a");
    await caller(teamA).emails.suppressions.add({ email: "a@example.com", reason: "manual" });
    await db.insert(schema.suppressions).values({
      teamId: teamA,
      email: "b@example.com",
      emailHash: hashRecipient("b@example.com"),
      reason: "hard_bounce",
    });

    const bounces = await caller(teamA).emails.suppressions.list({ reason: "hard_bounce" });
    expect(bounces.items.map((r) => r.email)).toEqual(["b@example.com"]);
    expect(bounces.total).toBe(1);

    const all = await caller(teamA).emails.suppressions.list({});
    expect(all.total).toBe(2);

    const stats = await caller(teamA).emails.suppressions.stats();
    expect(stats.total).toBe(2);
    expect(stats.byReason).toEqual({ manual: 1, hard_bounce: 1 });
  });

  it("gets a suppression with its source-bounce diagnostics, team-scoped", async () => {
    const teamA = await createTeam(db, "team-a");
    const teamB = await createTeam(db, "team-b");
    const sourceEmail = await insertEmail({
      ...baseEmail(teamA),
      to: ["gone@example.com"],
      latestStatus: "bounced",
    });
    await db.insert(schema.emailEvents).values({
      emailId: sourceEmail,
      type: "bounced",
      occurredAt: new Date("2026-08-01T10:00:02Z"),
      data: {
        bounce: {
          bounceType: "Permanent",
          bounceSubType: "General",
          bouncedRecipients: [{ diagnosticCode: "smtp; 550 5.1.1 user unknown" }],
        },
      },
    });
    const [suppression] = await db
      .insert(schema.suppressions)
      .values({
        teamId: teamA,
        email: "gone@example.com",
        emailHash: hashRecipient("gone@example.com"),
        reason: "hard_bounce",
        sourceEmailId: sourceEmail,
      })
      .returning({ id: schema.suppressions.id });
    if (!suppression) throw new Error("suppression insert failed");

    const row = await caller(teamA).emails.suppressions.get({ id: suppression.id });
    expect(row.email).toBe("gone@example.com");
    expect(row.reason).toBe("hard_bounce");
    expect(row.bounce).toMatchObject({ bounceType: "Permanent", bounceSubType: "General" });

    await expect(
      caller(teamB).emails.suppressions.get({ id: suppression.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("marks a hard bounce a full or inactive mailbox left, in the list, the detail and an email's matches", async () => {
    const teamA = await createTeam(db, "team-a");
    const teamB = await createTeam(db, "team-b");
    const bouncedEmail = async (teamId: string, to: string, bounceType: string) => {
      const id = await insertEmail({ ...baseEmail(teamId), to: [to], latestStatus: "bounced" });
      await db.insert(schema.emailEvents).values({
        emailId: id,
        type: "bounced",
        occurredAt: new Date("2026-08-01T10:00:02Z"),
        bounceType,
        data: { bounce: { bounceType, bounceSubType: "General" } },
      });
      return id;
    };
    const suppress = async (
      email: string,
      reason: "hard_bounce" | "complaint",
      sourceEmailId: string | null,
    ) => {
      const [row] = await db
        .insert(schema.suppressions)
        .values({ teamId: teamA, email, emailHash: hashRecipient(email), reason, sourceEmailId })
        .returning({ id: schema.suppressions.id });
      if (!row) throw new Error("suppression insert failed");
      return row.id;
    };
    const full = await suppress(
      "full@example.com",
      "hard_bounce",
      await bouncedEmail(teamA, "full@example.com", "Transient"),
    );
    const gone = await suppress(
      "gone@example.com",
      "hard_bounce",
      await bouncedEmail(teamA, "gone@example.com", "Permanent"),
    );
    const complained = await suppress("spam@example.com", "complaint", null);
    // A source id that is another team's email reads nothing of its events.
    const stray = await suppress(
      "stray@example.com",
      "hard_bounce",
      await bouncedEmail(teamB, "stray@example.com", "Transient"),
    );

    const list = await caller(teamA).emails.suppressions.list({});
    expect(Object.fromEntries(list.items.map((r) => [r.id, r.fullMailbox]))).toEqual({
      [full]: true,
      [gone]: false,
      [complained]: false,
      [stray]: false,
    });
    // The API's reason is unchanged.
    expect(list.items.find((r) => r.id === full)?.reason).toBe("hard_bounce");
    expect((await caller(teamA).emails.suppressions.get({ id: full })).fullMailbox).toBe(true);
    expect((await caller(teamA).emails.suppressions.get({ id: gone })).fullMailbox).toBe(false);

    const emailId = await insertEmail({
      ...baseEmail(teamA),
      to: ["full@example.com", "gone@example.com", "spam@example.com"],
      latestStatus: "suppressed",
    });
    const matches = await caller(teamA).emails.suppressions.forEmail({ emailId });
    expect(Object.fromEntries(matches.map((r) => [r.id, r.fullMailbox]))).toEqual({
      [full]: true,
      [gone]: false,
      [complained]: false,
    });
  });

  it("is idempotent on duplicate adds", async () => {
    const teamA = await createTeam(db, "team-a");
    const first = await caller(teamA).emails.suppressions.add({
      email: "dup@example.com",
      reason: "manual",
    });
    const second = await caller(teamA).emails.suppressions.add({
      email: "Dup@example.com",
      reason: "manual",
    });
    expect(second.id).toBe(first.id);

    const list = await caller(teamA).emails.suppressions.list({});
    expect(list.items).toHaveLength(1);
  });

  describe("forEmail", () => {
    async function insertSuppression(
      teamId: string,
      address: string,
      values: Partial<typeof schema.suppressions.$inferInsert> = {},
    ): Promise<string> {
      const [row] = await db
        .insert(schema.suppressions)
        .values({
          teamId,
          email: address,
          emailHash: hashRecipient(address),
          reason: "manual",
          ...values,
        })
        .returning({ id: schema.suppressions.id });
      if (!row) throw new Error("suppression insert failed");
      return row.id;
    }

    it("matches every recipient the way sends do, display names and case aside", async () => {
      const teamA = await createTeam(db, "team-a");
      const emailId = await insertEmail({
        ...baseEmail(teamA),
        to: ["Ada <Ada@Example.com>", "fine@example.com"],
        cc: ["GRACE@example.com"],
        bcc: ["Erased <erased@example.com>"],
        latestStatus: "suppressed",
      });
      const ada = await insertSuppression(teamA, "ada@example.com", {
        reason: "hard_bounce",
        createdAt: new Date("2026-08-01T10:00:00Z"),
      });
      const grace = await insertSuppression(teamA, "grace@example.com", {
        reason: "one_click_unsubscribe",
        createdAt: new Date("2026-08-02T10:00:00Z"),
      });
      // Erasure nulls the address and keeps the hash, which still matches.
      const erased = await insertSuppression(teamA, "erased@example.com", {
        email: null,
        reason: "complaint",
        createdAt: new Date("2026-08-03T10:00:00Z"),
      });
      await insertSuppression(teamA, "unrelated@example.com");

      const rows = await caller(teamA, "member").emails.suppressions.forEmail({ emailId });
      expect(rows.map(({ id, email, reason }) => ({ id, email, reason }))).toEqual([
        { id: erased, email: null, reason: "complaint" },
        { id: grace, email: "grace@example.com", reason: "one_click_unsubscribe" },
        { id: ada, email: "ada@example.com", reason: "hard_bounce" },
      ]);
    });

    it("never matches another team's suppression or reads another team's email", async () => {
      const teamA = await createTeam(db, "team-a");
      const teamB = await createTeam(db, "team-b");
      const emailId = await insertEmail({ ...baseEmail(teamA), latestStatus: "suppressed" });
      await insertSuppression(teamB, "ada@example.com");

      expect(await caller(teamA).emails.suppressions.forEmail({ emailId })).toEqual([]);
      await expect(caller(teamB).emails.suppressions.forEmail({ emailId })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    });
  });
});
