import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { warmupCap } from "../src/domain-warmup.js";
import {
  createLimitRequest,
  declineLimitRequest,
  getOpenLimitRequest,
  latestLimitRequest,
  listLimitRequests,
  setWarmupTrust,
} from "../src/limit-requests.js";
import { LIMIT_REQUEST_NOTE_MAX } from "../src/limit-rules.js";
import { DAY_MS } from "../src/utc-day.js";

const NOW = new Date("2026-10-20T18:00:00Z");

let db: Db;
let close: () => Promise<void>;
let seq = 0;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await db.insert(schema.instanceSettings).values({ id: 1, warmupEnabled: true });
});
afterAll(() => close());

async function setup(registeredAt: Date | null = new Date(NOW.getTime() - 3 * DAY_MS)) {
  seq += 1;
  const teamId = await createTeam(db, `ask-${seq}`);
  const userId = `asker-${seq}`;
  await db
    .insert(schema.user)
    .values({ id: userId, name: "Ana", email: `ana-${seq}@nova.example` });
  const domain = async (name: string, over: Partial<typeof schema.domains.$inferInsert> = {}) => {
    const [row] = await db
      .insert(schema.domains)
      .values({ teamId, name, region: "us-east-1", status: "verified", registeredAt, ...over })
      .returning({ id: schema.domains.id });
    if (!row) throw new Error("domain insert failed");
    return row.id;
  };
  const domainId = await domain(`mail-${seq}.nova.example`);
  const ask = (over: Partial<Parameters<typeof createLimitRequest>[1]> = {}) =>
    createLimitRequest(db, {
      teamId,
      domainId,
      userId,
      sends: "account",
      perDay: 2000,
      source: "new",
      note: "  People sign up and get a confirmation email.  ",
      now: NOW,
      ...over,
    });
  return { teamId, userId, domainId, domain, ask };
}

describe("createLimitRequest", () => {
  it("opens one request per domain, trims the note and audits it for the team", async () => {
    const { teamId, userId, domainId, ask } = await setup();
    const first = await ask();
    expect(first).toEqual({
      ok: true,
      request: {
        id: expect.any(String),
        domainId,
        status: "open",
        sends: "account",
        perDay: 2000,
        source: "new",
        note: "People sign up and get a confirmation email.",
        createdAt: NOW,
        resolvedAt: null,
      },
    });
    expect(await ask()).toEqual({ ok: false, refusal: "already_open" });
    expect(await getOpenLimitRequest(db, { teamId, domainId })).toEqual(
      first.ok ? first.request : null,
    );
    const audit = await db
      .select({
        actorId: schema.auditLog.actorId,
        action: schema.auditLog.action,
        target: schema.auditLog.target,
        data: schema.auditLog.data,
      })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.teamId, teamId));
    expect(audit).toEqual([
      {
        actorId: `user:${userId}`,
        action: "domain.limit_requested",
        target: `domain:${domainId}`,
        data: {
          name: expect.stringContaining("nova.example"),
          perDay: 2000,
          sends: "account",
          source: "new",
        },
      },
    ]);
  });

  it("lets only one of two racing requests in", async () => {
    const { ask } = await setup();
    const results = await Promise.all([ask(), ask()]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, refusal: "already_open" }]);
  });

  it("refuses what is out of range, and stores an empty note as none", async () => {
    const { ask } = await setup();
    for (const over of [
      { perDay: 0 },
      { perDay: 10_000_001 },
      { perDay: 1.5 },
      { note: "x".repeat(LIMIT_REQUEST_NOTE_MAX + 1) },
      { sends: "spam" as never },
      { source: "elsewhere" as never },
    ]) {
      expect(await ask(over), JSON.stringify(over).slice(0, 40)).toEqual({
        ok: false,
        refusal: "invalid",
      });
    }
    const blank = await ask({ note: "   ", perDay: 10_000_000 });
    expect(blank.ok && blank.request.note).toBeNull();
  });

  it("refuses another team's domain and a domain the limit does not apply to", async () => {
    const { domain, ask } = await setup();
    const stranger = await setup();
    expect(await ask({ domainId: stranger.domainId })).toEqual({ ok: false, refusal: "not_found" });
    const old = await domain("old.nova.example", { registeredAt: new Date("2020-01-01") });
    const pending = await domain("pending.nova.example", { status: "pending" });
    const trusted = await domain("trusted.nova.example", { warmupTrustedAt: NOW });
    for (const domainId of [old, pending, trusted]) {
      expect(await ask({ domainId })).toEqual({ ok: false, refusal: "not_limited" });
    }
  });
});

describe("answering a request", () => {
  it("declines once, leaving the limit in place, and the next request opens", async () => {
    const { teamId, domainId, ask } = await setup();
    const asked = await ask();
    if (!asked.ok) throw new Error("request refused");
    const decline = { requestId: asked.request.id, operator: "op@example.com", now: NOW };
    expect(await declineLimitRequest(db, decline)).toEqual({
      ok: true,
      request: { id: asked.request.id, teamId, domainId },
    });
    expect(await declineLimitRequest(db, decline)).toEqual({ ok: false, refusal: "not_open" });
    expect(await latestLimitRequest(db, { teamId, domainId })).toMatchObject({
      status: "declined",
      resolvedAt: NOW,
    });
    expect(await getOpenLimitRequest(db, { teamId, domainId })).toBeNull();
    expect(await warmupCap(db, { teamId, domainId, at: NOW })).not.toBeNull();
    const again = await ask({ now: new Date(NOW.getTime() + 1000) });
    expect(again.ok).toBe(true);
    expect(await latestLimitRequest(db, { teamId, domainId })).toMatchObject({ status: "open" });
  });

  it("is granted by trusting the domain, naming the operator who did", async () => {
    const { teamId, domainId, ask } = await setup();
    await ask();
    await setWarmupTrust(db, {
      teamId,
      domainId,
      trusted: true,
      now: NOW,
      operator: "op@example.com",
    });
    expect(await warmupCap(db, { teamId, domainId, at: NOW })).toBeNull();
    const [row] = await listLimitRequests(db, { teamId, limit: 10 });
    expect(row).toMatchObject({ status: "granted", resolvedBy: "op@example.com" });
  });

  it("is granted by any trust of its domain or its team, and only then", async () => {
    const { teamId, domainId, domain, ask } = await setup();
    const other = await domain("other.nova.example");
    await ask();
    await ask({ domainId: other });
    const statuses = async () =>
      (await listLimitRequests(db, { teamId, limit: 10 })).map((r) => [r.domainId, r.status]);
    expect(await setWarmupTrust(db, { teamId, domainId: other, trusted: false })).toEqual({
      domain: "other.nova.example",
    });
    expect((await statuses()).map(([, s]) => s)).toEqual(["open", "open"]);
    await setWarmupTrust(db, {
      teamId,
      domainId: other,
      trusted: true,
      operator: "op@example.com",
    });
    expect(Object.fromEntries(await statuses())).toEqual({
      [domainId]: "open",
      [other]: "granted",
    });
    await setWarmupTrust(db, { teamId, trusted: true });
    expect(Object.fromEntries(await statuses())).toEqual({
      [domainId]: "granted",
      [other]: "granted",
    });
    const stranger = await setup();
    expect(
      await setWarmupTrust(db, { teamId, domainId: stranger.domainId, trusted: true }),
    ).toBeNull();
    expect(await getOpenLimitRequest(db, stranger)).toBeNull();
  });
});

describe("listLimitRequests", () => {
  it("names the team, the domain and who asked, newest first, by status and team", async () => {
    const a = await setup();
    const b = await setup();
    await a.ask();
    await b.ask({ now: new Date(NOW.getTime() + 60_000) });
    const open = (await listLimitRequests(db, { status: "open", limit: 100 })).filter((r) =>
      [a.teamId, b.teamId].includes(r.teamId),
    );
    expect(open.map((r) => [r.team, r.requesterEmail])).toEqual([
      [`ask-${seq}`, `ana-${seq}@nova.example`],
      [`ask-${seq - 1}`, `ana-${seq - 1}@nova.example`],
    ]);
    expect(open[0]).toMatchObject({ domain: `mail-${seq}.nova.example`, resolvedBy: null });
    expect(
      await listLimitRequests(db, { status: "declined", teamId: a.teamId, limit: 10 }),
    ).toEqual([]);
    // Who asked can leave; the request stays.
    await db.delete(schema.user).where(eq(schema.user.id, a.userId));
    const [row] = await listLimitRequests(db, { teamId: a.teamId, limit: 10 });
    expect(row).toMatchObject({ requesterEmail: null, status: "open" });
  });
});
