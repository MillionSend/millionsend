import { randomBytes, randomUUID } from "node:crypto";
import {
  defaultSafety,
  encodeInboxActor,
  type InboxSafety,
  type InboxWire,
  PLAN_INBOX_LIMIT,
  resolveMonitorSettings,
  safetyProblem,
  sealReceivedExtracted,
} from "@millionsend/core";
import { LABEL_COLORS } from "@millionsend/core/inbox-organize";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getKeyring } from "@/server/keyring";
import type { SessionRole } from "@/server/membership";
import { createCaller } from "@/server/routers";
import { createDomainsRouter } from "@/server/routers/domains";
import { type Context, createCallerFactory, router } from "@/server/trpc";

// Webhook secrets and the send deps build their keys from the env.
process.env.MASTER_ENCRYPTION_KEY = randomBytes(32).toString("base64");

// The inbox, thread, draft and quarantine functions belong to other groups;
// the router's contract with them (team from the session, the person as the
// actor, refusals mapped to codes) is what this file pins.
const core = vi.hoisted(() => ({
  listInboxes: vi.fn(),
  getInbox: vi.fn(),
  createInbox: vi.fn(),
  updateInbox: vi.fn(),
  deleteInboxes: vi.fn(),
  getInboxSafety: vi.fn(),
  updateInboxSafety: vi.fn(),
  listThreads: vi.fn(),
  searchThreads: vi.fn(),
  getThread: vi.fn(),
  updateThread: vi.fn(),
  listThreadEmails: vi.fn(),
  listDrafts: vi.fn(),
  getDraft: vi.fn(),
  sendDraft: vi.fn(),
  rejectDraft: vi.fn(),
  replyInThread: vi.fn(),
  listQuarantined: vi.fn(),
  releaseQuarantined: vi.fn(),
  releasePreview: vi.fn(),
}));
vi.mock("@millionsend/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@millionsend/core")>()),
  ...core,
}));
vi.mock("@/server/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/queue")>()),
  enqueueInboxForward: async () => {},
  enqueueDomainAge: async () => {},
}));

let db: Db;
let close: () => Promise<void>;
let acme: string;
let beta: string;
let domainId: string;
let inboxId: string;
let threadId: string;

const OWNER = { id: "u-owner", email: "Owner@Acme.test", name: "Olga Owner" };
const view = () => ({ grantId: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000) });

function caller(teamId: string, role: SessionRole = "owner", supportView?: Context["supportView"]) {
  return createCaller({
    db,
    session: { user: OWNER },
    teamId,
    role,
    supportView,
  });
}

function wire(id: string, over: Partial<InboxWire> = {}): InboxWire {
  return {
    object: "inbox",
    id,
    name: "Orders agent",
    email_address: "orders@in.acme.test",
    domain_id: domainId,
    receiving_address: null,
    from_name: null,
    unread: 0,
    drafts: 0,
    last_received: null,
    created_at: new Date().toISOString(),
    kind: "agent",
    shared: false,
    expires_at: null,
    quarantined: 0,
    pending_approval: 0,
    ...over,
  };
}

const user = { kind: "user", userId: OWNER.id };

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  acme = await createTeam(db, "inbox-acme");
  beta = await createTeam(db, "inbox-beta");
  await db.insert(schema.user).values([
    { id: OWNER.id, name: OWNER.name, email: OWNER.email },
    { id: "u-member", name: "Mo Member", email: "mo@acme.test" },
  ]);
  await db.insert(schema.teamMembers).values([
    { teamId: acme, userId: OWNER.id, role: "owner" },
    { teamId: acme, userId: "u-member", role: "member" },
  ]);
  const [domain] = await db
    .insert(schema.domains)
    .values({
      teamId: acme,
      name: "in.acme.test",
      region: "us-east-1",
      status: "verified",
      receivingEnabled: true,
      receivingCatchAll: true,
    })
    .returning({ id: schema.domains.id });
  if (!domain) throw new Error("no domain");
  domainId = domain.id;
  await db.insert(schema.domains).values({
    teamId: acme,
    name: "quiet.acme.test",
    region: "us-east-1",
    status: "verified",
  });
  const [inbox] = await db
    .insert(schema.inboxes)
    .values({
      teamId: acme,
      kind: "agent",
      emailAddress: "orders@in.acme.test",
      localPart: "orders",
      domainId,
      name: "Orders agent",
      safety: { ...defaultSafety("agent", false), forward_to: ["mo@acme.test"] },
    })
    .returning({ id: schema.inboxes.id });
  if (!inbox) throw new Error("no inbox");
  inboxId = inbox.id;
  const [thread] = await db
    .insert(schema.inboxThreads)
    .values({ teamId: acme, inboxId, subject: "Order #8841" })
    .returning({ id: schema.inboxThreads.id });
  if (!thread) throw new Error("no thread");
  threadId = thread.id;
});
afterAll(() => close());

beforeEach(() => {
  vi.stubEnv("RECEIVING_MX_HOST", "mx.example.net");
  for (const fn of Object.values(core)) fn.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** A received row of the team; content columns stay empty unless a test seals one. */
async function received(
  teamId: string,
  over: Partial<typeof schema.receivedEmails.$inferInsert> = {},
) {
  const [row] = await db
    .insert(schema.receivedEmails)
    .values({
      teamId,
      domainIds: [domainId],
      rawSha256: randomUUID(),
      messageId: `<${randomUUID()}@sender.example>`,
      from: "ana@sender.example",
      receivedFor: ["orders@in.acme.test"],
      envelope: { mailFrom: "", clientIp: "192.0.2.1", helo: "h", tls: null },
      authentication: { spf: "pass", dkim: "pass", dmarc: "pass", arc: "none" },
      sizeBytes: 100,
      ...over,
    })
    .returning({ id: schema.receivedEmails.id });
  if (!row) throw new Error("no row");
  return row.id;
}

describe("where the instance takes no mail", () => {
  it("answers every inbox procedure as a route that does not exist, admin ones included", async () => {
    vi.stubEnv("RECEIVING_MX_HOST", "");
    await expect(caller(acme).inboxes.list({})).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller(acme).inboxes.options()).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller(acme).inboxes.delete({ id: inboxId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      caller(acme).inboxes.updateSafety({ id: inboxId, patch: {} }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(core.listInboxes).not.toHaveBeenCalled();
    expect(core.deleteInboxes).not.toHaveBeenCalled();
  });
});

describe("tiers", () => {
  it("keeps deleting an inbox and changing its rules to owners and admins", async () => {
    await expect(caller(acme, "member").inboxes.delete({ id: inboxId })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      caller(acme, "member").inboxes.updateSafety({ id: inboxId, patch: { screening: false } }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(core.deleteInboxes).not.toHaveBeenCalled();
    expect(core.updateInboxSafety).not.toHaveBeenCalled();

    core.deleteInboxes.mockResolvedValue(1);
    await caller(acme, "admin").inboxes.delete({ id: inboxId });
    expect(core.deleteInboxes).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ receivingEnabled: true }),
      { teamId: acme, inboxIds: [inboxId], actor: user, reason: "deleted" },
    );
    core.deleteInboxes.mockResolvedValue(0);
    await expect(caller(beta).inboxes.delete({ id: inboxId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("lets any member work an inbox, always for the session's team and as the person", async () => {
    core.updateThread.mockResolvedValue({ ok: true, thread: { id: threadId } });
    await caller(acme, "member").inboxes.threads.update({ inboxId, threadId, folder: "archive" });
    expect(core.updateThread).toHaveBeenCalledWith(db, expect.anything(), {
      teamId: acme,
      inboxId,
      threadId,
      actor: user,
      read: undefined,
      folder: "archive",
      labelId: undefined,
      removeLabelId: undefined,
    });

    core.releaseQuarantined.mockResolvedValue({
      ok: true,
      outcome: "released",
      releasedAt: new Date(),
      trustedSender: null,
    });
    const emailId = randomUUID();
    await caller(beta, "member").inboxes.quarantine.release({
      inboxId,
      emailId,
      trustSender: false,
    });
    expect(core.releaseQuarantined).toHaveBeenCalledWith(db, expect.anything(), {
      teamId: beta,
      receivedEmailId: emailId,
      inboxId,
      actor: user,
      admin: false,
      trustSender: false,
    });
    core.releaseQuarantined.mockResolvedValue({ ok: false, reason: "allowlist_full" });
    await expect(
      caller(acme).inboxes.quarantine.release({ inboxId, emailId, trustSender: true }),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE_CONTENT" });
  });

  it("approves a held draft as the person, and maps what the send did", async () => {
    const draftId = randomUUID();
    core.sendDraft.mockResolvedValue({
      kind: "sent",
      email: { email_id: "email-1" },
      threadId,
      inboxId,
    });
    expect(await caller(acme, "member").inboxes.drafts.approve({ inboxId, draftId })).toEqual({
      kind: "sent",
      emailId: "email-1",
      threadId,
    });
    expect(core.sendDraft).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ isCloud: false, sharedInboxDomain: null }),
      expect.objectContaining({ teamId: acme, actor: user, inboxId, draftId }),
    );
    core.sendDraft.mockResolvedValue({
      kind: "draft",
      draft: { id: draftId, approval_reasons: ["ramp"] },
    });
    expect(await caller(acme).inboxes.drafts.approve({ inboxId, draftId })).toEqual({
      kind: "draft",
      draftId,
      reasons: ["ramp"],
    });
    core.sendDraft.mockResolvedValue({
      kind: "refused",
      error: { status: 429, name: "inbox_send_cap_reached", message: "Daily cap reached" },
    });
    await expect(caller(acme).inboxes.drafts.approve({ inboxId, draftId })).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
      message: "Daily cap reached",
    });
  });

  it("replies with the editor's html beside the text the thread shows", async () => {
    core.replyInThread.mockResolvedValue({
      kind: "sent",
      email: { email_id: "email-2" },
      threadId,
      inboxId,
    });
    const emailId = randomUUID();
    const html = "<p>Thanks, <strong>Ana</strong>.</p>";
    expect(
      await caller(acme, "member").inboxes.reply({
        inboxId,
        threadId,
        emailId,
        html,
        text: "Thanks, Ana.",
        replyAll: true,
      }),
    ).toEqual({ kind: "sent", emailId: "email-2", threadId });
    expect(core.replyInThread).toHaveBeenCalledWith(
      db,
      expect.anything(),
      expect.objectContaining({
        teamId: acme,
        actor: user,
        inboxId,
        threadId,
        emailId,
        body: { html, text: "Thanks, Ana.", reply_all: true },
      }),
    );
  });
});

describe("support view", () => {
  it("refuses every inbox mutation before it reaches the inbox", async () => {
    const operator = caller(acme, "viewer", view());
    await expect(
      operator.inboxes.create({ kind: "agent", acceptFrom: "verified", expiresIn: null }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: "Read-only support view" });
    await expect(
      operator.inboxes.quarantine.release({ inboxId, emailId: randomUUID(), trustSender: false }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      operator.inboxes.drafts.approve({ inboxId, draftId: randomUUID() }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(core.createInbox).not.toHaveBeenCalled();
    expect(core.releaseQuarantined).not.toHaveBeenCalled();
    expect(core.sendDraft).not.toHaveBeenCalled();
  });

  it("reads thread messages and drafts as their envelope only", async () => {
    core.listThreadEmails.mockResolvedValue({
      data: [
        {
          id: "m1",
          direction: "inbound",
          subject: "Order",
          html: "<p>secret</p>",
          text: "secret",
          extracted_text: "secret",
          screening: { verdict: "clean" },
        },
      ],
      hasMore: false,
    });
    const page = await caller(acme, "viewer", view()).inboxes.threads.emails({ inboxId, threadId });
    expect(core.listThreadEmails).toHaveBeenCalledWith(
      db,
      expect.anything(),
      // The pane renders the HTML: its cid: images come inlined.
      expect.objectContaining({
        envelopeOnly: true,
        agentView: false,
        includeHeld: true,
        inlineImages: true,
      }),
    );
    expect(page.items).toEqual([
      {
        id: "m1",
        direction: "inbound",
        subject: "Order",
        html: null,
        text: null,
        extracted_text: null,
        screening: { verdict: "clean", released_by: null, released_at: null },
      },
    ]);

    core.getDraft.mockResolvedValue({
      id: "d1",
      subject: "Re: Order",
      html: "<p>hi</p>",
      text: "hi",
    });
    expect(
      await caller(acme, "viewer", view()).inboxes.drafts.get({ inboxId, draftId: randomUUID() }),
    ).toEqual({ id: "d1", subject: "Re: Order", html: null, text: null });
    core.listDrafts.mockResolvedValue({ data: [{ id: "d1", snippet: "hi" }], hasMore: false });
    expect((await caller(acme, "viewer", view()).inboxes.drafts.list({ inboxId })).items).toEqual([
      { id: "d1", snippet: null },
    ]);

    // The owner reads the same message whole.
    expect(
      (await caller(acme).inboxes.threads.emails({ inboxId, threadId })).items[0],
    ).toMatchObject({
      text: "secret",
    });
  });
});

describe("releasing held mail", () => {
  it("releases as the person with their role, the keyring and the queues, answering what happened", async () => {
    const emailId = randomUUID();
    core.releaseQuarantined.mockResolvedValue({
      ok: true,
      outcome: "released",
      releasedAt: new Date("2026-10-17T12:00:00Z"),
      trustedSender: "ana@sender.example",
    });
    expect(
      await caller(acme, "admin").inboxes.quarantine.release({
        inboxId,
        emailId,
        trustSender: true,
      }),
    ).toEqual({
      outcome: "released",
      releasedAt: new Date("2026-10-17T12:00:00Z"),
      trustedSender: "ana@sender.example",
    });
    // The keyring goes along, so the events of released mail name their attachments.
    expect(core.releaseQuarantined).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        keyring: getKeyring(),
        enqueueInboxForward: expect.any(Function),
      }),
      {
        teamId: acme,
        receivedEmailId: emailId,
        inboxId,
        actor: user,
        admin: true,
        trustSender: true,
      },
    );
    core.releaseQuarantined.mockResolvedValue({
      ok: true,
      outcome: "held_again",
      reason: "injection",
      injectionScore: 92,
      phishingScore: 40,
    });
    expect(
      await caller(acme).inboxes.quarantine.release({
        inboxId,
        emailId,
        trustSender: false,
        reviewed: "not_allowlisted",
      }),
    ).toEqual({
      outcome: "held_again",
      reason: "injection",
      injectionScore: 92,
      phishingScore: 40,
    });
    // The hold the dialog showed goes along, so one held again since is never released on it.
    expect(core.releaseQuarantined).toHaveBeenLastCalledWith(
      db,
      expect.anything(),
      expect.objectContaining({ reviewed: "not_allowlisted" }),
    );
  });

  it("answers each refusal with the key the dialog shows copy for", async () => {
    const release = () =>
      caller(acme).inboxes.quarantine.release({
        inboxId,
        emailId: randomUUID(),
        trustSender: true,
      });
    for (const [reason, code] of [
      ["trust_not_allowed", "FORBIDDEN"],
      ["forbidden", "FORBIDDEN"],
      ["not_quarantined", "CONFLICT"],
      ["allowlist_full", "UNPROCESSABLE_CONTENT"],
    ] as const) {
      core.releaseQuarantined.mockResolvedValue({ ok: false, reason });
      await expect(release()).rejects.toMatchObject({ code, message: reason });
    }
    core.releaseQuarantined.mockResolvedValue({ ok: false, reason: "not_found" });
    await expect(release()).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("previews a hold for the person, without its text under a support view", async () => {
    const emailId = randomUUID();
    core.releasePreview.mockResolvedValue({ reason: "not_allowlisted", trustOffered: false });
    expect(await caller(acme, "member").inboxes.quarantine.preview({ inboxId, emailId })).toEqual({
      reason: "not_allowlisted",
      trustOffered: false,
    });
    expect(core.releasePreview).toHaveBeenLastCalledWith(db, getKeyring(), {
      teamId: acme,
      inboxId,
      receivedEmailId: emailId,
      actor: user,
      admin: false,
      judgeConfigured: false,
      withText: true,
    });
    await caller(acme, "viewer", view()).inboxes.quarantine.preview({ inboxId: null, emailId });
    expect(core.releasePreview).toHaveBeenLastCalledWith(
      db,
      expect.anything(),
      expect.objectContaining({ inboxId: null, withText: false }),
    );
    core.releasePreview.mockResolvedValue("not_quarantined");
    await expect(
      caller(acme).inboxes.quarantine.preview({ inboxId, emailId }),
    ).rejects.toMatchObject({ code: "CONFLICT", message: "not_quarantined" });
  });

  it("says who released a message in the thread, and when", async () => {
    const releasedId = await received(acme);
    const keptId = await received(acme);
    const at = new Date("2026-10-17T09:30:00Z");
    await db.insert(schema.receivedEmailInboxes).values([
      {
        receivedEmailId: releasedId,
        inboxId,
        teamId: acme,
        threadId,
        address: "orders@in.acme.test",
        senderTrust: "external",
        verdict: "released",
        quarantineReason: "not_allowlisted",
        quarantinedAt: at,
        deliveredAt: at,
        releasedAt: at,
        releasedBy: encodeInboxActor({ kind: "user", userId: OWNER.id }),
      },
      {
        receivedEmailId: keptId,
        inboxId,
        teamId: acme,
        threadId,
        address: "orders@in.acme.test",
        senderTrust: "external",
        verdict: "clean",
        deliveredAt: at,
      },
    ]);
    core.listThreadEmails.mockResolvedValue({
      data: [
        { id: releasedId, direction: "inbound", screening: { verdict: "released" } },
        { id: keptId, direction: "inbound", screening: { verdict: "clean" } },
        { id: "sent-1", direction: "outbound" },
      ],
      hasMore: false,
    });
    const page = await caller(acme, "member").inboxes.threads.emails({ inboxId, threadId });
    expect(page.items).toEqual([
      {
        id: releasedId,
        direction: "inbound",
        screening: {
          verdict: "released",
          released_by: OWNER.name,
          released_at: at.toISOString(),
        },
      },
      {
        id: keptId,
        direction: "inbound",
        screening: { verdict: "clean", released_by: null, released_at: null },
      },
      { id: "sent-1", direction: "outbound" },
    ]);
  });
});

describe("safety rules", () => {
  // The rules a stored shared inbox has, run through the real safetyProblem,
  // as the inbox group's updateInboxSafety does.
  beforeEach(() => {
    core.updateInboxSafety.mockImplementation(
      async (_db: Db, _deps: unknown, p: { patch: Partial<InboxSafety> }) => {
        const merged = { ...defaultSafety("agent", true), ...p.patch };
        const problem = safetyProblem(merged, {
          kind: "agent",
          shared: true,
          teamTierNew: false,
          memberEmails: [],
        });
        return problem
          ? { ok: false, error: { status: 422, name: "validation_error", message: problem } }
          : { ok: true, safety: merged };
      },
    );
  });

  it("answers a rule the inbox cannot have with safetyProblem's own words", async () => {
    await expect(
      caller(acme).inboxes.updateSafety({ id: inboxId, patch: { send_policy: "open" } }),
    ).rejects.toMatchObject({
      code: "UNPROCESSABLE_CONTENT",
      message: "Addresses on the shared domain only reply inside their threads",
    });
    await expect(
      caller(acme).inboxes.updateSafety({ id: inboxId, patch: { send_cap: 51 } }),
    ).rejects.toMatchObject({
      code: "UNPROCESSABLE_CONTENT",
      message: expect.stringContaining("send_cap"),
    });
  });

  it("refuses an entry that is no address before the inbox sees it, in the entry's words", async () => {
    await expect(
      caller(acme).inboxes.updateSafety({ id: inboxId, patch: { allowlist: ["not an address"] } }),
    ).rejects.toMatchObject({
      code: "UNPROCESSABLE_CONTENT",
      message: expect.stringContaining('"not an address"'),
    });
    expect(core.updateInboxSafety).not.toHaveBeenCalled();
  });

  it("hands the inbox a normalized patch, with no key it was not given, and the team's plan", async () => {
    await db.update(schema.teams).set({ plan: "pro" }).where(eq(schema.teams.id, acme));
    try {
      await caller(acme).inboxes.updateSafety({
        id: inboxId,
        patch: { allowlist: ["Ana@Example.COM", "*@Stripe.com", "ana@example.com"] },
      });
    } finally {
      await db.update(schema.teams).set({ plan: "free" }).where(eq(schema.teams.id, acme));
    }
    expect(core.updateInboxSafety).toHaveBeenCalledWith(db, expect.anything(), {
      teamId: acme,
      inboxId,
      actor: user,
      patch: { allowlist: ["ana@example.com", "*@stripe.com"] },
      plan: "pro",
      isCloud: false,
    });
  });

  it("offers forward targets from the team's members, and the instance's retention", async () => {
    core.getInboxSafety.mockResolvedValue(defaultSafety("agent", false));
    const read = await caller(acme, "member").inboxes.safety({ id: inboxId });
    expect(read.memberEmails).toEqual(["mo@acme.test", "owner@acme.test"]);
    expect(read.retentionDays).toBeGreaterThan(0);
    // Whole rows leaving first cut the bodies' longer clock short.
    vi.stubEnv("EMAIL_RETENTION_DAYS", "90");
    vi.stubEnv("EMAIL_METADATA_RETENTION_DAYS", "7");
    expect((await caller(acme, "member").inboxes.safety({ id: inboxId })).retentionDays).toBe(7);
    core.getInboxSafety.mockResolvedValue(null);
    await expect(caller(beta).inboxes.safety({ id: inboxId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(core.getInboxSafety).toHaveBeenLastCalledWith(db, { teamId: beta, inboxId });
  });
});

describe("activity", () => {
  it("lists who did what, newest first, with each actor's name and no other team's rows", async () => {
    const [key] = await db
      .insert(schema.apiKeys)
      .values({
        teamId: acme,
        name: "Agent key",
        tokenPrefix: "ms_actkey",
        keyHash: "h",
        last4: "abcd",
      })
      .returning({ id: schema.apiKeys.id });
    if (!key) throw new Error("no key");
    await db
      .insert(schema.oauthClient)
      .values({ id: "c1", clientId: "client-1", name: "Claude", redirectUris: [] });
    // Rows a second apart: the trail orders on created_at, and inserts in one
    // test can share a timestamp.
    const at = (seconds: number) => new Date(Date.UTC(2026, 9, 12, 10, 0, seconds));
    await db.insert(schema.inboxActivity).values([
      {
        teamId: acme,
        inboxId,
        actor: encodeInboxActor({ kind: "system" }),
        action: "email.quarantined",
        createdAt: at(1),
      },
      {
        teamId: acme,
        inboxId,
        actor: encodeInboxActor({ kind: "oauth", clientId: "client-1", userId: OWNER.id }),
        action: "email.drafted",
        decision: { result: "draft", reasons: ["ramp"] },
        createdAt: at(2),
      },
      {
        teamId: acme,
        inboxId,
        actor: encodeInboxActor({ kind: "api_key", apiKeyId: key.id, inboxId }),
        action: "code.read",
        createdAt: at(3),
      },
      {
        teamId: acme,
        inboxId,
        actor: encodeInboxActor({ kind: "user", userId: OWNER.id }),
        action: "email.released",
        createdAt: at(4),
      },
      {
        teamId: beta,
        inboxId,
        actor: encodeInboxActor({ kind: "system" }),
        action: "inbox.created",
        createdAt: at(5),
      },
    ]);

    const first = await caller(acme).inboxes.activity.list({ inboxId, limit: 2 });
    expect(first.items.map((row) => [row.action, row.actor])).toEqual([
      ["email.released", { kind: "user", name: "Olga Owner" }],
      ["code.read", { kind: "api_key", name: "Agent key" }],
    ]);
    if (!first.nextCursor) throw new Error("expected another page");
    const second = await caller(acme).inboxes.activity.list({
      inboxId,
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.items.map((row) => [row.action, row.actor, row.decision])).toEqual([
      ["email.drafted", { kind: "oauth", name: "Claude" }, { result: "draft", reasons: ["ramp"] }],
      ["email.quarantined", { kind: "system", name: null }, null],
    ]);
    expect(second.nextCursor).toBeNull();
    expect((await caller(beta).inboxes.activity.list({ inboxId })).items).toHaveLength(1);
  });
});

describe("the inbox list", () => {
  it("adds what needs attention, the 30-day count and the pinned received rows", async () => {
    const held = await received(acme, { catchAll: false });
    await db.insert(schema.receivedEmailInboxes).values({
      receivedEmailId: held,
      inboxId,
      teamId: acme,
      threadId,
      address: "orders@in.acme.test",
      senderTrust: "external",
      verdict: "quarantined",
      quarantineReason: "injection",
      quarantinedAt: new Date(),
    });
    await received(acme);
    await db.insert(schema.inboxDrafts).values({
      teamId: acme,
      inboxId,
      type: "standalone",
      to: ["x@example.com"],
      status: "pending_approval",
      createdBy: "user:u-owner",
    });
    await db.insert(schema.inboxUsageDaily).values([
      { inboxId, day: new Date().toISOString().slice(0, 10), received: 7 },
      { inboxId, day: "2020-01-01", received: 100 },
    ]);
    core.listInboxes.mockResolvedValue({ data: [wire(inboxId)], hasMore: false });

    const page = await caller(acme).inboxes.list({});
    expect(core.listInboxes).toHaveBeenCalledWith(db, {
      teamId: acme,
      query: { limit: 50, after: undefined },
      kind: undefined,
    });
    expect(page.items[0]).toMatchObject({
      id: inboxId,
      pending_approval: 1,
      quarantined: 1,
      received_30d: 7,
      forward_to: ["mo@acme.test"],
    });
    expect(page.counts).toEqual({ agent: 1, human: 0 });
    expect(page.overview?.allReceived.received30d).toBeGreaterThanOrEqual(2);
    // Only the catch-all domain that receives gets a row, counting its catch-all mail.
    expect(page.overview?.catchAll).toEqual([
      {
        domainId,
        name: "in.acme.test",
        received30d: expect.any(Number),
        lastReceived: expect.any(Date),
      },
    ]);
    expect(page.overview?.catchAll[0]?.received30d).toBeGreaterThanOrEqual(1);
    expect(page.nextCursor).toBeNull();

    core.listInboxes.mockResolvedValue({ data: [wire(inboxId)], hasMore: true });
    const next = await caller(acme).inboxes.list({ kind: "agent", cursor: inboxId });
    expect(next.nextCursor).toBe(inboxId);
    expect(next.counts).toBeNull();
    expect(next.overview).toBeNull();
    core.listInboxes.mockResolvedValue("bad_cursor");
    await expect(caller(acme).inboxes.list({ cursor: randomUUID() })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("offers the receiving domains, the shared domain and the plan's room to create", async () => {
    vi.stubEnv("SHARED_INBOX_DOMAIN", "agents.example.net");
    vi.stubEnv("IS_CLOUD", "true");
    const options = await caller(acme).inboxes.options();
    expect(options.domains).toEqual([{ id: domainId, name: "in.acme.test" }]);
    expect(options.sharedDomain).toBe("agents.example.net");
    expect(options.plan).toEqual({ used: 1, limit: PLAN_INBOX_LIMIT.free });
    vi.stubEnv("IS_CLOUD", "");
    expect((await caller(acme).inboxes.options()).plan.limit).toBeNull();
  });

  it("says what the team's shared addresses may send, on its effective plan", async () => {
    const sending = async (ctx: Partial<Context> = {}) =>
      (
        await createCaller({
          db,
          session: { user: OWNER },
          teamId: acme,
          role: "owner",
          ...ctx,
        }).inboxes.options()
      ).sharedSending;
    expect(await sending()).toBeNull();
    vi.stubEnv("SHARED_INBOX_DOMAIN", "agents.example.net");
    vi.stubEnv("IS_CLOUD", "true");
    expect(await sending()).toEqual({ mode: "reply_only", cause: "instance" });
    vi.stubEnv("SHARED_INBOX_OPEN", "true");
    vi.stubEnv("ABUSE_JUDGE", "typesafe");
    expect(await sending()).toEqual({ mode: "reply_only", cause: "plan" });
    vi.stubEnv("IS_CLOUD", "");
    expect(await sending()).toEqual({ mode: "open", cause: null });
    // The process's cached settings, where the request carries them, over the stored row.
    const paused = { ...resolveMonitorSettings(null, {}).settings, sharedInboxSend: false };
    expect(await sending({ monitorSettings: async () => paused })).toEqual({
      mode: "receive_only",
      cause: "instance",
    });

    core.getInbox.mockResolvedValue(wire(inboxId));
    expect((await caller(acme).inboxes.get({ id: inboxId })).sharedSending).toBeNull();
    core.getInbox.mockResolvedValue(wire(inboxId, { shared: true }));
    expect((await caller(acme).inboxes.get({ id: inboxId })).sharedSending).toEqual({
      mode: "open",
      cause: null,
    });
  });

  it("says when an inbox expired, and which channels reach it", async () => {
    core.getInbox.mockResolvedValue(
      wire(inboxId, { expires_at: new Date(Date.now() - 1000).toISOString() }),
    );
    let inbox = await caller(acme).inboxes.get({ id: inboxId });
    expect(core.getInbox).toHaveBeenCalledWith(db, {
      teamId: acme,
      idOrEmail: inboxId,
      now: new Date(0),
    });
    expect(inbox).toMatchObject({ expired: true, channels: { webhook: false, key: false } });

    const dummy = Buffer.alloc(1);
    await db.insert(schema.webhookEndpoints).values({
      teamId: acme,
      url: "https://hook.example.com/in",
      secretCiphertext: dummy,
      secretIv: dummy,
      secretWrappedDek: dummy,
      secretKeyVersion: 1,
      secretLast4: "abcd",
      events: ["inbox.email.received"],
      inboxIds: [inboxId],
    });
    core.getInbox.mockResolvedValue(wire(inboxId));
    inbox = await caller(acme).inboxes.get({ id: inboxId });
    expect(inbox).toMatchObject({ expired: false, channels: { webhook: true } });
    core.getInbox.mockResolvedValue(null);
    await expect(caller(beta).inboxes.get({ id: inboxId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("creating an inbox", () => {
  it("builds the address from the team's receiving domain and the person's choices", async () => {
    core.createInbox.mockResolvedValue({ ok: true, inbox: wire(randomUUID()) });
    await caller(acme, "member").inboxes.create({
      kind: "human",
      name: "Support",
      localPart: "Support",
      domainId,
      acceptFrom: "anyone",
      expiresIn: "7d",
    });
    expect(core.createInbox).toHaveBeenCalledWith(
      db,
      expect.anything(),
      expect.objectContaining({
        teamId: acme,
        plan: "free",
        actor: user,
        input: {
          email_address: "support@in.acme.test",
          name: "Support",
          kind: "human",
          expires_in: "7d",
          safety: { accept_from: "anyone" },
        },
      }),
    );
  });

  it("asks for a random shared address when no domain is picked", async () => {
    core.createInbox.mockResolvedValue({ ok: true, inbox: wire(randomUUID()) });
    await caller(acme).inboxes.create({ kind: "agent", acceptFrom: "verified", expiresIn: "24h" });
    expect(core.createInbox.mock.calls[0]?.[2].input).toEqual({
      email_address: undefined,
      name: undefined,
      kind: "agent",
      expires_in: "24h",
      safety: { accept_from: "verified" },
    });
  });

  it("asks for a shared address by username when a local part comes without a domain", async () => {
    core.createInbox.mockResolvedValue({ ok: true, inbox: wire(randomUUID()) });
    await caller(acme).inboxes.create({
      kind: "agent",
      localPart: " Leo.Bot ",
      acceptFrom: "verified",
      expiresIn: null,
    });
    expect(core.createInbox.mock.calls[0]?.[2].input).toEqual({
      email_address: undefined,
      username: "leo.bot",
      name: undefined,
      kind: "agent",
      expires_in: null,
      safety: { accept_from: "verified" },
    });
  });

  it("hands the sender name on trimmed, and none when the field was left empty", async () => {
    core.createInbox.mockResolvedValue({
      ok: true,
      inbox: wire(randomUUID(), { from_name: "Orders agent" }),
    });
    const named = await caller(acme).inboxes.create({
      kind: "agent",
      name: "Orders agent",
      fromName: " Orders agent ",
      acceptFrom: "verified",
      expiresIn: null,
    });
    expect(core.createInbox.mock.calls[0]?.[2].input.from_name).toBe("Orders agent");
    expect(named.from_name).toBe("Orders agent");
    core.createInbox.mockResolvedValue({ ok: true, inbox: wire(randomUUID()) });
    const bare = await caller(acme).inboxes.create({
      kind: "agent",
      fromName: " ",
      acceptFrom: "verified",
      expiresIn: null,
    });
    expect(core.createInbox.mock.calls[1]?.[2].input.from_name).toBeUndefined();
    expect(bare.from_name).toBeNull();
  });

  it("hands names to the shared domain's review where a judge is configured", async () => {
    core.createInbox.mockResolvedValue({ ok: true, inbox: wire(randomUUID()) });
    core.updateInbox.mockResolvedValue({ ok: true, inbox: wire(inboxId) });
    const create = () =>
      caller(acme).inboxes.create({ kind: "agent", acceptFrom: "verified", expiresIn: null });
    const update = () => caller(acme).inboxes.update({ id: inboxId, fromName: "Desk" });
    await create();
    await update();
    expect(core.createInbox.mock.calls[0]?.[1].judgeSharedNames).toBeUndefined();
    expect(core.updateInbox.mock.calls[0]?.[1].judgeSharedNames).toBeUndefined();
    vi.stubEnv("ABUSE_JUDGE", "typesafe");
    vi.stubEnv("ABUSE_JUDGE_API_KEY", "test-key");
    await create();
    await update();
    expect(core.createInbox.mock.calls[1]?.[1].judgeSharedNames).toBeTypeOf("function");
    expect(core.updateInbox.mock.calls[1]?.[1].judgeSharedNames).toBeTypeOf("function");
  });

  it("takes any address as a name, the one an unnamed inbox gets, and refuses longer before the inbox sees it", async () => {
    core.createInbox.mockResolvedValue({ ok: true, inbox: wire(randomUUID()) });
    core.updateInbox.mockResolvedValue({ ok: true, inbox: wire(inboxId) });
    const create = (name: string) =>
      caller(acme).inboxes.create({ kind: "agent", name, acceptFrom: "verified", expiresIn: null });
    const update = (name: string) => caller(acme).inboxes.update({ id: inboxId, name });
    const address = `${"x".repeat(64)}@acme.agents.example.net`;
    await create(address);
    await update(address);
    expect(core.createInbox.mock.calls[0]?.[2].input.name).toBe(address);
    expect(core.updateInbox.mock.calls[0]?.[2].patch.name).toBe(address);
    const tooLong = "x".repeat(321);
    await expect(create(tooLong)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(update(tooLong)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(core.createInbox).toHaveBeenCalledTimes(1);
    expect(core.updateInbox).toHaveBeenCalledTimes(1);
  });

  it("refuses a domain that does not receive, and maps the inbox's own refusals", async () => {
    const [quiet] = await db
      .select({ id: schema.domains.id })
      .from(schema.domains)
      .where(eq(schema.domains.name, "quiet.acme.test"));
    if (!quiet) throw new Error("no domain");
    await expect(
      caller(acme).inboxes.create({
        kind: "agent",
        localPart: "bot",
        domainId: quiet.id,
        acceptFrom: "verified",
        expiresIn: null,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "not_receiving" });
    await expect(
      caller(beta).inboxes.create({
        kind: "agent",
        localPart: "bot",
        domainId,
        acceptFrom: "verified",
        expiresIn: null,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(core.createInbox).not.toHaveBeenCalled();

    for (const [status, code] of [
      [409, "CONFLICT"],
      [403, "FORBIDDEN"],
      [429, "TOO_MANY_REQUESTS"],
      [503, "SERVICE_UNAVAILABLE"],
    ] as const) {
      core.createInbox.mockResolvedValue({
        ok: false,
        error: { status, name: "validation_error", message: `refused ${status}` },
      });
      await expect(
        caller(acme).inboxes.create({ kind: "agent", acceptFrom: "verified", expiresIn: "1h" }),
      ).rejects.toMatchObject({ code, message: `refused ${status}` });
    }
  });

  it("offers the team's shared subdomain, or the parent domain while its name review is pending, claiming nothing", async () => {
    const [team] = await db
      .insert(schema.teams)
      .values({ name: "Orbit Desk", slug: "inbox-orbit" })
      .returning({ id: schema.teams.id });
    const teamId = team?.id as string;
    expect(await caller(teamId).inboxes.options()).toMatchObject({ sharedDomain: null });
    vi.stubEnv("SHARED_INBOX_DOMAIN", "agents.example.net");
    expect(await caller(teamId).inboxes.options()).toMatchObject({
      sharedDomain: "agents.example.net",
    });
    const labels = () =>
      db
        .select({ name: schema.sharedInboxDomains.name })
        .from(schema.sharedInboxDomains)
        .where(eq(schema.sharedInboxDomains.teamId, teamId));
    expect(await labels()).toEqual([]);
    await db
      .insert(schema.sharedInboxDomains)
      .values({ teamId, name: "orbit-desk.agents.example.net" });
    expect(await caller(teamId, "member").inboxes.options()).toMatchObject({
      sharedDomain: "orbit-desk.agents.example.net",
    });
  });
});

describe("sending from a shared address", () => {
  it("reads the instance's switches through the request's settings reader", async () => {
    vi.stubEnv("SHARED_INBOX_DOMAIN", "agents.example.net");
    const [sub] = await db
      .insert(schema.sharedInboxDomains)
      .values({ teamId: acme, name: "acme.agents.example.net" })
      .returning({ id: schema.sharedInboxDomains.id });
    const [shared] = await db
      .insert(schema.inboxes)
      .values({
        teamId: acme,
        kind: "human",
        emailAddress: "desk@acme.agents.example.net",
        localPart: "desk",
        sharedDomainId: sub?.id,
        name: "Desk",
        safety: defaultSafety("human", true),
      })
      .returning({ id: schema.inboxes.id });
    const paused = { ...resolveMonitorSettings(null, {}).settings, sharedInboxSend: false };
    const send = createCaller({
      db,
      session: { user: OWNER },
      teamId: acme,
      role: "owner",
      monitorSettings: async () => paused,
    }).inboxes.send({
      inboxId: shared?.id as string,
      to: ["ana@example.com"],
      subject: "Hello",
      text: "Hi",
    });
    await expect(send).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Sending from addresses on the shared domain is paused; mail to them still arrives",
    });
  });
});

describe("thread rows", () => {
  it("carry the thread's held mail, the judge's score and a draft waiting", async () => {
    const mail = await received(acme, { catchAll: false });
    await db.insert(schema.receivedEmailInboxes).values({
      receivedEmailId: mail,
      inboxId,
      teamId: acme,
      threadId,
      address: "orders@in.acme.test",
      senderTrust: "external",
      verdict: "quarantined",
      quarantineReason: "phishing",
      injectionScore: 97,
      quarantinedAt: new Date(Date.now() + 1000),
    });
    await db.insert(schema.inboxDrafts).values({
      teamId: acme,
      inboxId,
      type: "reply",
      threadId,
      replyToEmailId: mail,
      status: "pending_approval",
      createdBy: "system",
    });
    const other = randomUUID();
    core.listThreads.mockResolvedValue({
      data: [
        { id: threadId, labels: [] },
        { id: other, labels: [] },
      ],
      hasMore: false,
    });
    const page = await caller(acme).inboxes.threads.list({ inboxId, folders: ["inbox"] });
    expect(core.listThreads).toHaveBeenCalledWith(db, {
      teamId: acme,
      inboxId,
      query: {
        folders: ["inbox"],
        labels: undefined,
        read: undefined,
        limit: 50,
        after: undefined,
        includeHeld: true,
      },
      agentView: false,
    });
    expect(page.items[0]).toMatchObject({
      id: threadId,
      quarantined: 2,
      quarantine_reason: "phishing",
      injection_score: 97,
      pending_approval: true,
      snippet: null,
    });
    // A thread the team does not hold reads as having nothing.
    expect(page.items[1]).toMatchObject({ id: other, quarantined: 0, pending_approval: false });
  });

  it("show the newest delivered message's first line, never a code's, and flag a warned delivery", async () => {
    const thread = async () => {
      const [row] = await db
        .insert(schema.inboxThreads)
        .values({ teamId: acme, inboxId, subject: "Order" })
        .returning({ id: schema.inboxThreads.id });
      if (!row) throw new Error("no thread");
      return row.id;
    };
    // A message of the thread whose sealed read is `text`, delivered at `at` unless `over` holds it.
    const message = async (
      thread: string,
      text: string,
      at: Date,
      over: Partial<typeof schema.receivedEmailInboxes.$inferInsert> = {},
      kinds: ("code" | "link")[] = [],
    ) => {
      const id = await received(acme, { catchAll: false, extractedKinds: kinds });
      const extracted = await sealReceivedExtracted(
        { text, quoted: "", signature: "", code: null, link: null, flags: [] },
        getKeyring(),
        { teamId: acme, rowId: id },
      );
      await db
        .update(schema.receivedEmails)
        .set({ extracted })
        .where(eq(schema.receivedEmails.id, id));
      await db.insert(schema.receivedEmailInboxes).values({
        receivedEmailId: id,
        inboxId,
        teamId: acme,
        threadId: thread,
        address: "orders@in.acme.test",
        senderTrust: "external",
        verdict: "clean",
        deliveredAt: at,
        createdAt: at,
        ...over,
      });
    };
    const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);
    const plain = await thread();
    await message(plain, "An older message", minutesAgo(30));
    await message(plain, "Oi,\ncomprei na sexta​ e o rastreio parou.", minutesAgo(20), {
      verdict: "suspicious",
      injectionScore: 62,
      phishingScore: 12,
    });
    await message(plain, "Held for review", minutesAgo(10), {
      verdict: "quarantined",
      quarantineReason: "injection",
      deliveredAt: null,
      quarantinedAt: minutesAgo(10),
    });
    const code = await thread();
    await message(code, "Your code is 482913", minutesAgo(5), {}, ["code"]);
    core.listThreads.mockResolvedValue({
      data: [
        { id: plain, labels: [] },
        { id: code, labels: [] },
      ],
      hasMore: false,
    });

    const [first, second] = (await caller(acme).inboxes.threads.list({ inboxId })).items;
    expect(first).toMatchObject({
      snippet: "Oi, comprei na sexta e o rastreio parou.",
      suspicious: true,
      injection_score: 62,
      phishing_score: 12,
      quarantined: 1,
    });
    expect(second).toMatchObject({ snippet: null, suspicious: false, phishing_score: null });
    // A support view reads rows as their envelope: no message text at all.
    const viewed = (await caller(acme, "viewer", view()).inboxes.threads.list({ inboxId })).items;
    expect(viewed.map((row) => row.snippet)).toEqual([null, null]);
  });
});

describe("catch-all", () => {
  it("is turned on by owners and admins on a paid plan, and off by them on any plan", async () => {
    vi.stubEnv("IS_CLOUD", "true");
    await expect(
      caller(acme, "member").domains.setCatchAll({ id: domainId, enabled: false }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await caller(acme).domains.setCatchAll({ id: domainId, enabled: false })).toEqual({
      receivingCatchAll: false,
    });
    await expect(
      caller(acme).domains.setCatchAll({ id: domainId, enabled: true }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "Catch-all receiving needs a paid plan",
    });
    expect(await caller(acme).domains.get({ id: domainId })).toMatchObject({
      receivingCatchAll: false,
      catchAllAllowed: false,
      inboxCount: 1,
    });

    await db.update(schema.teams).set({ plan: "pro" }).where(eq(schema.teams.id, acme));
    expect(
      await caller(acme, "admin").domains.setCatchAll({ id: domainId, enabled: true }),
    ).toEqual({
      receivingCatchAll: true,
    });
    const audit = await db
      .select({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.teamId, acme));
    expect(audit.map((row) => row.action)).toEqual([
      "domain.catch_all_disabled",
      "domain.catch_all_enabled",
    ]);
    await db.update(schema.teams).set({ plan: "free" }).where(eq(schema.teams.id, acme));
  });

  it("needs the domain to receive, and the instance to take mail", async () => {
    const [quiet] = await db
      .select({ id: schema.domains.id })
      .from(schema.domains)
      .where(eq(schema.domains.name, "quiet.acme.test"));
    if (!quiet) throw new Error("no domain");
    await expect(
      caller(acme).domains.setCatchAll({ id: quiet.id, enabled: true }),
    ).rejects.toMatchObject({
      code: "UNPROCESSABLE_CONTENT",
      message: "Turn on receiving for this domain first",
    });
    vi.stubEnv("RECEIVING_MX_HOST", "");
    await expect(
      caller(acme).domains.setCatchAll({ id: domainId, enabled: true }),
    ).rejects.toMatchObject({
      code: "UNPROCESSABLE_CONTENT",
    });
  });
});

describe("deleting a domain", () => {
  it("deletes its inboxes first, through the same path as deleting one", async () => {
    // No AWS: the identity calls answer nothing.
    const domains = createCallerFactory(
      router({
        domains: createDomainsRouter({
          clientForRegion: () => ({ send: async () => ({}) }),
          resolveNs: async () => [],
        }),
      }),
    )({ db, session: { user: OWNER }, teamId: acme, role: "owner" });
    const [doomed] = await db
      .insert(schema.domains)
      .values({ teamId: acme, name: "old.acme.test", region: "us-east-1", status: "verified" })
      .returning({ id: schema.domains.id });
    if (!doomed) throw new Error("no domain");
    const [inbox] = await db
      .insert(schema.inboxes)
      .values({
        teamId: acme,
        kind: "human",
        emailAddress: "help@old.acme.test",
        localPart: "help",
        domainId: doomed.id,
        name: "Help",
        safety: defaultSafety("human", false),
      })
      .returning({ id: schema.inboxes.id });
    if (!inbox) throw new Error("no inbox");
    core.deleteInboxes.mockResolvedValue(1);
    await domains.domains.delete({ id: doomed.id });
    expect(core.deleteInboxes).toHaveBeenCalledWith(db, expect.anything(), {
      teamId: acme,
      inboxIds: [inbox.id],
      actor: user,
      reason: "domain_deleted",
    });
    expect(await db.select().from(schema.domains).where(eq(schema.domains.id, doomed.id))).toEqual(
      [],
    );

    // A domain without inboxes never calls into them.
    core.deleteInboxes.mockClear();
    const [plain] = await db
      .insert(schema.domains)
      .values({ teamId: acme, name: "plain.acme.test", region: "us-east-1", status: "verified" })
      .returning({ id: schema.domains.id });
    await domains.domains.delete({ id: plain?.id ?? "" });
    expect(core.deleteInboxes).not.toHaveBeenCalled();
  });
});

describe("inbox-scoped API keys", () => {
  it("are full access, bound to one inbox of the team, and capped per inbox outside the team's cap", async () => {
    const mint = (input: Parameters<ReturnType<typeof caller>["apiKeys"]["create"]>[0]) =>
      caller(acme).apiKeys.create(input);
    await expect(mint({ name: "k", permission: "sending_access", inboxId })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(mint({ name: "k", domainId, inboxId })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(caller(beta).apiKeys.create({ name: "k", inboxId })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });

    // A team at its 25 keys still mints inbox keys, five per inbox.
    await db.insert(schema.apiKeys).values(
      Array.from({ length: 25 }, (_, i) => ({
        teamId: acme,
        name: `team ${i}`,
        tokenPrefix: `ms_t${i}`,
        keyHash: `team-${i}`,
        last4: "0000",
      })),
    );
    await expect(mint({ name: "plain" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    for (let i = 0; i < 5; i++) await mint({ name: `inbox ${i}`, inboxId });
    await expect(mint({ name: "sixth", inboxId })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("An inbox can have at most 5"),
    });

    const listed = (await caller(acme).apiKeys.list()).filter((k) => k.inboxId === inboxId);
    expect(listed).toHaveLength(5);
    expect(listed[0]?.inboxAddress).toBe("orders@in.acme.test");
    await caller(acme).apiKeys.revoke({ id: listed[0]?.id ?? "" });
    const trail = await db
      .select({ action: schema.inboxActivity.action })
      .from(schema.inboxActivity)
      .where(
        and(
          eq(schema.inboxActivity.inboxId, inboxId),
          eq(schema.inboxActivity.actor, `user:${OWNER.id}`),
        ),
      );
    expect(trail.filter((row) => row.action === "key.created")).toHaveLength(5);
    expect(trail.filter((row) => row.action === "key.revoked")).toHaveLength(1);
  });
});

describe("webhook inbox filter", () => {
  it("stores only the team's own inboxes, and null for every inbox", async () => {
    await expect(
      caller(beta).webhooks.create({ url: "https://hooks.example.com/a", inboxIds: [inboxId] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const { id } = await caller(acme).webhooks.create({
      url: "https://hooks.example.com/a",
      eventTypes: ["inbox.email.received"],
      inboxIds: [inboxId, inboxId],
    });
    expect((await caller(acme).webhooks.get({ id })).inboxIds).toEqual([inboxId]);
    await caller(acme).webhooks.update({ id, inboxIds: [] });
    expect((await caller(acme).webhooks.list()).find((w) => w.id === id)?.inboxIds).toBeNull();
  });
});

describe("Settings → Receiving", () => {
  it("answers the instance's own intake to its operator", async () => {
    vi.stubEnv("CLAMAV_HOST", "clamav:3310");
    await expect(caller(acme).receiving.health()).rejects.toMatchObject({ code: "NOT_FOUND" });
    // The first user registered (both rows share a timestamp; the lower id wins) is the operator.
    const operator = createCaller({
      db,
      session: { user: { id: "u-member", email: "mo@acme.test", name: "Mo Member" } },
      teamId: acme,
      role: "member",
    });
    const health = await operator.receiving.health();
    expect(health).toMatchObject({
      mxHost: "mx.example.net",
      clamavHost: "clamav:3310",
      maxSizeBytes: 40 * 1024 * 1024,
    });
    expect(health.receivedToday).toBeGreaterThanOrEqual(1);
  });
});

describe("labels", () => {
  it("are made in the color picked, else one of the palette's, and never in another form", async () => {
    const member = caller(acme, "member");
    expect(
      await member.inboxes.labels.create({ inboxId, name: "Refund", color: "#ab4aba" }),
    ).toMatchObject({ name: "Refund", color: "#AB4ABA" });
    const picked = await member.inboxes.labels.create({ inboxId, name: "Billing" });
    expect(Object.values(LABEL_COLORS)).toContain(picked.color);
    for (const color of ["red", "#abc", "AB4ABA"]) {
      await expect(
        member.inboxes.labels.create({ inboxId, name: `Not ${color}`, color }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    // Another team's inbox reads as missing.
    await expect(
      caller(beta).inboxes.labels.create({ inboxId, name: "Theirs", color: "#AB4ABA" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // A recolor takes the same check.
    await expect(
      member.inboxes.labels.update({ inboxId, labelId: picked.id, color: "blue" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(
      await member.inboxes.labels.update({ inboxId, labelId: picked.id, color: "#00a2c7" }),
    ).toMatchObject({ name: "Billing", color: "#00A2C7" });
  });
});
