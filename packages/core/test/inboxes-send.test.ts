import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTestDb, createWebhookEndpoint } from "@millionsend/test-utils";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { acceptEmail } from "../src/accept-email.js";
import type { InboxActor } from "../src/inboxes/activity.js";
import { msgIds } from "../src/inboxes/compose.js";
import { secretMac, verifyThreadTokenRef } from "../src/inboxes/keys.js";
import {
  beginInboxAccept,
  forwardedFilesProblem,
  forwardInThread,
  forwardToForwardTargets,
  refundInboxAccept,
  replyInThread,
  type SendOutcome,
  sendNewFromInbox,
} from "../src/inboxes/send.js";
import { utcDay } from "../src/utc-day.js";
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
let w: World;

const TEAM_KEY: InboxActor = {
  kind: "api_key",
  apiKeyId: "00000000-0000-4000-8000-000000000001",
  inboxId: null,
};
const USER: InboxActor = { kind: "user", userId: "u1" };
const inboxKey = (inboxId: string): InboxActor => ({
  kind: "api_key",
  apiKeyId: "00000000-0000-4000-8000-000000000002",
  inboxId,
});

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  w = await seedWorld(db, "send");
  // No send path fetches a link it reads, so any fetch fails the test.
  vi.stubGlobal("fetch", () => {
    throw new Error("an inbox send fetched a URL");
  });
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await close();
});

const sent = (o: SendOutcome) => {
  if (o.kind !== "sent") throw new Error(`expected a send, got ${JSON.stringify(o)}`);
  return o;
};
const drafted = (o: SendOutcome) => {
  if (o.kind !== "draft") throw new Error(`expected a draft, got ${JSON.stringify(o)}`);
  return o.draft;
};

const emailRow = async (id: string) => {
  const [row] = await db.select().from(schema.emails).where(eq(schema.emails.id, id));
  if (!row) throw new Error("no email row");
  return row;
};
const activity = (inboxId: string) =>
  db.select().from(schema.inboxActivity).where(eq(schema.inboxActivity.inboxId, inboxId));
const deliveries = async (endpointId: string) =>
  (
    await db
      .select()
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.endpointId, endpointId))
  ).map((d) => d.payload as { type: string; data: Record<string, unknown> });

async function thread(inbox: InboxRow, message = {}) {
  const threadId = await addThread(w, inbox.id);
  const received = await receive(w, { inbox, threadId, message });
  return { threadId, ...received };
}

const reply = (
  inbox: InboxRow,
  t: { threadId: string; id: string },
  body: Parameters<typeof replyInThread>[2]["body"],
  actor: InboxActor = TEAM_KEY,
  idempotencyKey: string | null = null,
) =>
  billing(w).then((b) =>
    replyInThread(db, w.deps, {
      teamId: w.teamId,
      billing: b,
      actor,
      inboxId: inbox.id,
      threadId: t.threadId,
      emailId: t.id,
      body,
      idempotencyKey,
    }),
  );

describe("replyInThread", () => {
  it("answers the sender from the inbox, threaded and marked automatic, and records it everywhere", async () => {
    const inbox = await addInbox(w, { local: "support", fromName: "Acme Support" });
    const hook = await createWebhookEndpoint(db, w.teamId, [
      "inbox.email.sent",
      "inbox.thread.created",
    ]);
    const t = await thread(inbox, { references: "<root@sender.example>" });
    const out = sent(await reply(inbox, t, { text: "Thanks!" }));

    expect(out.email).toMatchObject({
      direction: "outbound",
      from: "Acme Support <support@send.acme.test>",
      to: ["ada@sender.example"],
      subject: "Re: Question",
      reply_to: [],
      message_id: null,
      read: true,
      text: "Thanks!",
      thread_id: t.threadId,
      inbox_id: inbox.id,
    });
    expect(out.email.email_id).toBe(out.email.id);
    const row = await emailRow(out.email.id);
    expect(row).toMatchObject({ inboxId: inbox.id, threadId: t.threadId, firstContact: false });
    expect(row.headers?.["In-Reply-To"]).toBe(t.messageId);
    const refs = msgIds(row.headers?.References);
    expect(refs.slice(1)).toEqual(["<root@sender.example>", t.messageId]);
    expect(
      verifyThreadTokenRef(w.keys, { teamId: w.teamId, inboxId: inbox.id, ref: refs[0] ?? "" }),
    ).toBe(t.threadId);
    expect(row.headers?.["Auto-Submitted"]).toBe("auto-replied");
    expect(w.enqueuedEmails).toContain(out.email.id);

    const [threadRow] = await db
      .select()
      .from(schema.inboxThreads)
      .where(eq(schema.inboxThreads.id, t.threadId));
    expect(threadRow?.participants).toEqual(["ada@sender.example"]);
    const [usage] = await db
      .select()
      .from(schema.inboxUsageDaily)
      .where(eq(schema.inboxUsageDaily.inboxId, inbox.id));
    expect(usage).toMatchObject({ recipients: 1, newRecipients: 0, day: utcDay() });
    const [correspondent] = await db
      .select()
      .from(schema.inboxCorrespondents)
      .where(eq(schema.inboxCorrespondents.inboxId, inbox.id));
    expect(correspondent).toMatchObject({ address: "ada@sender.example", burstCount: 1 });
    expect(correspondent?.firstOutAt).not.toBeNull();
    expect((await activity(inbox.id)).map((a) => [a.action, a.decision])).toEqual([
      ["email.sent", { result: "send", reasons: [] }],
    ]);
    const events = await deliveries(hook);
    expect(events.map((e) => e.type)).toEqual(["inbox.email.sent"]);
    expect(events[0]?.data).toMatchObject({
      source: "system",
      inbox_id: inbox.id,
      thread_id: t.threadId,
      email_id: out.email.id,
    });
    expect(events[0]?.data.email).not.toHaveProperty("html");
    expect(events[0]?.data.email).not.toHaveProperty("text");
  });

  it("a person's reply goes out as theirs: no Auto-Submitted, counted as approved", async () => {
    const inbox = await addInbox(w, { local: "people-reply" });
    const t = await thread(inbox);
    const out = sent(await reply(inbox, t, { html: "<p>Hi</p>" }, USER));
    const row = await emailRow(out.email.id);
    expect(row.headers?.["Auto-Submitted"]).toBeUndefined();
    expect((await activity(inbox.id))[0]?.decision).toEqual({
      result: "send",
      reasons: ["approved"],
    });
  });

  it("holds a reply steered by a foreign Reply-To as a draft, one per answered email", async () => {
    const inbox = await addInbox(w, { local: "redirect" });
    const hook = await createWebhookEndpoint(db, w.teamId, [
      "inbox.draft.created",
      "inbox.draft.updated",
    ]);
    const t = await thread(inbox, { replyTo: "victim@elsewhere.example" });
    const first = drafted(await reply(inbox, t, { text: "Sure" }));
    expect(first).toMatchObject({
      object: "inbox_draft",
      type: "reply",
      status: "pending_approval",
      to: ["victim@elsewhere.example"],
      thread_id: t.threadId,
      reply_to_email_id: t.id,
      text: "Sure",
      approval_reasons: ["reply_to_redirect", "send_policy"],
    });
    const expiresIn = new Date(first.expires_at ?? 0).getTime() - Date.now();
    expect(expiresIn).toBeGreaterThan(6.9 * 86_400_000);
    const again = drafted(await reply(inbox, t, { text: "Sure, again" }));
    expect(again.id).toBe(first.id);
    expect(again.text).toBe("Sure, again");
    expect((await deliveries(hook)).map((e) => e.type)).toEqual([
      "inbox.draft.created",
      "inbox.draft.updated",
    ]);
    expect((await activity(inbox.id)).map((a) => a.action)).toEqual([
      "email.drafted",
      "email.drafted",
    ]);
    expect(
      await db.select().from(schema.emails).where(eq(schema.emails.inboxId, inbox.id)),
    ).toEqual([]);
  });

  it("holds a reply to automatic mail and a burst to one address (loop guard)", async () => {
    const inbox = await addInbox(w, { local: "loops" });
    const auto = await addThread(w, inbox.id);
    const autoMail = await receive(w, { inbox, threadId: auto, automated: "auto_submitted" });
    expect(
      drafted(await reply(inbox, { threadId: auto, id: autoMail.id }, { text: "ok" }))
        .approval_reasons,
    ).toEqual(["loop_guard:auto_submitted"]);

    const t = await thread(inbox);
    await db.insert(schema.inboxCorrespondents).values({
      inboxId: inbox.id,
      address: "ada@sender.example",
      burstStart: new Date(Date.now() - 10 * 60_000),
      burstCount: 10,
    });
    expect(drafted(await reply(inbox, t, { text: "ok" })).approval_reasons).toEqual(["loop_burst"]);
  });

  it("never lets an agent credential answer held mail; a team key may", async () => {
    const inbox = await addInbox(w, { local: "held" });
    const threadId = await addThread(w, inbox.id);
    const quarantined = await receive(w, { inbox, threadId, verdict: "quarantined" });
    const pending = await receive(w, { inbox, threadId, verdict: "pending" });
    const asAgent = await reply(
      inbox,
      { threadId, id: quarantined.id },
      { text: "x" },
      inboxKey(inbox.id),
    );
    expect(asAgent).toMatchObject({
      kind: "refused",
      error: { status: 403, name: "email_quarantined" },
    });
    const viaMcp: InboxActor = { kind: "oauth", userId: "u", clientId: "c" };
    expect(
      await reply(inbox, { threadId, id: quarantined.id }, { text: "x" }, viaMcp),
    ).toMatchObject({
      kind: "refused",
      error: { status: 403 },
    });
    expect(
      await reply(inbox, { threadId, id: pending.id }, { text: "x" }, inboxKey(inbox.id)),
    ).toMatchObject({
      kind: "refused",
      error: { status: 404 },
    });
    expect((await reply(inbox, { threadId, id: quarantined.id }, { text: "x" })).kind).not.toBe(
      "refused",
    );
    const other = await addInbox(w, { local: "other-held" });
    expect(
      await reply(inbox, { threadId, id: quarantined.id }, { text: "x" }, inboxKey(other.id)),
    ).toMatchObject({
      kind: "refused",
      error: { status: 404, message: "Inbox not found." },
    });
  });

  it("validates the body: content, one-line subject, at most 50 recipients", async () => {
    const inbox = await addInbox(w, { local: "validate" });
    const t = await thread(inbox);
    for (const body of [
      { text: "   " },
      { text: "x", subject: "a\nb" },
      { text: "x", cc: ["not an address"] },
      { text: "x", cc: Array.from({ length: 50 }, (_, i) => `c${i}@example.org`) },
    ]) {
      expect(await reply(inbox, t, body)).toMatchObject({
        kind: "refused",
        error: { status: 422, name: "validation_error" },
      });
    }
  });

  it("replays an Idempotency-Key: the same email, the same held draft; another body conflicts", async () => {
    const inbox = await addInbox(w, { local: "idem" });
    const t = await thread(inbox);
    const first = sent(await reply(inbox, t, { text: "once" }, TEAM_KEY, "key-1"));
    const replay = sent(await reply(inbox, t, { text: "once" }, TEAM_KEY, "key-1"));
    expect(replay.email.id).toBe(first.email.id);
    expect(replay.email.text).toBe("once");
    expect(
      await db.select().from(schema.emails).where(eq(schema.emails.inboxId, inbox.id)),
    ).toHaveLength(1);
    expect(await reply(inbox, t, { text: "twice" }, TEAM_KEY, "key-1")).toMatchObject({
      kind: "refused",
      error: { status: 409, name: "invalid_idempotent_request" },
    });
    const held = drafted(
      await reply(inbox, t, { text: "hold me", requires_approval: true }, TEAM_KEY, "key-2"),
    );
    const heldAgain = drafted(
      await reply(inbox, t, { text: "hold me", requires_approval: true }, TEAM_KEY, "key-2"),
    );
    expect(heldAgain.id).toBe(held.id);
    expect(held.approval_reasons).toEqual(["approval_required"]);
  });
});

describe("forwardInThread", () => {
  const PDF = Buffer.from("%PDF-1.4 forwarded", "utf8");
  const forward = async (
    inbox: InboxRow,
    t: { threadId: string; id: string },
    body: Parameters<typeof forwardInThread>[2]["body"],
    actor: InboxActor = USER,
  ) =>
    forwardInThread(db, w.deps, {
      teamId: w.teamId,
      billing: await billing(w),
      actor,
      inboxId: inbox.id,
      threadId: t.threadId,
      emailId: t.id,
      body,
    });

  it("quotes the original under the note and carries its files with positional ids", async () => {
    const inbox = await addInbox(w, { local: "fwd" });
    const t = await thread(inbox, {
      attachments: [{ filename: "report.pdf", content: PDF, contentType: "application/pdf" }],
    });
    const out = sent(await forward(inbox, t, { to: "boss@example.org", text: "FYI" }));
    expect(out.email.subject).toBe("Fwd: Question");
    expect(out.email.text).toContain(
      "FYI\n\n---------- Forwarded message ---------\nFrom: Ada Lovelace <ada@sender.example>",
    );
    expect(out.email.text).toContain("Subject: Question");
    expect(out.email.html).toContain('<div class="gmail_quote">');
    expect(out.email.attachments).toEqual([{ id: "0", filename: "report.pdf", size: PDF.length }]);
    const row = await emailRow(out.email.id);
    expect(row.headers?.["In-Reply-To"]).toBeUndefined();
    expect(row.attachments).not.toBeNull();
  });

  it("an agent's forward to a stranger waits for a person; to the allowlist it goes out marked automatic", async () => {
    const inbox = await addInbox(w, {
      local: "fwd-agent",
      safety: { allowlist: ["*@partner.example"] },
    });
    const t = await thread(inbox);
    expect(drafted(await forward(inbox, t, { to: "x@stranger.example" }, TEAM_KEY))).toMatchObject({
      forward: true,
      type: "reply",
      reply_to_email_id: t.id,
      approval_reasons: ["send_policy"],
    });
    const out = sent(await forward(inbox, t, { to: "ops@partner.example" }, TEAM_KEY));
    expect((await emailRow(out.email.id)).headers?.["Auto-Submitted"]).toBe("auto-generated");
  });

  it("never forwards malware, and holds a forwarded code meant for anyone but owners", async () => {
    const inbox = await addInbox(w, {
      local: "fwd-guard",
      safety: { allowlist: ["*@partner.example"] },
    });
    const threadId = await addThread(w, inbox.id);
    const virus = await receive(w, { inbox, threadId, virusVerdict: "fail" });
    expect(
      await forward(inbox, { threadId, id: virus.id }, { to: "ops@partner.example" }),
    ).toMatchObject({
      kind: "refused",
      error: { status: 403, name: "email_quarantined" },
    });
    const code = await receive(w, { inbox, threadId, extractedKinds: ["code"] });
    expect(
      drafted(
        await forward(inbox, { threadId, id: code.id }, { to: "ada@sender.example" }, TEAM_KEY),
      ).approval_reasons,
    ).toEqual(["private_code"]);
    for (const to of [w.owner, "ops@partner.example"]) {
      expect(
        sent(await forward(inbox, { threadId, id: code.id }, { to }, TEAM_KEY)).email.to,
      ).toEqual([to]);
    }
  });

  it("refuses files past 10 MiB and files no send may carry", () => {
    const big = { filename: "big.bin", content: Buffer.alloc(11 * 1024 * 1024).toString("base64") };
    expect(forwardedFilesProblem([big])).toBe("Forwarded attachments exceed 10 MiB");
    expect(
      forwardedFilesProblem([
        { filename: "run.exe", content: Buffer.from("MZ").toString("base64") },
      ]),
    ).toMatch(/run\.exe/);
    expect(
      forwardedFilesProblem([{ filename: "ok.pdf", content: PDF.toString("base64") }]),
    ).toBeNull();
  });
});

describe("sendNewFromInbox", () => {
  const send = async (inbox: InboxRow, to: string[], actor: InboxActor = USER) =>
    sendNewFromInbox(db, w.deps, {
      teamId: w.teamId,
      billing: await billing(w),
      actor,
      inboxId: inbox.id,
      message: { to, subject: "Hello", text: "Hi there" },
    });

  it("a shared address never starts a conversation, a person's or an agent's", async () => {
    const inbox = await addInbox(w, { local: "shared-bot", shared: true });
    for (const actor of [USER, TEAM_KEY]) {
      expect(await send(inbox, [w.owner], actor)).toMatchObject({
        kind: "refused",
        error: { status: 403, name: "inbox_send_policy" },
      });
    }
  });

  it("opens a sent thread, marks the first contact and the inbox's first send", async () => {
    const inbox = await addInbox(w, { local: "outbound" });
    const hook = await createWebhookEndpoint(db, w.teamId, [
      "inbox.thread.created",
      "inbox.email.sent",
    ]);
    const out = sent(await send(inbox, ["new@example.org"]));
    const row = await emailRow(out.email.id);
    expect(row.firstContact).toBe(true);
    expect(row.threadId).not.toBeNull();
    const [threadRow] = await db
      .select()
      .from(schema.inboxThreads)
      .where(eq(schema.inboxThreads.id, row.threadId ?? ""));
    expect(threadRow).toMatchObject({
      folder: "sent",
      subject: "Hello",
      participants: ["new@example.org"],
    });
    const [inboxRow] = await db
      .select()
      .from(schema.inboxes)
      .where(eq(schema.inboxes.id, inbox.id));
    expect(inboxRow?.firstSentAt).not.toBeNull();
    expect(
      verifyThreadTokenRef(w.keys, {
        teamId: w.teamId,
        inboxId: inbox.id,
        ref: msgIds(row.headers?.References)[0] ?? "",
      }),
    ).toBe(row.threadId);
    expect((await deliveries(hook)).map((e) => e.type)).toEqual([
      "inbox.thread.created",
      "inbox.email.sent",
    ]);
  });

  it('a new team\'s "open" inbox reads as reply_only', async () => {
    const team = await seedWorld(db, "fresh-team");
    const inbox = await addInbox(team, { local: "open", safety: { send_policy: "open" } });
    const out = await sendNewFromInbox(db, team.deps, {
      teamId: team.teamId,
      billing: await billing(team),
      actor: TEAM_KEY,
      inboxId: inbox.id,
      message: { to: ["x@example.org"], subject: "Hello", text: "Hi" },
    });
    expect(drafted(out).approval_reasons).toEqual(["send_policy"]);
  });

  it("ramps an agent's new recipients: 11 on day 0 wait for a person", async () => {
    await establish(w);
    const inbox = await addInbox(w, { local: "ramp", safety: { send_policy: "open" } });
    const eleven = Array.from({ length: 11 }, (_, i) => `r${i}@example.org`);
    expect(drafted(await send(inbox, eleven, TEAM_KEY))).toMatchObject({
      type: "standalone",
      approval_reasons: ["ramp"],
    });
    expect(sent(await send(inbox, eleven.slice(0, 10), TEAM_KEY)).email.to).toHaveLength(10);
  });
});

describe("private codes", () => {
  it("holds a code received within 24 h pasted to anyone but owners; an older one goes out", async () => {
    const inbox = await addInbox(w, { local: "codes" });
    const t = await thread(inbox);
    const mac = secretMac(w.keys, w.teamId, "482913");
    await db.insert(schema.receivedSecrets).values({
      teamId: w.teamId,
      mac,
      receivedEmailId: t.id,
      kind: "code",
      createdAt: new Date(Date.now() - 5 * 60_000),
    });
    expect(drafted(await reply(inbox, t, { text: "Your code: 482 913" })).approval_reasons).toEqual(
      ["private_code"],
    );
    await db
      .update(schema.receivedSecrets)
      .set({ createdAt: new Date(Date.now() - 25 * 3_600_000) })
      .where(eq(schema.receivedSecrets.receivedEmailId, t.id));
    expect((await reply(inbox, t, { text: "Your code: 482 913" })).kind).toBe("sent");
  });
});

describe("the acceptEmail hook on generic surfaces", () => {
  const payload = (inbox: InboxRow, over: Partial<Parameters<typeof acceptEmail>[2]> = {}) => ({
    from: inbox.emailAddress,
    to: ["someone@example.org"],
    subject: "Hi",
    text: "Hello",
    domainId: w.domainId,
    ...over,
  });
  const auth = async (inboxId: string | null = null) => ({
    teamId: w.teamId,
    billing: await billing(w),
    apiKeyId: TEAM_KEY.kind === "api_key" ? TEAM_KEY.apiKeyId : null,
    inboxId,
  });

  it("refuses an agent inbox's new conversation and records why", async () => {
    const inbox = await addInbox(w, { local: "generic" });
    expect(await acceptEmail(w.deps, await auth(), payload(inbox))).toEqual({
      ok: false,
      reason: "inbox_send_policy",
      reasons: ["send_policy"],
    });
    expect((await activity(inbox.id)).map((a) => [a.action, a.decision])).toEqual([
      ["email.refused", { result: "draft", reasons: ["send_policy"] }],
    ]);
  });

  it("threads a reply named by In-Reply-To and sends it with the token and Auto-Submitted", async () => {
    const inbox = await addInbox(w, { local: "generic-reply" });
    const t = await thread(inbox);
    const result = await acceptEmail(
      w.deps,
      await auth(),
      payload(inbox, { to: ["ada@sender.example"], headers: { "In-Reply-To": t.messageId } }),
    );
    if (!result.ok) throw new Error(`refused: ${result.reason}`);
    const row = await emailRow(result.id);
    expect(row).toMatchObject({ inboxId: inbox.id, threadId: t.threadId });
    expect(row.headers?.["Auto-Submitted"]).toBe("auto-replied");
    expect(msgIds(row.headers?.References)).toHaveLength(1);
  });

  it("holds an inbox-scoped key to its own address, and refuses shared addresses without an inbox", async () => {
    const inbox = await addInbox(w, { local: "scoped" });
    const other = await addInbox(w, { local: "scoped-other" });
    expect(await acceptEmail(w.deps, await auth(other.id), payload(inbox))).toEqual({
      ok: false,
      reason: "inbox_scope",
    });
    expect(
      await acceptEmail(
        w.deps,
        await auth(other.id),
        payload(inbox, { from: `plain@${w.domain}` }),
      ),
    ).toEqual({ ok: false, reason: "inbox_scope" });
    expect(
      await acceptEmail(
        w.deps,
        await auth(),
        payload(inbox, { from: `ghost@team.${w.sharedDomain}`, domainId: null }),
      ),
    ).toMatchObject({ ok: false, reason: "inbox_send_policy" });
    const plain = await acceptEmail(
      w.deps,
      await auth(),
      payload(inbox, { from: `plain@${w.domain}` }),
    );
    expect(plain.ok).toBe(true);
  });

  it("charges the cap with a guarded upsert: a race past it refuses and writes nothing", async () => {
    const inbox = await addInbox(w, { local: "capped", safety: { send_cap: 1 } });
    await db
      .insert(schema.inboxUsageDaily)
      .values({ inboxId: inbox.id, day: utcDay(), recipients: 1 });
    const accept = { inboxId: inbox.id, threadId: null, firstContact: false, newRecipients: [] };
    const raced = await acceptEmail(
      w.deps,
      await auth(),
      payload(inbox, { inbox: { ...accept, countTowardCap: true } }),
    );
    expect(raced).toMatchObject({ ok: false, reason: "inbox_send_cap_reached" });
    expect(
      raced.ok === false && raced.reason === "inbox_send_cap_reached" && raced.retryAfterSec,
    ).toBeGreaterThan(0);
    expect(
      await db.select().from(schema.emails).where(eq(schema.emails.inboxId, inbox.id)),
    ).toEqual([]);
    expect(
      await db.select().from(schema.inboxThreads).where(eq(schema.inboxThreads.inboxId, inbox.id)),
    ).toEqual([]);
    const approved = await acceptEmail(
      w.deps,
      await auth(),
      payload(inbox, { inbox: { ...accept, countTowardCap: false } }),
    );
    expect(approved.ok).toBe(true);
    const [usage] = await db
      .select()
      .from(schema.inboxUsageDaily)
      .where(eq(schema.inboxUsageDaily.inboxId, inbox.id));
    expect(usage?.recipients).toBe(2);
  });

  it("hands the charge and the opened thread back when the accept refuses later", async () => {
    const inbox = await addInbox(w, { local: "refund" });
    const state = await db.transaction(async (tx) => {
      const begun = await beginInboxAccept(tx as unknown as Db, w.deps, {
        teamId: w.teamId,
        accept: {
          inboxId: inbox.id,
          threadId: null,
          firstContact: true,
          newRecipients: ["a@b.c"],
          countTowardCap: true,
        },
        recipients: 2,
        subject: "S",
        headers: undefined,
        now: new Date(),
      });
      if (begun === "cap") throw new Error("unexpected cap");
      await refundInboxAccept(tx as unknown as Db, begun);
      return begun;
    });
    const [usage] = await db
      .select()
      .from(schema.inboxUsageDaily)
      .where(
        and(
          eq(schema.inboxUsageDaily.inboxId, inbox.id),
          eq(schema.inboxUsageDaily.day, state.day),
        ),
      );
    expect(usage).toMatchObject({ recipients: 0, newRecipients: 0 });
    expect(
      await db.select().from(schema.inboxThreads).where(eq(schema.inboxThreads.id, state.threadId)),
    ).toEqual([]);
  });
});

describe("the forward_to pass", () => {
  it("forwards a delivered message to member and owner addresses only, marked against loops", async () => {
    const inbox = await addInbox(w, {
      local: "forwarding",
      safety: { forward_to: [w.owner, "left-the-team@example.org"] },
    });
    const t = await thread(inbox);
    const out = await forwardToForwardTargets(db, w.deps, {
      receivedEmailId: t.id,
      inboxId: inbox.id,
    });
    const email = sent(out as SendOutcome).email;
    expect(email).toMatchObject({ to: [w.owner], subject: "Fwd: Question" });
    const row = await emailRow(email.id);
    expect(row.headers?.["X-MillionSend-Forwarded"]).toBe(inbox.id);
    expect(row.headers?.["Auto-Submitted"]).toBe("auto-generated");
    const rows = await activity(inbox.id);
    expect(rows.map((a) => [a.action, a.emailId]).sort()).toEqual([
      ["email.forwarded", t.id],
      ["email.sent", email.id],
    ]);
  });

  it("stops at one hop and skips held mail", async () => {
    const inbox = await addInbox(w, {
      local: "forwarding-guard",
      safety: { forward_to: [w.owner] },
    });
    const threadId = await addThread(w, inbox.id);
    const looped = await receive(w, {
      inbox,
      threadId,
      message: { headers: { "X-MillionSend-Forwarded": "some-other-inbox" } },
    });
    expect(
      await forwardToForwardTargets(db, w.deps, { receivedEmailId: looped.id, inboxId: inbox.id }),
    ).toBeNull();
    const held = await receive(w, { inbox, threadId, verdict: "quarantined" });
    expect(
      await forwardToForwardTargets(db, w.deps, { receivedEmailId: held.id, inboxId: inbox.id }),
    ).toBeNull();
    expect(
      await db.select().from(schema.emails).where(eq(schema.emails.inboxId, inbox.id)),
    ).toEqual([]);
  });
});
