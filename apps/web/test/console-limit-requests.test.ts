import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { TeamRole } from "@/server/membership";
import { createCaller } from "@/server/routers";

const h = vi.hoisted(() => ({ drains: 0, queries: {} as Record<string, unknown> }));

vi.mock("@/server/queue", () => ({
  getQueue: async () => ({
    runCronNow: async () => {
      h.drains += 1;
    },
  }),
  enqueueEmailSend: async () => {},
  enqueueWebhookDeliveries: async () => {},
  enqueueRecipientErase: async () => {},
}));
// The real English catalogs, so the test reads what the operator reads.
vi.mock("next-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-intl")>();
  const messages = {
    console: (await import("../messages/en/console.json")).default,
    common: (await import("../messages/en/common.json")).default,
  };
  return {
    ...actual,
    useLocale: () => "en",
    useTranslations: (namespace: string) =>
      actual.createTranslator({
        locale: "en",
        messages,
        namespace: namespace as keyof typeof messages,
      }),
  };
});
// Each procedure's options name its path; a query answers with what the test put there.
vi.mock("@/lib/trpc", () => {
  const at = (path: string[]): unknown =>
    new Proxy(() => {}, {
      get: (_, key: string) =>
        key.endsWith("Options") ? () => ({ path: path.join(".") }) : at([...path, key]),
    });
  return { useTRPC: () => at([]) };
});
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { path: string }) => ({ data: h.queries[options.path] }),
}));

const { LimitRequests } = await import("@/components/console/safety/limit-requests");

let db: Db;
let close: () => Promise<void>;
const OPERATOR = "op";
const MEMBER = "ana";

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await db.insert(schema.user).values([
    { id: OPERATOR, name: "Operator", email: "op@example.com", createdAt: new Date(0) },
    { id: MEMBER, name: "Ana", email: "ana@nova.example", createdAt: new Date(1) },
  ]);
});
afterAll(() => close());

function callerFor(
  userId: string | null,
  team: string | null = null,
  role: TeamRole | null = null,
) {
  return createCaller({
    db,
    session: userId
      ? {
          user: { id: userId, email: `${userId}@example.com`, name: userId },
          session: { id: `s-${userId}`, createdAt: new Date() },
        }
      : null,
    teamId: team,
    role,
  });
}
const operator = () => callerFor(OPERATOR);

async function teamWithOwner(name: string) {
  const teamId = await createTeam(db, name);
  await db.insert(schema.teamMembers).values({ teamId, userId: MEMBER, role: "owner" });
  return teamId;
}

async function domain(teamId: string, name: string) {
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
  return row.id;
}

async function ask(
  teamId: string,
  domainId: string,
  over: Partial<typeof schema.domainLimitRequests.$inferInsert> = {},
) {
  const [row] = await db
    .insert(schema.domainLimitRequests)
    .values({
      teamId,
      domainId,
      requestedBy: MEMBER,
      sends: "account",
      perDay: 2000,
      source: "new",
      note: "People sign up on nova.example and get a confirmation email.",
      ...over,
    })
    .returning({ id: schema.domainLimitRequests.id });
  if (!row) throw new Error("request insert failed");
  return row.id;
}

async function parked(
  teamId: string,
  domainId: string,
  over: Partial<typeof schema.emails.$inferInsert> = {},
) {
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

async function requestRow(id: string) {
  const [row] = await db
    .select()
    .from(schema.domainLimitRequests)
    .where(eq(schema.domainLimitRequests.id, id));
  return row;
}

async function auditRows(action: string) {
  return db.select().from(schema.auditLog).where(eq(schema.auditLog.action, action));
}

describe("console.safety.limitRequests", () => {
  it("lists the open requests, newest first, with what each domain's limit holds", async () => {
    const nova = await teamWithOwner("nova");
    const fresh = await domain(nova, "nova.example");
    const labs = await domain(nova, "labs.nova.example");
    const orbit = await createTeam(db, "orbit");
    const orbitDomain = await domain(orbit, "orbit.example");
    await ask(nova, fresh, { createdAt: new Date(Date.now() - 3_600_000) });
    await ask(nova, labs, { status: "declined", resolvedAt: new Date() });
    await ask(orbit, orbitDomain, {
      requestedBy: null,
      sends: "marketing",
      source: "other_provider",
      perDay: 500,
      note: null,
    });
    await parked(nova, fresh);
    await parked(nova, fresh);
    // Silent holds, the plan's cap and the declined domain's mail are not this list's.
    await parked(nova, fresh, { parkReason: "screening" });
    await parked(nova, fresh, { parkReason: null });
    await parked(nova, labs);

    const list = await operator().console.safety.limitRequests();
    expect(
      list.map((r) => [
        r.team,
        r.domain,
        r.perDay,
        r.sends,
        r.source,
        r.waiting,
        r.requesterEmail,
        r.note,
      ]),
    ).toEqual([
      ["orbit", "orbit.example", 500, "marketing", "other_provider", 0, null, null],
      [
        "nova",
        "nova.example",
        2000,
        "account",
        "new",
        2,
        "ana@nova.example",
        "People sign up on nova.example and get a confirmation email.",
      ],
    ]);

    h.queries = { "console.safety.limitRequests": list };
    const html = renderToStaticMarkup(createElement(LimitRequests));
    expect(html).toContain("Limit requests · 2");
    expect(html).toContain(`<a href="/console/safety/${nova}">nova</a>`);
    expect(html).toContain(
      '<td class="ms-mono">nova.example</td><td class="right num">2,000</td><td>Sign-up and account</td><td>Nowhere yet</td><td class="right num">2</td>',
    );
    expect(html).toContain("<td>Newsletters and marketing</td><td>Another provider</td>");
    h.queries = { "console.safety.limitRequests": [] };
    expect(renderToStaticMarkup(createElement(LimitRequests))).toBe("");

    // The team's own review shows each domain's open request on its row.
    const review = await operator().console.safety.review({ teamId: nova });
    expect(review.warmup.domains.map((d) => [d.name, d.request?.perDay ?? null])).toEqual([
      ["labs.nova.example", null],
      ["nova.example", 2000],
    ]);
  });

  it("is operator-only", async () => {
    const nova = await teamWithOwner("nova-gate");
    await expect(
      callerFor(MEMBER, nova, "owner").console.safety.limitRequests(),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(null).console.safety.limitRequests()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});

describe("console.safety.declineLimitRequest", () => {
  it("declines an open request once, on the instance's log", async () => {
    const nova = await teamWithOwner("nova-decline");
    const fresh = await domain(nova, "decline.nova.example");
    const requestId = await ask(nova, fresh);
    const drains = h.drains;

    await expect(
      callerFor(MEMBER, nova, "owner").console.safety.declineLimitRequest({ requestId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await requestRow(requestId))?.status).toBe("open");

    expect(await operator().console.safety.declineLimitRequest({ requestId })).toEqual({
      declined: true,
    });
    expect(await requestRow(requestId)).toMatchObject({
      status: "declined",
      resolvedBy: "op@example.com",
      resolvedAt: expect.any(Date),
    });
    expect(await auditRows("warmup.request_declined")).toMatchObject([
      {
        teamId: null,
        target: `team:${nova}`,
        actorId: `user:${OPERATOR}`,
        data: { team: "nova-decline", domain: "decline.nova.example" },
      },
    ]);
    // The team's own audit log never shows the lever, and the mail it holds stays held.
    const own = await callerFor(MEMBER, nova, "owner").audit.list({ limit: 50 });
    expect(own.items.filter((r) => r.action.startsWith("warmup."))).toEqual([]);
    expect(h.drains).toBe(drains);

    await expect(
      operator().console.safety.declineLimitRequest({ requestId }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await auditRows("warmup.request_declined")).toHaveLength(1);
    const list = await operator().console.safety.limitRequests();
    expect(list.map((r) => r.id)).not.toContain(requestId);
  });
});

describe("console.safety.setWarmupTrust and open requests", () => {
  it("grants the request a domain's trust covers, then the rest with the team's", async () => {
    const comet = await teamWithOwner("comet");
    const a = await domain(comet, "a.comet.example");
    const b = await domain(comet, "b.comet.example");
    const onA = await ask(comet, a);
    const onB = await ask(comet, b);
    const drains = h.drains;

    await operator().console.safety.setWarmupTrust({ teamId: comet, domainId: a, trusted: true });
    expect(await requestRow(onA)).toMatchObject({
      status: "granted",
      resolvedBy: "op@example.com",
      resolvedAt: expect.any(Date),
    });
    expect((await requestRow(onB))?.status).toBe("open");
    expect(await auditRows("warmup.trust_granted")).toMatchObject([
      {
        teamId: null,
        target: `team:${comet}`,
        data: { team: "comet", domain: "a.comet.example" },
      },
    ]);
    expect(h.drains).toBe(drains + 1);

    await operator().console.safety.setWarmupTrust({ teamId: comet, trusted: true });
    expect((await requestRow(onB))?.status).toBe("granted");
    // Removing trust leaves the answered requests as they are.
    await operator().console.safety.setWarmupTrust({ teamId: comet, trusted: false });
    await operator().console.safety.setWarmupTrust({ teamId: comet, domainId: a, trusted: false });
    expect([(await requestRow(onA))?.status, (await requestRow(onB))?.status]).toEqual([
      "granted",
      "granted",
    ]);
    await expect(
      operator().console.safety.setWarmupTrust({
        teamId: await createTeam(db, "elsewhere"),
        domainId: a,
        trusted: true,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
