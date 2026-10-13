import { randomBytes, randomUUID } from "node:crypto";
import {
  defaultSafety,
  encodeInboxActor,
  type InboxSafety,
  type InboxWire,
  PLAN_INBOX_LIMIT,
  safetyProblem,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
afterEach(() => vi.unstubAllEnvs());

/** A received row of the team; content columns stay empty, the list never reads them. */
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
      releasedAt: new Date(),
      trustedSender: "ana@sender.example",
    });
    const emailId = randomUUID();
    await caller(beta, "member").inboxes.quarantine.release({
      inboxId,
      emailId,
      trustSender: true,
    });
    expect(core.releaseQuarantined).toHaveBeenCalledWith(db, expect.anything(), {
      teamId: beta,
      receivedEmailId: emailId,
      inboxId,
      actor: user,
      trustSender: true,
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
        },
      ],
      hasMore: false,
    });
    const page = await caller(acme, "viewer", view()).inboxes.threads.emails({ inboxId, threadId });
    expect(core.listThreadEmails).toHaveBeenCalledWith(
      db,
      expect.anything(),
      expect.objectContaining({ envelopeOnly: true, agentView: false, includeHeld: true }),
    );
    expect(page.items).toEqual([
      {
        id: "m1",
        direction: "inbound",
        subject: "Order",
        html: null,
        text: null,
        extracted_text: null,
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

  it("hands the inbox a normalized patch, with no key it was not given", async () => {
    await caller(acme).inboxes.updateSafety({
      id: inboxId,
      patch: { allowlist: ["Ana@Example.COM", "*@Stripe.com", "ana@example.com"] },
    });
    expect(core.updateInboxSafety).toHaveBeenCalledWith(db, expect.anything(), {
      teamId: acme,
      inboxId,
      actor: user,
      patch: { allowlist: ["ana@example.com", "*@stripe.com"] },
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
        teamName: "inbox-acme",
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
});

describe("thread rows", () => {
  it("carry the thread's held mail, the judge's score, a draft waiting and a reply", async () => {
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
      replied: false,
    });
    // A thread the team does not hold reads as having nothing.
    expect(page.items[1]).toMatchObject({ id: other, quarantined: 0, pending_approval: false });
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
