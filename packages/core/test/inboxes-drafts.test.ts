import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTestDb, createWebhookEndpoint } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { InboxActor } from "../src/inboxes/activity.js";
import {
  createDraft,
  deleteDraft,
  expireDrafts,
  getDraft,
  listDrafts,
  rejectDraft,
  sendDraft,
  updateDraft,
} from "../src/inboxes/drafts.js";
import { forwardInThread, type SendOutcome } from "../src/inboxes/send.js";
import type { DraftWire } from "../src/inboxes/types.js";
import {
  addInbox,
  addThread,
  billing,
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
const MCP: InboxActor = { kind: "oauth", userId: "u1", clientId: "client-1" };
const inboxKey = (inbox: InboxRow): InboxActor => ({
  kind: "api_key",
  apiKeyId: "00000000-0000-4000-8000-000000000002",
  inboxId: inbox.id,
});

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  w = await seedWorld(db, "drafts");
});
afterAll(() => close());

async function create(
  inbox: InboxRow,
  input: Parameters<typeof createDraft>[2]["input"],
  actor: InboxActor = inboxKey(inbox),
) {
  const out = await createDraft(db, w.deps, { teamId: w.teamId, inboxId: inbox.id, actor, input });
  if (!out.ok) throw new Error(`refused: ${out.error.message}`);
  return out;
}

const send = async (inbox: InboxRow, draft: DraftWire, actor: InboxActor, key?: string) =>
  sendDraft(db, w.deps, {
    teamId: w.teamId,
    billing: await billing(w),
    actor,
    inboxId: inbox.id,
    draftId: draft.id,
    idempotencyKey: key ?? null,
  });

const draftRow = async (id: string) => {
  const [row] = await db.select().from(schema.inboxDrafts).where(eq(schema.inboxDrafts.id, id));
  if (!row) throw new Error("no draft");
  return row;
};
const activity = async (inboxId: string) =>
  (
    await db.select().from(schema.inboxActivity).where(eq(schema.inboxActivity.inboxId, inboxId))
  ).map((a) => a.action);
const events = async (endpointId: string) =>
  (
    await db
      .select()
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.endpointId, endpointId))
  ).map((d) => (d.payload as { type: string; data: Record<string, unknown> }).type);

describe("createDraft", () => {
  it("creates a standalone draft in Resend's shape, sealed, with its event and activity", async () => {
    const inbox = await addInbox(w, { local: "standalone" });
    const hook = await createWebhookEndpoint(db, w.teamId, ["inbox.draft.created"]);
    const { draft, created } = await create(inbox, {
      to: "Ana <ana@example.org>",
      subject: "Hello",
      text: "Hi",
    });
    expect(created).toBe(true);
    expect(draft).toMatchObject({
      object: "inbox_draft",
      type: "standalone",
      to: ["Ana <ana@example.org>"],
      cc: [],
      bcc: [],
      subject: "Hello",
      html: null,
      text: "Hi",
      thread_id: null,
      reply_to_email_id: null,
      email_id: null,
      status: "draft",
      approval_reasons: [],
      forward: false,
    });
    const row = await draftRow(draft.id);
    expect(row.createdBy).toBe("api_key:00000000-0000-4000-8000-000000000002");
    expect(row.bodyCiphertext?.includes(Buffer.from("Hi"))).toBe(false);
    expect(await events(hook)).toEqual(["inbox.draft.created"]);
    expect(await activity(inbox.id)).toEqual(["draft.created"]);
  });

  it("keeps one unsent reply draft per email (200 with the existing one) and copies no recipients", async () => {
    const inbox = await addInbox(w, { local: "reply-drafts" });
    const threadId = await addThread(w, inbox.id);
    const target = await receive(w, { inbox, threadId });
    const first = await create(inbox, {
      thread_id: threadId,
      reply_to_email_id: target.id,
      text: "a",
    });
    expect(first.created).toBe(true);
    expect(first.draft).toMatchObject({ type: "reply", to: null, thread_id: threadId });
    const second = await create(inbox, {
      thread_id: threadId,
      reply_to_email_id: target.id,
      text: "b",
    });
    expect(second).toMatchObject({ created: false, draft: { id: first.draft.id, text: "a" } });
  });

  it("refuses what Resend refuses, and held mail to an agent", async () => {
    const inbox = await addInbox(w, { local: "draft-rules" });
    const threadId = await addThread(w, inbox.id);
    const held = await receive(w, { inbox, threadId, verdict: "quarantined" });
    const refusal = async (
      input: Parameters<typeof createDraft>[2]["input"],
      actor?: InboxActor,
    ) => {
      const out = await createDraft(db, w.deps, {
        teamId: w.teamId,
        inboxId: inbox.id,
        actor: actor ?? inboxKey(inbox),
        input,
      });
      return out.ok ? null : out.error;
    };
    expect(await refusal({})).toMatchObject({ status: 422 });
    expect(await refusal({ subject: "  " })).toMatchObject({ status: 422 });
    expect(await refusal({ subject: "a\r\nBcc: x@y.z" })).toMatchObject({ status: 422 });
    expect(await refusal({ to: "not an address" })).toMatchObject({ status: 422 });
    expect(
      await refusal({ to: Array.from({ length: 51 }, (_, i) => `r${i}@example.org`) }),
    ).toMatchObject({ status: 422 });
    expect(await refusal({ thread_id: threadId, text: "x" })).toMatchObject({ status: 422 });
    expect(
      await refusal({ thread_id: threadId, reply_to_email_id: threadId, text: "x" }),
    ).toMatchObject({ status: 404, message: "Email not found." });
    expect(
      await refusal({ thread_id: threadId, reply_to_email_id: held.id, text: "x" }),
    ).toMatchObject({ status: 403, name: "email_quarantined" });
    expect(
      await refusal({ thread_id: threadId, reply_to_email_id: held.id, text: "x" }, TEAM_KEY),
    ).toBeNull();
  });
});

describe("listDrafts and getDraft", () => {
  it("lists unsent drafts, most recently updated first, with Resend's cursor rules", async () => {
    const inbox = await addInbox(w, { local: "listing" });
    const ids: string[] = [];
    for (const subject of ["one", "two", "three"]) {
      ids.push((await create(inbox, { to: "a@example.org", subject })).draft.id);
    }
    const page = await listDrafts(db, { teamId: w.teamId, inboxId: inbox.id, query: { limit: 2 } });
    if (page === "bad_cursor") throw new Error("bad cursor");
    expect(page.data.map((d) => d.subject)).toEqual(["three", "two"]);
    expect(page.hasMore).toBe(true);
    expect(page.data[0]).toMatchObject({ snippet: null, status: "draft", approval_reasons: [] });
    const older = await listDrafts(db, {
      teamId: w.teamId,
      inboxId: inbox.id,
      query: { after: ids[1] },
    });
    expect(older !== "bad_cursor" && older.data.map((d) => d.subject)).toEqual(["one"]);
    const newer = await listDrafts(db, {
      teamId: w.teamId,
      inboxId: inbox.id,
      query: { before: ids[0] },
    });
    expect(newer !== "bad_cursor" && newer.data.map((d) => d.subject)).toEqual(["three", "two"]);
    expect(
      await listDrafts(db, { teamId: w.teamId, inboxId: inbox.id, query: { after: w.teamId } }),
    ).toBe("bad_cursor");
    expect(
      await getDraft(db, w.deps.keyring, {
        teamId: w.teamId,
        inboxId: inbox.id,
        draftId: ids[2] ?? "",
      }),
    ).toMatchObject({ subject: "three", object: "inbox_draft" });
    const other = await addInbox(w, { local: "listing-other" });
    expect(
      await getDraft(db, w.deps.keyring, {
        teamId: w.teamId,
        inboxId: other.id,
        draftId: ids[2] ?? "",
      }),
    ).toBeNull();
  });
});

describe("updateDraft", () => {
  const update = (
    inbox: InboxRow,
    draft: DraftWire,
    patch: Record<string, unknown>,
    actor?: InboxActor,
  ) =>
    updateDraft(db, w.deps, {
      teamId: w.teamId,
      inboxId: inbox.id,
      draftId: draft.id,
      actor: actor ?? inboxKey(inbox),
      patch,
    });

  it("replaces given fields, clears on null, and replaces the whole body when html or text is set", async () => {
    const inbox = await addInbox(w, { local: "patching" });
    const { draft } = await create(inbox, {
      to: "a@example.org",
      cc: "c@example.org",
      subject: "S",
      html: "<p>H</p>",
      text: "T",
    });
    const textOnly = await update(inbox, draft, { text: "new text" });
    expect(textOnly).toMatchObject({
      ok: true,
      draft: { text: "new text", html: null, subject: "S" },
    });
    const cleared = await update(inbox, draft, { to: null, cc: null, subject: null });
    expect(cleared).toMatchObject({
      ok: true,
      draft: { to: null, cc: [], subject: null, text: "new text" },
    });
    expect(await update(inbox, draft, { unknown: 1 })).toMatchObject({
      ok: false,
      error: { status: 422 },
    });
    expect(await update(inbox, draft, { text: null })).toMatchObject({
      ok: false,
      error: { status: 422 },
    });
    expect((await draftRow(draft.id)).version).toBe(3);
  });

  it("answers 409 when another write moved the draft during the request", async () => {
    const inbox = await addInbox(w, { local: "racing" });
    const { draft } = await create(inbox, { to: "a@example.org", text: "x" });
    const results = await Promise.all([
      update(inbox, draft, { subject: "first" }),
      update(inbox, draft, { subject: "second" }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ ok: false, error: { status: 409 } });
  });

  it("an agent's edit sends a pending draft back to draft; a person's keeps it pending", async () => {
    const inbox = await addInbox(w, { local: "pending-edits" });
    const { draft } = await create(inbox, { to: "stranger@example.org", subject: "S", text: "x" });
    const held = await send(inbox, draft, inboxKey(inbox));
    expect(held).toMatchObject({ kind: "draft", draft: { status: "pending_approval" } });
    expect(await update(inbox, draft, { text: "edited" }, TEAM_KEY)).toMatchObject({
      ok: true,
      draft: { status: "pending_approval", approval_reasons: ["send_policy"] },
    });
    expect(await update(inbox, draft, { text: "edited again" })).toMatchObject({
      ok: true,
      draft: { status: "draft", approval_reasons: [], expires_at: null },
    });
  });
});

describe("sendDraft", () => {
  it("an agent's send runs the rails and holds; only an approver sends it then", async () => {
    const inbox = await addInbox(w, { local: "approvals" });
    const hook = await createWebhookEndpoint(db, w.teamId, [
      "inbox.draft.sent",
      "inbox.thread.created",
      "inbox.email.sent",
    ]);
    const { draft } = await create(inbox, {
      to: "new@example.org",
      subject: "Intro",
      text: "Hello",
    });
    const held = await send(inbox, draft, inboxKey(inbox));
    expect(held).toMatchObject({
      kind: "draft",
      draft: { id: draft.id, status: "pending_approval", approval_reasons: ["send_policy"] },
    });
    for (const agent of [inboxKey(inbox), MCP]) {
      expect(await send(inbox, draft, agent)).toMatchObject({
        kind: "refused",
        error: { status: 403, name: "approval_required" },
      });
    }
    const out = await send(inbox, draft, TEAM_KEY);
    if (out.kind !== "sent") throw new Error(`not sent: ${JSON.stringify(out)}`);
    expect(out.email).toMatchObject({ to: ["new@example.org"], subject: "Intro", text: "Hello" });
    const row = await draftRow(draft.id);
    expect(row).toMatchObject({
      status: "sent",
      emailId: out.email.id,
      decidedBy: "api_key:00000000-0000-4000-8000-000000000001",
    });
    expect(row.decidedAt).not.toBeNull();
    const [email] = await db.select().from(schema.emails).where(eq(schema.emails.id, out.email.id));
    expect(email?.headers?.["Auto-Submitted"]).toBeUndefined();
    expect(await activity(inbox.id)).toEqual([
      "draft.created",
      "email.drafted",
      "draft.approved",
      "draft.sent",
      "email.sent",
    ]);
    expect(await events(hook)).toEqual([
      "inbox.draft.sent",
      "inbox.thread.created",
      "inbox.email.sent",
    ]);
    expect(await send(inbox, draft, TEAM_KEY)).toMatchObject({
      kind: "refused",
      error: { status: 409 },
    });
  });

  it("writes the dashboard approval to the audit log", async () => {
    const inbox = await addInbox(w, { local: "approvals-audit" });
    const { draft } = await create(inbox, {
      to: "new@example.org",
      subject: "Intro",
      text: "Hello",
    });
    await send(inbox, draft, inboxKey(inbox));
    expect((await send(inbox, draft, USER)).kind).toBe("sent");
    const audit = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.teamId, w.teamId));
    expect(audit.map((a) => [a.action, a.target])).toContainEqual([
      "inbox.draft_approved",
      `inbox_draft:${draft.id}`,
    ]);
  });

  it("sends a reply draft into its thread and replays an Idempotency-Key", async () => {
    const inbox = await addInbox(w, { local: "reply-send" });
    const threadId = await addThread(w, inbox.id);
    const target = await receive(w, { inbox, threadId });
    const { draft } = await create(inbox, {
      thread_id: threadId,
      reply_to_email_id: target.id,
      to: "ada@sender.example",
      text: "On it",
    });
    const first = await send(inbox, draft, inboxKey(inbox), "draft-key");
    if (first.kind !== "sent") throw new Error(`not sent: ${JSON.stringify(first)}`);
    expect(first).toMatchObject({
      threadId,
      email: { subject: "Re: Question", thread_id: threadId },
    });
    const [email] = await db
      .select()
      .from(schema.emails)
      .where(eq(schema.emails.id, first.email.id));
    expect(email?.headers?.["In-Reply-To"]).toBe(target.messageId);
    expect(email?.headers?.["Auto-Submitted"]).toBe("auto-replied");
    const replay = await send(inbox, draft, inboxKey(inbox), "draft-key");
    expect(replay).toMatchObject({ kind: "sent", email: { id: first.email.id } });
  });

  it("refuses a draft with no recipient (422)", async () => {
    const inbox = await addInbox(w, { local: "no-recipient" });
    const { draft } = await create(inbox, { subject: "Only a subject" });
    expect(await send(inbox, draft, TEAM_KEY)).toMatchObject({
      kind: "refused",
      error: { status: 422 },
    });
  });

  it("sends an approved forward with the original's files", async () => {
    const inbox = await addInbox(w, { local: "held-forward" });
    const threadId = await addThread(w, inbox.id);
    const target = await receive(w, {
      inbox,
      threadId,
      message: {
        attachments: [
          { filename: "a.pdf", content: Buffer.from("%PDF-1.4 x"), contentType: "application/pdf" },
        ],
      },
    });
    const held = (await forwardInThread(db, w.deps, {
      teamId: w.teamId,
      billing: await billing(w),
      actor: TEAM_KEY,
      inboxId: inbox.id,
      threadId,
      emailId: target.id,
      body: { to: "boss@example.org", text: "see below" },
    })) as SendOutcome;
    if (held.kind !== "draft") throw new Error("expected a held forward");
    expect(held.draft).toMatchObject({ forward: true, status: "pending_approval" });
    expect(held.draft.text).toContain("---------- Forwarded message ---------");
    const out = await send(inbox, held.draft, USER);
    expect(out).toMatchObject({
      kind: "sent",
      email: { subject: "Fwd: Question", attachments: [{ id: "0", filename: "a.pdf" }] },
    });
  });
});

describe("rejectDraft, deleteDraft and expireDrafts", () => {
  it("lets only an approver reject, and a rejected draft never sends", async () => {
    const inbox = await addInbox(w, { local: "reject" });
    const hook = await createWebhookEndpoint(db, w.teamId, ["inbox.draft.deleted"]);
    const { draft } = await create(inbox, { to: "new@example.org", subject: "S", text: "x" });
    await send(inbox, draft, inboxKey(inbox));
    for (const actor of [inboxKey(inbox), MCP]) {
      expect(
        await rejectDraft(db, w.deps, {
          teamId: w.teamId,
          inboxId: inbox.id,
          draftId: draft.id,
          actor,
        }),
      ).toMatchObject({ ok: false, error: { status: 403 } });
    }
    const out = await rejectDraft(db, w.deps, {
      teamId: w.teamId,
      inboxId: inbox.id,
      draftId: draft.id,
      actor: USER,
    });
    expect(out).toMatchObject({
      ok: true,
      draft: { status: "rejected", decided_by: "user:u1", text: "x" },
    });
    expect(await events(hook)).toEqual(["inbox.draft.deleted"]);
    expect(await send(inbox, draft, TEAM_KEY)).toMatchObject({
      kind: "refused",
      error: { status: 409 },
    });
    expect(await activity(inbox.id)).toContain("draft.rejected");
  });

  it("deletes an unsent draft; a sent one answers 409", async () => {
    const inbox = await addInbox(w, {
      local: "delete",
      safety: { send_policy: "allowlist", allowlist: ["*@ok.example"] },
    });
    const { draft } = await create(inbox, { to: "a@ok.example", subject: "S", text: "x" });
    const other = await create(inbox, { to: "b@ok.example", subject: "S", text: "x" });
    expect((await send(inbox, other.draft, inboxKey(inbox))).kind).toBe("sent");
    const remove = (d: DraftWire) =>
      deleteDraft(db, w.deps, {
        teamId: w.teamId,
        inboxId: inbox.id,
        draftId: d.id,
        actor: TEAM_KEY,
      });
    expect(await remove(other.draft)).toMatchObject({ ok: false, error: { status: 409 } });
    expect(await remove(draft)).toEqual({ ok: true });
    expect(await remove(draft)).toMatchObject({ ok: false, error: { status: 404 } });
  });

  it("expires drafts left pending past seven days, as deleted to webhooks", async () => {
    const inbox = await addInbox(w, { local: "expiry" });
    const hook = await createWebhookEndpoint(db, w.teamId, ["inbox.draft.deleted"]);
    const { draft } = await create(inbox, { to: "new@example.org", subject: "S", text: "x" });
    await send(inbox, draft, inboxKey(inbox));
    const row = await draftRow(draft.id);
    expect(await expireDrafts(db, w.deps, new Date(Date.now() + 6 * 86_400_000))).toBe(0);
    expect(await expireDrafts(db, w.deps, new Date((row.expiresAt?.getTime() ?? 0) + 1000))).toBe(
      1,
    );
    expect((await draftRow(draft.id)).status).toBe("expired");
    expect(await events(hook)).toEqual(["inbox.draft.deleted"]);
    expect(await activity(inbox.id)).toContain("draft.expired");
  });
});
