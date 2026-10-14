import {
  generateApiKey,
  SHARED_REFUSALS,
  SHARED_REPLY_ONLY_MESSAGE,
  utcDay,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTestDb } from "@millionsend/test-utils";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  addInbox,
  establish,
  type InboxRow,
  seedWorld,
  type World,
} from "../../../packages/core/test/inbox-send-fixtures.js";
import { createApi, RESTRICTED_DOMAIN_MESSAGE } from "../src/app.js";

let db: Db;
let close: () => Promise<void>;
let w: World;
let app: ReturnType<typeof createApi>;
let teamKey: string;
let domainKey: string;
let inbox: InboxRow;

async function addKey(values: Partial<typeof schema.apiKeys.$inferInsert> = {}) {
  const key = generateApiKey();
  await db.insert(schema.apiKeys).values({
    teamId: w.teamId,
    name: "k",
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
    ...values,
  });
  return key.token;
}

const call = (token: string, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const json = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  w = await seedWorld(db, "shared-api");
  app = createApi({
    ...w.deps,
    receiving: { mxHost: "mx.example.test", ingestSecret: "s".repeat(40) },
    sharedInboxDomain: w.sharedDomain,
  });
  teamKey = await addKey();
  domainKey = await addKey({ domainId: w.domainId });
  inbox = await addInbox(w, { local: "leo", kind: "human", shared: true, fromName: "Leo Bot" });
});
afterAll(() => close());
afterEach(() => {
  vi.unstubAllEnvs();
});

/** Both switches on and a judge configured: open sending, as an operator turns it on. */
function openSending() {
  vi.stubEnv("SHARED_INBOX_OPEN", "true");
  vi.stubEnv("ABUSE_JUDGE", "typesafe");
}

const message = { to: "ana@example.org", subject: "Hi", text: "Hello" };
const sendFromInbox = (body: Record<string, unknown> = {}, token = teamKey) =>
  call(token, "POST", "/emails", { from: inbox.emailAddress, ...message, ...body });

const sharedToday = async () => {
  const uc = schema.usageCounters;
  const [row] = await db
    .select({ n: uc.sharedRecipients })
    .from(uc)
    .where(and(eq(uc.teamId, w.teamId), eq(uc.day, utcDay())));
  return row?.n ?? 0;
};

describe("POST /emails from a shared address", () => {
  it("sends from the inbox in open mode, threaded and charged to the team; the batch still refuses it", async () => {
    openSending();
    const before = await sharedToday();
    const res = await sendFromInbox();
    expect(res.status).toBe(200);
    const { id } = await json<{ id: string }>(res);
    const [row] = await db.select().from(schema.emails).where(eq(schema.emails.id, id));
    expect(row).toMatchObject({ inboxId: inbox.id, domainId: null, firstContact: true });
    expect(row?.threadId).not.toBeNull();
    expect(await sharedToday()).toBe(before + 1);
    const batch = await call(teamKey, "POST", "/emails/batch", [
      { from: inbox.emailAddress, ...message },
    ]);
    expect(batch.status).toBe(403);
    expect(await json(batch)).toMatchObject({
      name: "inbox_send_policy",
      message: `emails.0: ${SHARED_REPLY_ONLY_MESSAGE}`,
    });
  });

  it("keeps the up-front 403 outside open mode, naming what holds the team back", async () => {
    const teams = schema.teams;
    openSending();
    await db.update(teams).set({ plan: "free" }).where(eq(teams.id, w.teamId));
    try {
      const free = await sendFromInbox();
      expect(free.status).toBe(403);
      expect(await json(free)).toMatchObject({
        name: "inbox_send_policy",
        message: SHARED_REFUSALS.shared_plan.message,
      });
    } finally {
      await db.update(teams).set({ plan: "pro" }).where(eq(teams.id, w.teamId));
    }
    vi.stubEnv("SHARED_INBOX_SEND", "false");
    const paused = await sendFromInbox();
    expect(paused.status).toBe(403);
    expect(await json(paused)).toMatchObject({
      name: "inbox_send_policy",
      message: SHARED_REFUSALS.shared_paused.message,
    });
  });

  it("holds the From to the inbox's own address and display name, without the fields its endpoints never send", async () => {
    openSending();
    const domain = inbox.emailAddress.slice(inbox.emailAddress.indexOf("@") + 1);
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ from: `leo+news@${domain}` }, /with no \+tag/],
      [{ from: `Support <${inbox.emailAddress}>` }, /display name/],
      [{ scheduled_at: "in 1 hour" }, /^scheduled_at /],
      [{ reply_to: "other@example.org" }, /^reply_to /],
      [{ attachments: [{ filename: "a.txt", content: "aGk=" }] }, /^attachments /],
      [{ headers: { "X-Campaign": "1" } }, /^headers /],
    ];
    for (const [body, rule] of cases) {
      const res = await sendFromInbox(body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(await json(res)).toMatchObject({
        name: "validation_error",
        message: expect.stringMatching(rule),
      });
    }
    expect((await sendFromInbox({ from: `Leo Bot <${inbox.emailAddress}>` })).status).toBe(200);
  });

  it("refuses a key held to one of the team's domains with restricted_api_key", async () => {
    openSending();
    const res = await sendFromInbox({}, domainKey);
    expect(res.status).toBe(403);
    expect(await json(res)).toMatchObject({
      name: "restricted_api_key",
      message: RESTRICTED_DOMAIN_MESSAGE,
    });
  });

  it("answers the team's daily cap with 429 and retry-after, and an 11th recipient with 422", async () => {
    openSending();
    vi.stubEnv("SHARED_INBOX_TEAM_DAILY_CAP", String(await sharedToday()));
    const capped = await sendFromInbox();
    expect(capped.status).toBe(429);
    expect(await json(capped)).toMatchObject({
      name: "inbox_send_cap_reached",
      message: SHARED_REFUSALS.shared_team_cap.message,
    });
    expect(Number(capped.headers.get("retry-after"))).toBeGreaterThan(0);
    vi.stubEnv("SHARED_INBOX_TEAM_DAILY_CAP", "1000");
    const many = await sendFromInbox({
      to: Array.from({ length: 11 }, (_, i) => `r${i}@example.org`),
    });
    expect(many.status).toBe(422);
    expect(await json(many)).toMatchObject({
      name: "validation_error",
      message: SHARED_REFUSALS.shared_recipients.message,
    });
  });
});

describe("safety rules on the shared domain", () => {
  it("refuses send_policy allowlist outright, and open while the team's mode is not open (422)", async () => {
    const shared = await addInbox(w, { local: "rules", shared: true });
    const patch = (body: Record<string, unknown>) =>
      call(teamKey, "PATCH", `/inboxes/${shared.id}/safety`, body);
    const allowlist = await patch({ send_policy: "allowlist" });
    expect(allowlist.status).toBe(422);
    expect(await json(allowlist)).toMatchObject({
      name: "validation_error",
      message:
        'send_policy "allowlist" is not available on the shared domain: there the allowlist counts for incoming mail only',
    });
    const open = await patch({ send_policy: "open" });
    expect(open.status).toBe(422);
    expect(await json(open)).toMatchObject({
      name: "validation_error",
      message: SHARED_REPLY_ONLY_MESSAGE,
    });
    openSending();
    await establish(w);
    const opened = await patch({ send_policy: "open" });
    expect(opened.status).toBe(200);
    expect(await json(opened)).toMatchObject({ send_policy: "open" });
  });
});
