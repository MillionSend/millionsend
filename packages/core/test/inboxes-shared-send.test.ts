import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTestDb } from "@millionsend/test-utils";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type AcceptEmailPayload, acceptEmail } from "../src/accept-email.js";
import type { InboxActor } from "../src/inboxes/activity.js";
import { createDraft, sendDraft, updateDraft } from "../src/inboxes/drafts.js";
import {
  beginInboxAccept,
  refundInboxAccept,
  replyInThread,
  type SendOutcome,
  sendNewFromInbox,
} from "../src/inboxes/send.js";
import { SHARED_REFUSALS, type SharedRefusalReason } from "../src/inboxes/send-policy.js";
import { resolveMonitorSettings } from "../src/monitor-settings.js";
import { DAY_MS, utcDay } from "../src/utc-day.js";
import {
  addInbox,
  addThread,
  billing,
  establish,
  type InboxRow,
  receive,
  seedWorld,
  type World,
} from "./inbox-send-fixtures.js";

let db: Db;
let close: () => Promise<void>;

const USER: InboxActor = { kind: "user", userId: "u1" };
const TEAM_KEY: InboxActor = {
  kind: "api_key",
  apiKeyId: "00000000-0000-4000-8000-000000000001",
  inboxId: null,
};

beforeAll(async () => {
  ({ db, close } = await createTestDb());
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

const sent = (o: SendOutcome) => {
  if (o.kind !== "sent") throw new Error(`expected a send, got ${JSON.stringify(o)}`);
  return o;
};
const drafted = (o: SendOutcome) => {
  if (o.kind !== "draft") throw new Error(`expected a draft, got ${JSON.stringify(o)}`);
  return o.draft;
};
const refusedFor = (reason: SharedRefusalReason) => ({
  kind: "refused",
  error: { ...SHARED_REFUSALS[reason] },
});

const sendNew = async (w: World, inbox: InboxRow, to: string[], actor: InboxActor = USER) =>
  sendNewFromInbox(db, w.deps, {
    teamId: w.teamId,
    billing: await billing(w),
    actor,
    inboxId: inbox.id,
    message: { to, subject: "Hello", text: "Hi there" },
  });

const auth = async (w: World) => ({
  teamId: w.teamId,
  billing: await billing(w),
  apiKeyId: "00000000-0000-4000-8000-000000000001",
  inboxId: null,
});

const emailRow = async (id: string) => {
  const [row] = await db.select().from(schema.emails).where(eq(schema.emails.id, id));
  return row;
};

const sharedToday = async (w: World) => {
  const uc = schema.usageCounters;
  const [row] = await db
    .select({ n: uc.sharedRecipients })
    .from(uc)
    .where(and(eq(uc.teamId, w.teamId), eq(uc.day, utcDay())));
  return row?.n ?? 0;
};

describe("the shared domain's mode, on every inbox send", () => {
  it("lets a paid team start a conversation in open mode, as a first contact in a sent thread", async () => {
    const w = await seedWorld(db, "open-paid");
    const inbox = await addInbox(w, { local: "leo", kind: "human", shared: true });
    expect(await sendNew(w, inbox, ["ana@example.org"])).toMatchObject(refusedFor("shared_domain"));
    openSending();
    const out = sent(await sendNew(w, inbox, ["ana@example.org"]));
    const row = await emailRow(out.email.id);
    expect(row).toMatchObject({ inboxId: inbox.id, domainId: null, firstContact: true });
    expect(row?.threadId).not.toBeNull();
  });

  it("answers every mode below open with its own cause, a thread reply too while sending is paused", async () => {
    const w = await seedWorld(db, "below-open");
    const inbox = await addInbox(w, { local: "leo", kind: "human", shared: true });
    const teams = schema.teams;
    openSending();
    await db.update(teams).set({ plan: "free" }).where(eq(teams.id, w.teamId));
    expect(await sendNew(w, inbox, ["ana@example.org"])).toMatchObject(refusedFor("shared_plan"));
    // A paid plan past its grace reads as Free.
    await db
      .update(teams)
      .set({ plan: "pro", currentPeriodEnd: new Date(Date.now() - 30 * DAY_MS) })
      .where(eq(teams.id, w.teamId));
    expect(await sendNew(w, inbox, ["ana@example.org"])).toMatchObject(refusedFor("shared_plan"));
    await db.update(teams).set({ currentPeriodEnd: null }).where(eq(teams.id, w.teamId));
    vi.stubEnv("ABUSE_JUDGE", "off");
    expect(await sendNew(w, inbox, ["ana@example.org"])).toMatchObject(refusedFor("shared_domain"));
    vi.stubEnv("SHARED_INBOX_SEND", "false");
    const threadId = await addThread(w, inbox.id);
    const received = await receive(w, { inbox, threadId });
    expect(
      await replyInThread(db, w.deps, {
        teamId: w.teamId,
        billing: await billing(w),
        actor: USER,
        inboxId: inbox.id,
        threadId,
        emailId: received.id,
        body: { text: "Thanks" },
      }),
    ).toMatchObject(refusedFor("shared_paused"));
  });

  it("has an agent follow send_policy in open mode, read as reply_only while its team is new", async () => {
    const fresh = await seedWorld(db, "open-new-team");
    const known = await seedWorld(db, "open-known-team");
    await establish(known);
    openSending();
    const open = { send_policy: "open" as const };
    const to = ["ana@example.org"];
    const newBot = await addInbox(fresh, { local: "bot", shared: true, safety: open });
    expect(drafted(await sendNew(fresh, newBot, to, TEAM_KEY)).approval_reasons).toEqual([
      "send_policy",
    ]);
    const careful = await addInbox(known, { local: "careful", shared: true });
    expect(drafted(await sendNew(known, careful, to, TEAM_KEY)).approval_reasons).toEqual([
      "send_policy",
    ]);
    const bot = await addInbox(known, { local: "bot", shared: true, safety: open });
    sent(await sendNew(known, bot, to, TEAM_KEY));
  });

  it("never counts the allowlist on the shared domain: an allowlisted address is still a first contact", async () => {
    const w = await seedWorld(db, "shared-allowlist");
    await establish(w);
    openSending();
    const inbox = await addInbox(w, {
      local: "bot",
      shared: true,
      safety: { send_policy: "open", allowlist: ["*@example.org"] },
    });
    const out = sent(await sendNew(w, inbox, ["ana@example.org"], TEAM_KEY));
    expect((await emailRow(out.email.id))?.firstContact).toBe(true);
  });

  it("keeps an inbox replying only while its display name, address or team label fails the guards", async () => {
    const w = await seedWorld(db, "brand-names");
    openSending();
    const to = ["ana@example.org"];
    const named = await addInbox(w, {
      local: "help",
      kind: "human",
      shared: true,
      fromName: "PayPal Support",
    });
    expect(await sendNew(w, named, to)).toMatchObject(refusedFor("shared_domain"));
    const threadId = await addThread(w, named.id);
    const received = await receive(w, { inbox: named, threadId });
    const reply = await replyInThread(db, w.deps, {
      teamId: w.teamId,
      billing: await billing(w),
      actor: USER,
      inboxId: named.id,
      threadId,
      emailId: received.id,
      body: { text: "Thanks" },
    });
    expect(reply.kind).toBe("sent");
    const labelled = await addInbox(w, { local: "desk", kind: "human", shared: true });
    await db
      .update(schema.inboxes)
      .set({ emailAddress: `desk@paypalsupport.${w.sharedDomain}` })
      .where(eq(schema.inboxes.id, labelled.id));
    expect(await sendNew(w, labelled, to)).toMatchObject(refusedFor("shared_domain"));
    // Issued before the guards: a local part made from an inbox name, a reserved label.
    const legacy = await addInbox(w, { local: "appleid-ab12", kind: "human", shared: true });
    expect(await sendNew(w, legacy, to)).toMatchObject(refusedFor("shared_domain"));
    const reserved = await addInbox(w, { local: "verify", kind: "human", shared: true });
    await db
      .update(schema.inboxes)
      .set({ emailAddress: `verify@security.${w.sharedDomain}` })
      .where(eq(schema.inboxes.id, reserved.id));
    expect(await sendNew(w, reserved, to)).toMatchObject(refusedFor("shared_domain"));
    // A person's name that is also an everyday brand word is the identity review's call.
    const tim = await addInbox(w, { local: "tim", kind: "human", shared: true, fromName: "Tim" });
    sent(await sendNew(w, tim, to));
  });
});

describe("the team's daily cap on mail from the shared domain", () => {
  it("refuses past the cap, approved sends included, and inbox churn never resets it", async () => {
    const w = await seedWorld(db, "team-cap");
    openSending();
    vi.stubEnv("SHARED_INBOX_TEAM_DAILY_CAP", "3");
    const first = await addInbox(w, { local: "first", kind: "human", shared: true });
    sent(await sendNew(w, first, ["a1@example.org", "a2@example.org"]));
    expect(await sharedToday(w)).toBe(2);
    const over = await sendNew(w, first, ["a3@example.org", "a4@example.org"]);
    expect(over).toMatchObject(refusedFor("shared_team_cap"));
    expect(over.kind === "refused" && over.error.retryAfterSec).toBeGreaterThan(0);
    await db.delete(schema.inboxes).where(eq(schema.inboxes.id, first.id));
    const second = await addInbox(w, { local: "second", kind: "human", shared: true });
    expect(await sendNew(w, second, ["b1@example.org", "b2@example.org"])).toMatchObject(
      refusedFor("shared_team_cap"),
    );
    sent(await sendNew(w, second, ["b1@example.org"]));
    expect(await sharedToday(w)).toBe(3);
  });

  it("charges with a guarded upsert: a race past the cap, or one send over it, writes nothing", async () => {
    const w = await seedWorld(db, "team-cap-race");
    vi.stubEnv("SHARED_INBOX_TEAM_DAILY_CAP", "3");
    const inbox = await addInbox(w, { local: "race", kind: "human", shared: true });
    const payload = (to: string[]): AcceptEmailPayload => ({
      from: inbox.emailAddress,
      to,
      subject: "Hi",
      text: "Hello",
      domainId: null,
      inbox: {
        inboxId: inbox.id,
        threadId: null,
        firstContact: false,
        newRecipients: [],
        countTowardCap: false,
      },
    });
    // The day's first charge inserts its row unguarded.
    const four = ["a@example.org", "b@example.org", "c@example.org", "d@example.org"];
    expect(await acceptEmail(w.deps, await auth(w), payload(four))).toMatchObject({
      ok: false,
      reason: "shared_team_cap",
    });
    await db
      .insert(schema.usageCounters)
      .values({ teamId: w.teamId, day: utcDay(), sharedRecipients: 3 });
    const raced = await acceptEmail(w.deps, await auth(w), payload(["a@example.org"]));
    expect(raced).toMatchObject({ ok: false, reason: "shared_team_cap" });
    expect(
      raced.ok === false && raced.reason === "shared_team_cap" && raced.retryAfterSec,
    ).toBeGreaterThan(0);
    expect(await sharedToday(w)).toBe(3);
    expect(
      await db.select().from(schema.emails).where(eq(schema.emails.inboxId, inbox.id)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(schema.inboxUsageDaily)
        .where(eq(schema.inboxUsageDaily.inboxId, inbox.id)),
    ).toEqual([]);
  });

  it("decides on the process's settings reader and charges on the stored cap, answering a refused charge alike", async () => {
    const w = await seedWorld(db, "team-cap-reader");
    vi.stubEnv("ABUSE_JUDGE", "typesafe");
    vi.stubEnv("SHARED_INBOX_TEAM_DAILY_CAP", "1");
    const { settings } = resolveMonitorSettings(null, {});
    const deps = {
      ...w.deps,
      monitorSettings: async () => ({
        ...settings,
        sharedInboxOpen: true,
        sharedInboxTeamDailyCap: 1000,
      }),
    };
    const inbox = await addInbox(w, { local: "stale", kind: "human", shared: true });
    const out = await sendNewFromInbox(db, deps, {
      teamId: w.teamId,
      billing: await billing(w),
      actor: USER,
      inboxId: inbox.id,
      message: { to: ["a@example.org", "b@example.org"], subject: "Hello", text: "Hi" },
    });
    expect(out).toMatchObject(refusedFor("shared_team_cap"));
    expect(out.kind === "refused" && out.error.retryAfterSec).toBeGreaterThan(0);
    expect(await sharedToday(w)).toBe(0);
    // The decision let it through; the charge refused it.
    const refusals = await db
      .select()
      .from(schema.inboxActivity)
      .where(
        and(
          eq(schema.inboxActivity.inboxId, inbox.id),
          eq(schema.inboxActivity.action, "email.refused"),
        ),
      );
    expect(refusals).toEqual([]);
  });

  it("hands the team's charge back when the inbox's own cap or a later step refuses", async () => {
    const w = await seedWorld(db, "team-cap-refund");
    const inbox = await addInbox(w, { local: "refund", shared: true, safety: { send_cap: 1 } });
    await db
      .insert(schema.inboxUsageDaily)
      .values({ inboxId: inbox.id, day: utcDay(), recipients: 1 });
    const accept = {
      inboxId: inbox.id,
      threadId: null,
      firstContact: false,
      newRecipients: [],
      countTowardCap: true,
    };
    expect(
      await acceptEmail(w.deps, await auth(w), {
        from: inbox.emailAddress,
        to: ["a@example.org"],
        subject: "Hi",
        text: "Hello",
        domainId: null,
        inbox: accept,
      }),
    ).toMatchObject({ ok: false, reason: "inbox_send_cap_reached" });
    expect(await sharedToday(w)).toBe(0);
    await db.transaction(async (tx) => {
      const begun = await beginInboxAccept(tx as unknown as Db, w.deps, {
        teamId: w.teamId,
        accept: { ...accept, countTowardCap: false },
        recipients: 2,
        subject: "S",
        headers: undefined,
        now: new Date(),
      });
      if (typeof begun === "string") throw new Error(`unexpected ${begun}`);
      await refundInboxAccept(tx as unknown as Db, begun);
    });
    expect(await sharedToday(w)).toBe(0);
  });
});

describe("at most 10 recipients per email from the shared domain", () => {
  it("holds a send, a draft, a draft's send and the generic surfaces to it, and no other inbox", async () => {
    const w = await seedWorld(db, "eleven");
    openSending();
    const inbox = await addInbox(w, { local: "many", kind: "human", shared: true });
    const eleven = Array.from({ length: 11 }, (_, i) => `r${i}@example.org`);
    expect(await sendNew(w, inbox, eleven)).toMatchObject(refusedFor("shared_recipients"));
    const draft = (to: string[]) =>
      createDraft(db, w.deps, {
        teamId: w.teamId,
        inboxId: inbox.id,
        actor: USER,
        input: { to, subject: "Hi", text: "Hello" },
      });
    expect(await draft(eleven)).toEqual({
      ok: false,
      error: { ...SHARED_REFUSALS.shared_recipients },
    });
    const ten = await draft(eleven.slice(0, 10));
    if (!ten.ok) throw new Error(ten.error.message);
    const grown = await updateDraft(db, w.deps, {
      teamId: w.teamId,
      inboxId: inbox.id,
      draftId: ten.draft.id,
      actor: USER,
      patch: { to: eleven },
    });
    expect(grown.ok).toBe(true);
    expect(
      await sendDraft(db, w.deps, {
        teamId: w.teamId,
        billing: await billing(w),
        actor: USER,
        inboxId: inbox.id,
        draftId: ten.draft.id,
      }),
    ).toMatchObject(refusedFor("shared_recipients"));
    expect(
      await acceptEmail(w.deps, await auth(w), {
        from: inbox.emailAddress,
        to: eleven,
        subject: "Hi",
        text: "Hello",
        domainId: null,
      }),
    ).toEqual({ ok: false, reason: "shared_recipients" });
    sent(await sendNew(w, await addInbox(w, { local: "many", kind: "human" }), eleven));
  });
});

describe("a generic send from a shared address", () => {
  it("carries the inbox's own address and display name, and none of the fields its endpoints never send", async () => {
    const w = await seedWorld(db, "generic-from");
    openSending();
    const inbox = await addInbox(w, {
      local: "leo",
      kind: "human",
      shared: true,
      fromName: "Leo Bot",
    });
    const domain = inbox.emailAddress.slice(inbox.emailAddress.indexOf("@") + 1);
    const send = async (over: Partial<AcceptEmailPayload>) =>
      acceptEmail(w.deps, await auth(w), {
        from: inbox.emailAddress,
        to: ["ana@example.org"],
        subject: "Hi",
        text: "Hello",
        domainId: null,
        ...over,
      });
    const brokenRule = (message: RegExp) => ({
      ok: false,
      reason: "shared_from",
      message: expect.stringMatching(message),
    });
    expect(await send({ from: `leo+x@${domain}` })).toEqual(brokenRule(/with no \+tag/));
    expect(await send({ from: `nobody@${domain}` })).toEqual(brokenRule(/one of your inboxes/));
    expect(await send({ from: `PayPal <${inbox.emailAddress}>` })).toEqual(
      brokenRule(/display name/),
    );
    expect(await send({ scheduledAt: new Date(Date.now() + 3_600_000) })).toEqual(
      brokenRule(/^scheduled_at /),
    );
    expect(await send({ replyTo: ["other@example.org"] })).toEqual(brokenRule(/^reply_to /));
    expect(await send({ attachments: [{ filename: "a.txt", content: "aGk=" }] })).toEqual(
      brokenRule(/^attachments /),
    );
    expect(await send({ headers: { "X-Campaign": "1" } })).toEqual(brokenRule(/^headers /));
    expect((await send({ from: `Leo Bot <${inbox.emailAddress}>` })).ok).toBe(true);
    expect((await send({})).ok).toBe(true);
  });

  it("answers with the cause the decision names when the mode holds the team back", async () => {
    const w = await seedWorld(db, "generic-mode");
    openSending();
    const inbox = await addInbox(w, { local: "leo", kind: "human", shared: true });
    const send = async () =>
      acceptEmail(w.deps, await auth(w), {
        from: inbox.emailAddress,
        to: ["ana@example.org"],
        subject: "Hi",
        text: "Hello",
        domainId: null,
      });
    await db.update(schema.teams).set({ plan: "free" }).where(eq(schema.teams.id, w.teamId));
    expect(await send()).toEqual({ ok: false, reason: "shared_plan" });
    vi.stubEnv("SHARED_INBOX_SEND", "false");
    expect(await send()).toEqual({ ok: false, reason: "shared_paused" });
  });
});
