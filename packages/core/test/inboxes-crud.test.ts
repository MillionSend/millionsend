import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb, createWebhookEndpoint } from "@millionsend/test-utils";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { generateApiKey } from "../src/api-keys.js";
import { type InboxActor, touchInbox } from "../src/inboxes/activity.js";
import {
  createInbox,
  deleteInboxes,
  expireInboxes,
  getInbox,
  getInboxSafety,
  type InboxDeps,
  listInboxes,
  updateInbox,
  updateInboxSafety,
} from "../src/inboxes/inboxes.js";
import { SHARED_NAME_REVIEWS_PER_DAY } from "../src/inboxes/limits.js";
import { defaultSafety } from "../src/inboxes/safety.js";
import type { SharedNameText } from "../src/inboxes/shared-domain.js";
import { utcDay } from "../src/utc-day.js";

const SHARED = "agents.example.test";
const api: InboxActor = { kind: "api_key", apiKeyId: randomUUID(), inboxId: null };
const person: InboxActor = { kind: "user", userId: "user-1" };
const deps: InboxDeps = { sharedInboxDomain: SHARED, receivingEnabled: true };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SHARED_RE = SHARED.replaceAll(".", "\\.");

/** Deps whose identity review answers `refused` (an Error: can't answer), recording what it is asked. */
function reviewing(refused: string[] | Error, asked: SharedNameText[][] = []): InboxDeps {
  return {
    ...deps,
    judgeSharedNames: async (texts) => {
      asked.push(texts);
      if (refused instanceof Error) throw refused;
      return { refused };
    },
  };
}

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

/** A team with its shared subdomain, a verified receiving domain and a verified sending-only one. */
async function team(slug: string) {
  const teamId = await createTeam(db, slug, { sharedInboxDomain: SHARED });
  const [receiving] = await db
    .insert(schema.domains)
    .values({
      teamId,
      name: `in.${slug}.test`,
      region: "us-east-1",
      status: "verified",
      receivingEnabled: true,
    })
    .returning({ id: schema.domains.id });
  await db
    .insert(schema.domains)
    .values({ teamId, name: `${slug}.test`, region: "us-east-1", status: "verified" });
  return { teamId, domainId: receiving?.id as string, receiving: `in.${slug}.test` };
}

const create = (
  teamId: string,
  input: Parameters<typeof createInbox>[2]["input"],
  extra: Partial<Parameters<typeof createInbox>[2]> = {},
  inboxDeps: InboxDeps = deps,
) =>
  createInbox(db, inboxDeps, {
    teamId,
    plan: "pro",
    isCloud: true,
    actor: api,
    input,
    ...extra,
  });

async function created(teamId: string, input: Parameters<typeof createInbox>[2]["input"]) {
  const result = await create(teamId, input);
  if (!result.ok) throw new Error(result.error.message);
  return result.inbox;
}

const deliveries = (endpointId: string) =>
  db
    .select({ type: schema.webhookDeliveries.eventType, payload: schema.webhookDeliveries.payload })
    .from(schema.webhookDeliveries)
    .where(eq(schema.webhookDeliveries.endpointId, endpointId));

describe("createInbox", () => {
  it("creates an agent inbox on a receiving domain: full object, activity, opt-in event", async () => {
    const t = await team("create-custom");
    const optedIn = await createWebhookEndpoint(db, t.teamId, ["inbox.created"]);
    const everything = await createWebhookEndpoint(db, t.teamId, null);
    const result = await create(t.teamId, {
      email_address: ` Support@${t.receiving.toUpperCase()} `,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.inbox).toMatchObject({
      object: "inbox",
      name: `support@${t.receiving}`,
      email_address: `support@${t.receiving}`,
      domain_id: t.domainId,
      receiving_address: null,
      from_name: null,
      unread: 0,
      drafts: 0,
      last_received: null,
      kind: "agent",
      shared: false,
      expires_at: null,
      quarantined: 0,
      pending_approval: 0,
    });
    expect(await getInboxSafety(db, { teamId: t.teamId, inboxId: result.inbox.id })).toEqual(
      defaultSafety("agent", false),
    );
    const activity = await db
      .select()
      .from(schema.inboxActivity)
      .where(eq(schema.inboxActivity.inboxId, result.inbox.id));
    expect(activity.map((a) => [a.action, a.actor])).toEqual([
      ["inbox.created", `api_key:${(api as { apiKeyId: string }).apiKeyId}`],
    ]);
    const [hook] = await deliveries(optedIn);
    expect(hook?.type).toBe("inbox.created");
    expect(hook?.payload).toMatchObject({
      type: "inbox.created",
      data: { source: "api", inbox_id: result.inbox.id, inbox: { id: result.inbox.id } },
    });
    expect(await deliveries(everything)).toEqual([]);
    // API creations stay out of audit_log; a dashboard one is recorded.
    const audits = () =>
      db
        .select({ action: schema.auditLog.action })
        .from(schema.auditLog)
        .where(eq(schema.auditLog.teamId, t.teamId));
    expect(await audits()).toEqual([]);
    await create(
      t.teamId,
      { email_address: `people@${t.receiving}`, kind: "human" },
      { actor: person },
    );
    expect(await audits()).toEqual([{ action: "inbox.created" }]);
  });

  it("refuses an address in use, a bad local part, a foreign domain and a domain not receiving", async () => {
    const t = await team("create-refusals");
    await created(t.teamId, { email_address: `taken@${t.receiving}` });
    const again = await create(t.teamId, { email_address: `TAKEN@${t.receiving}` });
    expect(again).toEqual({
      ok: false,
      error: {
        status: 409,
        name: "validation_error",
        message: "This address is already used by an inbox",
      },
    });
    for (const local of ["a..b", ".lead", "trail.", "bad!char", "x".repeat(65)]) {
      const bad = await create(t.teamId, { email_address: `${local}@${t.receiving}` });
      expect(bad.ok ? null : bad.error.status, local).toBe(422);
    }
    const foreign = await create(t.teamId, { email_address: "bot@someone-else.test" });
    expect(foreign.ok ? null : foreign.error.message).toBe(
      "email_address must be on a verified domain of this team",
    );
    const sendOnly = await create(t.teamId, { email_address: "bot@create-refusals.test" });
    expect(sendOnly.ok ? null : sendOnly.error.message).toMatch(
      /^Turn on receiving for create-refusals\.test first/,
    );
    const onShared = await create(t.teamId, { email_address: `bot@x.${SHARED}` });
    expect(onShared.ok ? null : onShared.error.message).toMatch(/shared domain/);
    const off = await createInbox(
      db,
      { ...deps, receivingEnabled: false },
      {
        teamId: t.teamId,
        plan: "pro",
        isCloud: true,
        actor: api,
        input: { email_address: `x@${t.receiving}` },
      },
    );
    expect(off.ok ? null : off.error.message).toBe("This instance does not receive mail");
  });

  it("gives a forwarding inbox a receiving address on the team's shared subdomain", async () => {
    const t = await team("create-forwarding");
    const inbox = await created(t.teamId, {
      email_address: "help@create-forwarding.test",
      forwarding: true,
    });
    expect(inbox.shared).toBe(false);
    expect(inbox.receiving_address).toMatch(
      new RegExp(`^fwd-[a-z0-9]{16}@create-forwarding\\.${SHARED.replaceAll(".", "\\.")}$`),
    );
    const noShared = await createInbox(
      db,
      { ...deps, sharedInboxDomain: null },
      {
        teamId: t.teamId,
        plan: "pro",
        isCloud: true,
        actor: api,
        input: { email_address: "other@create-forwarding.test", forwarding: true },
      },
    );
    expect(noShared.ok ? null : noShared.error.status).toBe(422);
  });

  it("makes up a permanent random shared address, whatever the inbox is named", async () => {
    const t = await team("create-shared");
    const inbox = await created(t.teamId, { name: "Signup Bot" });
    expect(inbox.email_address).toMatch(
      new RegExp(`^inbox-[a-z0-9]{8}@create-shared\\.${SHARED_RE}$`),
    );
    expect(inbox).toMatchObject({
      shared: true,
      kind: "agent",
      name: "Signup Bot",
      expires_at: null,
    });
    const safety = await getInboxSafety(db, { teamId: t.teamId, inboxId: inbox.id });
    expect(safety).toMatchObject({ send_policy: "reply_only", send_cap: 50 });
    const brand = await created(t.teamId, { name: "PayPal security" });
    expect(brand.email_address).toMatch(/^inbox-[a-z0-9]{8}@/);
    for (const [expires, ok] of [
      [null, true],
      ["365d", true],
      ["8760h", true],
      ["1h", true],
      ["366d", false],
    ] as const) {
      const result = await create(t.teamId, { expires_in: expires });
      expect(result.ok, String(expires)).toBe(ok);
    }
    const noShared = await createInbox(
      db,
      { ...deps, sharedInboxDomain: null },
      { teamId: t.teamId, plan: "pro", isCloud: true, actor: api, input: {} },
    );
    expect(noShared.ok ? null : noShared.error.message).toMatch(/email_address is required/);
  });

  it("takes a chosen username on the team's subdomain; a taken one answers 409", async () => {
    const t = await team("create-username");
    const leo = await created(t.teamId, { username: " Leo.Bot " });
    expect(leo.email_address).toBe(`leo.bot@create-username.${SHARED}`);
    expect(await create(t.teamId, { username: "leo.bot" })).toEqual({
      ok: false,
      error: {
        status: 409,
        name: "validation_error",
        message: "This address is already used by an inbox",
      },
    });
    // Brands that are everyday words are left to the identity review.
    expect((await created(t.teamId, { username: "tim" })).email_address).toMatch(/^tim@/);
    const both = await create(t.teamId, { username: "desk", email_address: `d@${t.receiving}` });
    expect(both.ok ? null : both.error).toMatchObject({
      status: 422,
      message: "Send username or email_address, not both",
    });
  });

  it("refuses a username off the rules, reserved, in the forwarding shape or imitating a brand, before any write", async () => {
    const t = await team("create-bad-username");
    for (const username of [
      "",
      "-leo",
      "leo-",
      ".leo",
      "a..b",
      "leo+x",
      "50%off",
      "léo",
      "x".repeat(65),
    ]) {
      const result = await create(t.teamId, { username });
      expect(result.ok ? null : result.error.message, username).toMatch(/^username must be 1-64/);
    }
    for (const username of [
      "postmaster",
      "Post-Master",
      "no.reply",
      "mailer_daemon",
      "ROOT",
      "fwd-abc",
      "paypal",
      "pay.pal-support",
      "g00glelogin",
      "microsoft365",
    ]) {
      expect(await create(t.teamId, { username }), username).toEqual({
        ok: false,
        error: {
          status: 422,
          name: "validation_error",
          message: "username can't be used on the shared domain: pick another",
        },
      });
    }
    const late = await create(t.teamId, { username: "fine", expires_in: "366d" });
    expect(late.ok ? null : late.error.status).toBe(422);
    const subs = await db
      .select({ lockedAt: schema.sharedInboxDomains.lockedAt })
      .from(schema.sharedInboxDomains)
      .where(eq(schema.sharedInboxDomains.teamId, t.teamId));
    expect(subs).toEqual([{ lockedAt: null }]);
  });

  it("refuses a brand in from_name on the shared domain only", async () => {
    const t = await team("create-from-brand");
    expect(await create(t.teamId, { from_name: "PayPal Support" })).toEqual({
      ok: false,
      error: {
        status: 422,
        name: "validation_error",
        message: "from_name can't be used on the shared domain: pick another",
      },
    });
    const custom = await created(t.teamId, {
      email_address: `pp@${t.receiving}`,
      from_name: "PayPal Support",
    });
    expect(custom.from_name).toBe("PayPal Support");
    expect((await created(t.teamId, { from_name: "Tim" })).from_name).toBe("Tim");
  });

  it("asks the review about a chosen username and a shared from_name, never about a random address", async () => {
    const t = await team("create-review");
    const asked: SharedNameText[][] = [];
    const chosen = await create(
      t.teamId,
      { username: "Leo", from_name: "Leo Bot", name: "Leo" },
      {},
      reviewing([], asked),
    );
    expect(chosen.ok).toBe(true);
    expect(asked).toEqual([
      [
        { field: "username", value: "leo" },
        { field: "from_name", value: "Leo Bot" },
      ],
    ]);
    asked.length = 0;
    await create(t.teamId, { name: "Random" }, {}, reviewing([], asked));
    await create(
      t.teamId,
      { email_address: `own@${t.receiving}`, from_name: "Own Desk" },
      {},
      reviewing(["Own Desk"], asked),
    );
    expect(asked).toEqual([]);
    const refused = await create(t.teamId, { username: "sly" }, {}, reviewing(["sly"]));
    expect(refused.ok ? null : refused.error.message).toBe(
      "username can't be used on the shared domain: pick another",
    );
    const refusedFrom = await create(
      t.teamId,
      { from_name: "Sly Desk" },
      {},
      reviewing(["Sly Desk"]),
    );
    expect(refusedFrom.ok ? null : refusedFrom.error.message).toBe(
      "from_name can't be used on the shared domain: pick another",
    );
    expect(await create(t.teamId, { username: "later" }, {}, reviewing(new Error("down")))).toEqual(
      {
        ok: false,
        error: {
          status: 503,
          name: "name_review_unavailable",
          message:
            "This name couldn't be reviewed right now: try again shortly, or leave username out for a random address",
          retryAfterSec: 60,
        },
      },
    );
  });

  it("stops reviewing a team's names once 20 were refused today, never the random ones", async () => {
    const t = await team("create-budget");
    const now = new Date();
    await db
      .insert(schema.usageCounters)
      .values({ teamId: t.teamId, day: utcDay(now), sharedNameRefusals: 19 });
    const refuseAll: InboxDeps = {
      ...deps,
      judgeSharedNames: async (texts) => ({ refused: texts.map((text) => text.value) }),
    };
    const last = await create(t.teamId, { username: "one" }, { now }, refuseAll);
    expect(last.ok ? null : last.error.status).toBe(422);
    const asked: SharedNameText[][] = [];
    const spent = await create(t.teamId, { username: "two" }, { now }, reviewing([], asked));
    expect(spent.ok ? null : spent.error).toMatchObject({
      status: 429,
      name: "rate_limit_exceeded",
      message:
        "Too many names were refused today: try again tomorrow, or leave username out for a random address",
    });
    expect(spent.ok ? 0 : (spent.error.retryAfterSec ?? 0)).toBeGreaterThan(0);
    expect(asked).toEqual([]);
    const random = await create(t.teamId, {}, { now }, reviewing([], asked));
    expect(random.ok && random.inbox.email_address).toMatch(/^inbox-[a-z0-9]{8}@create-budget\./);
    const [counter] = await db
      .select({ refusals: schema.usageCounters.sharedNameRefusals })
      .from(schema.usageCounters)
      .where(eq(schema.usageCounters.teamId, t.teamId));
    expect(counter?.refusals).toBe(20);
  });

  it("counts every review against a daily budget, a failed one included, then answers 429", async () => {
    const t = await team("create-reviews");
    const now = new Date();
    await db.insert(schema.usageCounters).values({
      teamId: t.teamId,
      day: utcDay(now),
      sharedNameReviews: SHARED_NAME_REVIEWS_PER_DAY - 1,
    });
    const down = await create(t.teamId, { username: "one" }, { now }, reviewing(new Error("down")));
    expect(down.ok ? null : down.error.status).toBe(503);
    const asked: SharedNameText[][] = [];
    const spent = await create(t.teamId, { username: "two" }, { now }, reviewing([], asked));
    expect(spent.ok ? null : spent.error).toMatchObject({
      status: 429,
      name: "rate_limit_exceeded",
      message:
        "Too many names were reviewed today: try again tomorrow, or leave username out for a random address",
    });
    // A random address needs no review.
    const random = await create(t.teamId, {}, { now }, reviewing([], asked));
    expect(random.ok && random.inbox.email_address).toMatch(/^inbox-[a-z0-9]{8}@create-reviews\./);
    expect(asked).toEqual([]);
    const [counter] = await db
      .select({ reviews: schema.usageCounters.sharedNameReviews })
      .from(schema.usageCounters)
      .where(eq(schema.usageCounters.teamId, t.teamId));
    expect(counter?.reviews).toBe(SHARED_NAME_REVIEWS_PER_DAY);
  });

  it("checks names, from_name and a custom inbox's lifetime", async () => {
    const t = await team("create-fields");
    for (const from of [
      "a@b.test",
      "Acme <x>",
      "Support: now",
      "Call +1 (888) 555-0199",
      "x".repeat(79),
    ]) {
      const result = await create(t.teamId, { email_address: `f@${t.receiving}`, from_name: from });
      expect(result.ok ? null : result.error.status, from).toBe(422);
    }
    const blank = await created(t.teamId, { email_address: `blank@${t.receiving}`, from_name: "" });
    expect(blank.from_name).toBeNull();
    const named = await created(t.teamId, {
      email_address: `named@${t.receiving}`,
      from_name: "  Acme Support  ",
      name: "  Support desk ",
    });
    expect(named).toMatchObject({ from_name: "Acme Support", name: "Support desk" });
    // Resend's limit: 78 characters.
    const long = "Acme Support ".repeat(6);
    const resend = await created(t.teamId, {
      email_address: `long@${t.receiving}`,
      from_name: long,
    });
    expect(resend.from_name).toBe(long.trim());
    const longName = await create(t.teamId, {
      email_address: `n@${t.receiving}`,
      name: "x".repeat(321),
    });
    expect(longName.ok ? null : longName.error.message).toBe(
      "name must be 1-320 characters on one line",
    );
    const tooLong = await create(t.teamId, {
      email_address: `l@${t.receiving}`,
      expires_in: "366d",
    });
    expect(tooLong.ok ? null : tooLong.error.message).toBe("expires_in can be at most 365d");
    const badForm = await create(t.teamId, { email_address: `w@${t.receiving}`, expires_in: "1w" });
    expect(badForm.ok ? null : badForm.error.status).toBe(422);
  });

  it("holds the plan's inbox cap and the hourly creation rate, deleted inboxes counted", async () => {
    const t = await team("create-caps");
    const free = (input: Parameters<typeof createInbox>[2]["input"]) =>
      create(t.teamId, input, { plan: "free" });
    for (const local of ["a", "b", "c"]) {
      expect((await free({ email_address: `${local}@${t.receiving}` })).ok).toBe(true);
    }
    expect(await free({ email_address: `d@${t.receiving}` })).toEqual({
      ok: false,
      error: {
        status: 403,
        name: "validation_error",
        message: "You have reached the inbox limit of your plan. Upgrade to add more.",
      },
    });
    // Self-host never caps.
    expect(
      (
        await create(
          t.teamId,
          { email_address: `e@${t.receiving}` },
          { plan: "free", isCloud: false },
        )
      ).ok,
    ).toBe(true);
    const rated = await team("create-rate");
    for (let n = 0; n < 10; n += 1) {
      await db.insert(schema.inboxActivity).values({
        teamId: rated.teamId,
        inboxId: randomUUID(),
        actor: "system",
        action: "inbox.created",
      });
    }
    const limited = await create(
      rated.teamId,
      { email_address: `x@${rated.receiving}` },
      { plan: "free" },
    );
    expect(limited.ok ? null : limited.error).toMatchObject({
      status: 429,
      name: "rate_limit_exceeded",
    });
    expect(limited.ok ? 0 : (limited.error.retryAfterSec ?? 0)).toBeGreaterThan(3500);
  });

  it("merges safety over the kind's defaults and refuses what safetyProblem refuses", async () => {
    const t = await team("create-safety");
    const human = await created(t.teamId, {
      email_address: `team@${t.receiving}`,
      kind: "human",
      safety: { accept_from: "verified", allowlist: ["Boss@Partner.TEST", "*@vendor.test"] },
    });
    // A new team (no sends yet) steps the human default down from open.
    expect(await getInboxSafety(db, { teamId: t.teamId, inboxId: human.id })).toEqual({
      ...defaultSafety("human", false),
      accept_from: "verified",
      allowlist: ["boss@partner.test", "*@vendor.test"],
      send_policy: "allowlist",
    });
    const openNew = await create(t.teamId, {
      email_address: `open@${t.receiving}`,
      kind: "human",
      safety: { send_policy: "open" },
    });
    expect(openNew.ok ? null : openNew.error.message).toBe(
      'send_policy "open" is not available to a new team yet; use "allowlist" for now',
    );
    const screenedHuman = await create(t.teamId, {
      email_address: `h2@${t.receiving}`,
      kind: "human",
      safety: { screening: true },
    });
    expect(screenedHuman.ok ? null : screenedHuman.error.message).toBe(
      "screening is available on agent inboxes only",
    );
    const openShared = await create(t.teamId, { safety: { send_policy: "open" } });
    expect(openShared.ok ? null : openShared.error.message).toBe(
      "Addresses on the shared domain only reply inside their threads",
    );
    const stranger = await create(t.teamId, {
      email_address: `fw@${t.receiving}`,
      safety: { forward_to: ["someone@else.test"] },
    });
    expect(stranger.ok ? null : stranger.error.message).toMatch(/^forward_to accepts/);
    await db.insert(schema.user).values({ id: "member-1", name: "Ana", email: "Ana@Acme.TEST" });
    await db.insert(schema.teamMembers).values({ teamId: t.teamId, userId: "member-1" });
    const member = await create(t.teamId, {
      email_address: `fw2@${t.receiving}`,
      safety: { forward_to: ["ana@acme.test"] },
    });
    expect(member.ok).toBe(true);
    const unknownKey = await create(t.teamId, {
      email_address: `k@${t.receiving}`,
      safety: { allowlist: ["not an address"] },
    });
    expect(unknownKey.ok ? null : unknownKey.error.message).toMatch(/^safety\.allowlist\.0: /);
  });
});

describe("getInbox and listInboxes", () => {
  it("finds by id or address, hides expired inboxes and other teams' and keys' inboxes", async () => {
    const t = await team("get-inbox");
    const other = await team("get-other");
    const inbox = await created(t.teamId, { email_address: `bot@${t.receiving}` });
    expect((await getInbox(db, { teamId: t.teamId, idOrEmail: inbox.id }))?.id).toBe(inbox.id);
    expect(
      (await getInbox(db, { teamId: t.teamId, idOrEmail: `BOT@${t.receiving.toUpperCase()}` }))?.id,
    ).toBe(inbox.id);
    expect(await getInbox(db, { teamId: other.teamId, idOrEmail: inbox.id })).toBeNull();
    expect(
      await getInbox(db, { teamId: t.teamId, idOrEmail: inbox.id, onlyInboxId: randomUUID() }),
    ).toBeNull();
    expect(await getInbox(db, { teamId: t.teamId, idOrEmail: "not-a-uuid" })).toBeNull();
    await db
      .update(schema.inboxes)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.inboxes.id, inbox.id));
    expect(await getInbox(db, { teamId: t.teamId, idOrEmail: inbox.id })).toBeNull();
  });

  it("lists newest first with keyset paging, a kind filter and one inbox for a scoped key", async () => {
    const t = await team("list-inbox");
    const ids: string[] = [];
    for (const [n, kind] of [
      [1, "agent"],
      [2, "human"],
      [3, "agent"],
      [4, "agent"],
    ] as const) {
      const inbox = await created(t.teamId, { email_address: `l${n}@${t.receiving}`, kind });
      ids.push(inbox.id);
      await db
        .update(schema.inboxes)
        .set({ createdAt: new Date(Date.UTC(2026, 0, n)) })
        .where(eq(schema.inboxes.id, inbox.id));
    }
    const [i1, i2, i3, i4] = ids as [string, string, string, string];
    const page = await listInboxes(db, { teamId: t.teamId, query: { limit: 2 } });
    if (page === "bad_cursor") throw new Error("bad cursor");
    expect(page.data.map((i) => i.id)).toEqual([i4, i3]);
    expect(page.hasMore).toBe(true);
    expect(page.data[0]).toEqual({
      id: i4,
      name: `l4@${t.receiving}`,
      email_address: `l4@${t.receiving}`,
      from_name: null,
      unread: 0,
      last_received: null,
      kind: "agent",
      shared: false,
      expires_at: null,
    });
    const next = await listInboxes(db, { teamId: t.teamId, query: { limit: 2, after: i3 } });
    expect(next !== "bad_cursor" && next.data.map((i) => i.id)).toEqual([i2, i1]);
    const back = await listInboxes(db, { teamId: t.teamId, query: { limit: 2, before: i2 } });
    expect(back !== "bad_cursor" && back.data.map((i) => i.id)).toEqual([i4, i3]);
    const humans = await listInboxes(db, { teamId: t.teamId, query: {}, kind: "human" });
    expect(humans !== "bad_cursor" && humans.data.map((i) => i.id)).toEqual([i2]);
    const scoped = await listInboxes(db, { teamId: t.teamId, query: {}, onlyInboxId: i1 });
    expect(scoped !== "bad_cursor" && scoped.data.map((i) => i.id)).toEqual([i1]);
    expect(await listInboxes(db, { teamId: t.teamId, query: { after: randomUUID() } })).toBe(
      "bad_cursor",
    );
  });
});

describe("updateInbox and updateInboxSafety", () => {
  it("renames, renews and announces; refuses expired inboxes", async () => {
    const t = await team("update-inbox");
    const hook = await createWebhookEndpoint(db, t.teamId, ["inbox.updated"]);
    const inbox = await created(t.teamId, { email_address: `u@${t.receiving}` });
    const result = await updateInbox(db, deps, {
      teamId: t.teamId,
      inboxId: inbox.id,
      actor: person,
      patch: { name: "Desk", from_name: "Acme Desk", expires_in: "7d" },
      mayShorten: true,
    });
    expect(result.ok && result.inbox).toMatchObject({ name: "Desk", from_name: "Acme Desk" });
    expect(result.ok && result.inbox.expires_at).toBeTruthy();
    const cleared = await updateInbox(db, deps, {
      teamId: t.teamId,
      inboxId: inbox.id,
      actor: person,
      patch: { from_name: "", expires_in: null },
      mayShorten: false,
    });
    expect(cleared.ok && cleared.inbox).toMatchObject({ from_name: null, expires_at: null });
    // Expiring sooner deletes the inbox sooner: owners and admins only, as delete is.
    const sooner = await updateInbox(db, deps, {
      teamId: t.teamId,
      inboxId: inbox.id,
      actor: person,
      patch: { expires_in: "1h" },
      mayShorten: false,
    });
    expect(sooner.ok ? null : sooner.error).toMatchObject({ status: 403, name: "forbidden" });
    const [first] = await deliveries(hook);
    expect(first?.payload).toMatchObject({
      data: { source: "dashboard", inbox: { name: "Desk" } },
    });
    await db
      .update(schema.inboxes)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.inboxes.id, inbox.id));
    const gone = await updateInbox(db, deps, {
      teamId: t.teamId,
      inboxId: inbox.id,
      actor: person,
      patch: { name: "x" },
      mayShorten: true,
    });
    expect(gone.ok ? null : gone.error).toEqual({
      status: 404,
      name: "not_found",
      message: "Inbox not found.",
    });
  });

  it("takes back a name defaulted to a long address, unchanged or set again after a rename", async () => {
    const t = await team("update-long-name");
    const inbox = await created(t.teamId, { username: "x".repeat(64) });
    expect(inbox.name).toBe(inbox.email_address);
    expect(inbox.name.length).toBeGreaterThan(64);
    const rename = (name: string) =>
      updateInbox(db, deps, {
        teamId: t.teamId,
        inboxId: inbox.id,
        actor: api,
        patch: { name },
        mayShorten: false,
      });
    expect((await rename(inbox.name)).ok).toBe(true);
    expect((await rename("Desk")).ok).toBe(true);
    const back = await rename(inbox.email_address);
    expect(back.ok && back.inbox.name).toBe(inbox.email_address);
  });

  it("lets a shared inbox live forever, and reviews a new shared from_name, never a custom one", async () => {
    const t = await team("update-shared");
    const inbox = await created(t.teamId, {});
    const update = (
      patch: Parameters<typeof updateInbox>[2]["patch"],
      inboxDeps: InboxDeps = deps,
      inboxId = inbox.id,
    ) =>
      updateInbox(db, inboxDeps, {
        teamId: t.teamId,
        inboxId,
        actor: person,
        patch,
        mayShorten: false,
      });
    // Any date on a permanent inbox is sooner: owners and admins only.
    expect((await update({ expires_in: "7d" })).ok).toBe(false);
    await db
      .update(schema.inboxes)
      .set({ expiresAt: new Date(Date.now() + DAY) })
      .where(eq(schema.inboxes.id, inbox.id));
    const forever = await update({ expires_in: null });
    expect(forever.ok && forever.inbox.expires_at).toBeNull();
    expect(await update({ from_name: "Netflix Billing" })).toEqual({
      ok: false,
      error: {
        status: 422,
        name: "validation_error",
        message: "from_name can't be used on the shared domain: pick another",
      },
    });
    const asked: SharedNameText[][] = [];
    expect((await update({ from_name: "Leo Desk", name: "Desk" }, reviewing([], asked))).ok).toBe(
      true,
    );
    expect(asked).toEqual([[{ field: "from_name", value: "Leo Desk" }]]);
    asked.length = 0;
    // Repeating the stored name asks nothing, so it never waits on the review either.
    expect((await update({ from_name: "Leo Desk" }, reviewing(new Error("down"), asked))).ok).toBe(
      true,
    );
    expect(asked).toEqual([]);
    expect((await update({ name: "Renamed", from_name: "" }, reviewing([], asked))).ok).toBe(true);
    expect(asked).toEqual([]);
    const refused = await update({ from_name: "Sly Desk" }, reviewing(["Sly Desk"]));
    expect(refused.ok ? null : refused.error.message).toBe(
      "from_name can't be used on the shared domain: pick another",
    );
    const down = await update({ from_name: "Later Desk" }, reviewing(new Error("down")));
    expect(down.ok ? null : down.error).toMatchObject({ status: 503, retryAfterSec: 60 });
    const custom = await created(t.teamId, { email_address: `c@${t.receiving}` });
    const own = await update(
      { from_name: "Netflix Billing" },
      reviewing(["Netflix Billing"], asked),
      custom.id,
    );
    expect(own.ok && own.inbox.from_name).toBe("Netflix Billing");
    expect(asked).toEqual([]);
  });

  it("merges a safety patch, refuses a bad one and records activity and audit", async () => {
    const t = await team("update-safety");
    const hook = await createWebhookEndpoint(db, t.teamId, ["inbox.updated"]);
    const inbox = await created(t.teamId, { email_address: `s@${t.receiving}` });
    const result = await updateInboxSafety(db, deps, {
      teamId: t.teamId,
      inboxId: inbox.id,
      actor: api,
      patch: { accept_from: "allowlist", allowlist: ["A@B.test"], send_cap: 10 },
      plan: "pro",
      isCloud: true,
    });
    expect(result).toEqual({
      ok: true,
      safety: {
        ...defaultSafety("agent", false),
        accept_from: "allowlist",
        allowlist: ["a@b.test"],
        send_cap: 10,
      },
    });
    const bad = await updateInboxSafety(db, deps, {
      teamId: t.teamId,
      inboxId: inbox.id,
      actor: api,
      patch: { send_cap: 0 },
      plan: "pro",
      isCloud: true,
    });
    expect(bad.ok ? null : bad.error.status).toBe(422);
    expect((await getInboxSafety(db, { teamId: t.teamId, inboxId: inbox.id }))?.send_cap).toBe(10);
    const actions = await db
      .select({ action: schema.inboxActivity.action })
      .from(schema.inboxActivity)
      .where(eq(schema.inboxActivity.inboxId, inbox.id));
    expect(actions.map((a) => a.action)).toEqual(["inbox.created", "inbox.safety_updated"]);
    const [audit] = await db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.teamId, t.teamId),
          eq(schema.auditLog.action, "inbox.safety_updated"),
        ),
      );
    expect(audit?.data).toEqual({ fields: ["accept_from", "allowlist", "send_cap"] });
    expect((await deliveries(hook)).map((d) => d.type)).toEqual(["inbox.updated"]);
  });

  it("takes open on a shared inbox only while the team's shared mode is open", async () => {
    const t = await team("open-shared");
    // Past the new tier, so only the shared mode decides.
    await db.insert(schema.teamMonitor).values({
      teamId: t.teamId,
      sentTotal: 100_000,
      firstSendAt: new Date(Date.now() - 200 * DAY),
    });
    const inbox = await created(t.teamId, {});
    const open = (plan: "free" | "pro") =>
      updateInboxSafety(db, deps, {
        teamId: t.teamId,
        inboxId: inbox.id,
        actor: api,
        patch: { send_policy: "open" },
        plan,
        isCloud: true,
      });
    const refusal = async (plan: "free" | "pro") => {
      const result = await open(plan);
      return result.ok ? null : result.error.message;
    };
    expect(await refusal("pro")).toBe(
      "Addresses on the shared domain only reply inside their threads",
    );
    vi.stubEnv("SHARED_INBOX_OPEN", "true");
    vi.stubEnv("ABUSE_JUDGE", "typesafe");
    try {
      expect(await refusal("free")).toBe(
        "On the Free plan, addresses on the shared domain only reply inside their threads",
      );
      expect((await open("pro")).ok).toBe(true);
      const createdOpen = await create(t.teamId, { safety: { send_policy: "open" } });
      expect(createdOpen.ok && createdOpen.inbox.email_address).toMatch(/^inbox-/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("deleteInboxes and expireInboxes", () => {
  async function received(teamId: string, catchAll: boolean) {
    const [row] = await db
      .insert(schema.receivedEmails)
      .values({
        teamId,
        domainIds: [],
        rawSha256: createHash("sha256").update(randomBytes(16)).digest("hex"),
        messageId: `<${randomUUID()}@sender.test>`,
        from: "sender@sender.test",
        receivedFor: ["x@y.test"],
        envelope: { mailFrom: "", clientIp: "192.0.2.1", helo: "h", tls: null },
        authentication: { spf: "pass", dkim: "pass", dmarc: "pass", arc: "none" },
        sizeBytes: 10,
        catchAll,
      })
      .returning({ id: schema.receivedEmails.id });
    return row?.id as string;
  }

  async function member(teamId: string, inboxId: string, receivedEmailId: string) {
    const [thread] = await db
      .insert(schema.inboxThreads)
      .values({ teamId, inboxId })
      .returning({ id: schema.inboxThreads.id });
    await db.insert(schema.receivedEmailInboxes).values({
      receivedEmailId,
      inboxId,
      teamId,
      threadId: thread?.id as string,
      address: "x@y.test",
      senderTrust: "external",
      verdict: "clean",
      deliveredAt: new Date(),
    });
  }

  it("revokes keys, removes mail only it held, prunes endpoint filters and announces", async () => {
    const t = await team("delete-inbox");
    const gone = await created(t.teamId, { email_address: `gone@${t.receiving}` });
    const kept = await created(t.teamId, { email_address: `kept@${t.receiving}` });
    const key = generateApiKey();
    const [scopedKey] = await db
      .insert(schema.apiKeys)
      .values({
        teamId: t.teamId,
        name: "agent",
        tokenPrefix: key.tokenPrefix,
        keyHash: key.keyHash,
        last4: key.last4,
        inboxId: gone.id,
      })
      .returning({ id: schema.apiKeys.id });
    const only = await received(t.teamId, false);
    const catchAll = await received(t.teamId, true);
    const shared = await received(t.teamId, false);
    await member(t.teamId, gone.id, only);
    await member(t.teamId, gone.id, catchAll);
    await member(t.teamId, gone.id, shared);
    await member(t.teamId, kept.id, shared);
    const filtered = await createWebhookEndpoint(db, t.teamId, ["inbox.deleted"]);
    await db
      .update(schema.webhookEndpoints)
      .set({ inboxIds: [gone.id] })
      .where(eq(schema.webhookEndpoints.id, filtered));
    const both = await createWebhookEndpoint(db, t.teamId, ["inbox.deleted"]);
    await db
      .update(schema.webhookEndpoints)
      .set({ inboxIds: [gone.id, kept.id] })
      .where(eq(schema.webhookEndpoints.id, both));

    expect(
      await deleteInboxes(db, deps, {
        teamId: t.teamId,
        inboxIds: [gone.id],
        actor: person,
        reason: "deleted",
      }),
    ).toBe(1);
    const [revoked] = await db
      .select()
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.id, scopedKey?.id as string));
    expect(revoked?.revokedAt).not.toBeNull();
    expect(revoked?.inboxId).toBeNull();
    const remaining = await db
      .select({ id: schema.receivedEmails.id })
      .from(schema.receivedEmails)
      .where(eq(schema.receivedEmails.teamId, t.teamId));
    expect(remaining.map((r) => r.id).sort()).toEqual([catchAll, shared].sort());
    const endpoints = await db
      .select({ id: schema.webhookEndpoints.id, inboxIds: schema.webhookEndpoints.inboxIds })
      .from(schema.webhookEndpoints)
      .where(eq(schema.webhookEndpoints.teamId, t.teamId));
    expect(Object.fromEntries(endpoints.map((e) => [e.id, e.inboxIds]))).toEqual({
      [filtered]: [],
      [both]: [kept.id],
    });
    const [event] = await deliveries(filtered);
    expect(event?.payload).toEqual({
      type: "inbox.deleted",
      created_at: expect.any(String),
      data: { source: "dashboard", inbox_id: gone.id },
    });
    expect(await getInbox(db, { teamId: t.teamId, idOrEmail: gone.id })).toBeNull();
    const [audit] = await db
      .select({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(
        and(eq(schema.auditLog.teamId, t.teamId), eq(schema.auditLog.action, "inbox.deleted")),
      );
    expect(audit).toBeDefined();
    // Another team's ids delete nothing.
    const stranger = await team("delete-stranger");
    expect(
      await deleteInboxes(db, deps, {
        teamId: stranger.teamId,
        inboxIds: [kept.id],
        actor: api,
        reason: "deleted",
      }),
    ).toBe(0);
  });

  it("sweeps shared inboxes unused for 90 days as expired, whatever their expiry, and keeps any used since", async () => {
    const t = await team("idle-sweep");
    const hook = await createWebhookEndpoint(db, t.teamId, ["inbox.expired", "inbox.deleted"]);
    const idle = await created(t.teamId, { expires_in: "365d" });
    const used = await created(t.teamId, {});
    const custom = await created(t.teamId, { email_address: `idle@${t.receiving}` });
    const forwarding = await created(t.teamId, {
      email_address: "fw@idle-sweep.test",
      forwarding: true,
    });
    const now = new Date();
    await db
      .update(schema.inboxes)
      .set({ lastUsedAt: new Date(now.getTime() - 91 * DAY) })
      .where(inArray(schema.inboxes.id, [idle.id, used.id, custom.id, forwarding.id]));
    await touchInbox(db, used.id, now);
    expect(await expireInboxes(db, deps, now)).toBeGreaterThanOrEqual(1);
    expect(await getInbox(db, { teamId: t.teamId, idOrEmail: idle.id })).toBeNull();
    for (const kept of [used, custom, forwarding]) {
      expect(
        await getInbox(db, { teamId: t.teamId, idOrEmail: kept.id }),
        kept.email_address,
      ).not.toBeNull();
    }
    expect((await deliveries(hook)).map((d) => d.type)).toEqual(["inbox.expired", "inbox.deleted"]);
  });

  it("deletes as expired only an inbox still due under its row lock", async () => {
    const t = await team("idle-race");
    const inbox = await created(t.teamId, {});
    expect(
      await deleteInboxes(db, deps, {
        teamId: t.teamId,
        inboxIds: [inbox.id],
        actor: { kind: "system" },
        reason: "expired",
        now: new Date(),
      }),
    ).toBe(0);
    expect(await getInbox(db, { teamId: t.teamId, idOrEmail: inbox.id })).not.toBeNull();
  });

  it("expires inboxes past expires_at with inbox.expired, then inbox.deleted", async () => {
    const t = await team("expire-inbox");
    const hook = await createWebhookEndpoint(db, t.teamId, ["inbox.expired", "inbox.deleted"]);
    const old = await created(t.teamId, { email_address: `old@${t.receiving}`, expires_in: "1h" });
    const fresh = await created(t.teamId, {
      email_address: `new@${t.receiving}`,
      expires_in: "1h",
    });
    const key = generateApiKey();
    const [agentKey] = await db
      .insert(schema.apiKeys)
      .values({
        teamId: t.teamId,
        name: "agent",
        tokenPrefix: key.tokenPrefix,
        keyHash: key.keyHash,
        last4: key.last4,
        inboxId: old.id,
      })
      .returning({ id: schema.apiKeys.id });
    await db
      .update(schema.inboxes)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.inboxes.id, old.id));
    // The sweep spans every team; other suites leave expired inboxes behind too.
    expect(await expireInboxes(db, deps, new Date())).toBeGreaterThanOrEqual(1);
    expect(await expireInboxes(db, deps, new Date())).toBe(0);
    expect((await deliveries(hook)).map((d) => d.type)).toEqual(["inbox.expired", "inbox.deleted"]);
    const [expired] = await deliveries(hook);
    expect(expired?.payload).toMatchObject({
      data: {
        source: "system",
        inbox_id: old.id,
        inbox: { id: old.id, email_address: old.email_address },
      },
    });
    expect(await getInbox(db, { teamId: t.teamId, idOrEmail: fresh.id })).not.toBeNull();
    const [revoked] = await db
      .select({ revokedAt: schema.apiKeys.revokedAt, inboxId: schema.apiKeys.inboxId })
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.id, agentKey?.id as string));
    expect(revoked?.revokedAt).not.toBeNull();
    expect(revoked?.inboxId).toBeNull();
    const [activity] = await db
      .select({ action: schema.inboxActivity.action, actor: schema.inboxActivity.actor })
      .from(schema.inboxActivity)
      .where(
        and(
          eq(schema.inboxActivity.inboxId, old.id),
          eq(schema.inboxActivity.action, "inbox.expired"),
        ),
      );
    expect(activity).toEqual({ action: "inbox.expired", actor: "system" });
  });
});
