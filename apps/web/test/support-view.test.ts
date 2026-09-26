import { randomBytes } from "node:crypto";
import {
  EnvKeyring,
  encryptEmailBody,
  SUPPORT_VIEW_MINUTES,
  SUPPORT_VIEW_REASONS,
  type SystemMailMessage,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { asc, eq, isNull } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionRole } from "@/server/membership";
import { createCaller } from "@/server/routers";
import { resolveSupportView } from "@/server/support-view";
import type { Context } from "@/server/trpc";

// The emails router builds its keyring from the env; the key must exist
// before the first procedure runs.
const TEST_KEK = randomBytes(32).toString("base64");
process.env.MASTER_ENCRYPTION_KEY = TEST_KEK;

const h = vi.hoisted(() => ({
  db: undefined as unknown as Db,
  session: null as { user: { id: string; email: string; name: string } } | null,
  cookies: new Map<string, string>(),
  cookieSets: [] as { name: string; value: string; options: Record<string, unknown> }[],
  cookieDeletes: [] as string[],
  sent: [] as SystemMailMessage[],
}));

vi.mock("@/server/queue", () => ({
  getQueue: async () => ({ runCronNow: async () => {} }),
  enqueueEmailSend: async () => {},
  enqueueWebhookDeliveries: async () => {},
  enqueueRecipientErase: async () => {},
}));
vi.mock("@/server/system-mail", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/system-mail")>();
  return { ...actual, sendAccountMail: (m: SystemMailMessage) => void h.sent.push(m) };
});
// The route handlers (tRPC, export) resolve the db, the session and the
// cookies themselves; the same PGlite and a scripted cookie jar stand in.
vi.mock("@millionsend/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@millionsend/db")>();
  return { ...actual, getDb: () => h.db };
});
vi.mock("@/server/auth", () => ({
  getAuth: () => ({ api: { getSession: async () => h.session } }),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      h.cookies.has(name) ? { name, value: h.cookies.get(name) as string } : undefined,
    set: (name: string, value: string, options?: Record<string, unknown>) => {
      h.cookies.set(name, value);
      h.cookieSets.push({ name, value, options: options ?? {} });
    },
    delete: (name: string) => {
      h.cookies.delete(name);
      h.cookieDeletes.push(name);
    },
  }),
}));

const trpcRoute = await import("@/app/api/trpc/[trpc]/route");
const exportRoute = await import("@/app/(dashboard)/export/[resource]/route");

const APP = "https://app.example.com";
const OPERATOR = "op";
const OWNER = "bob";
const MEMBER = "carol";
const READ_ONLY = { code: "FORBIDDEN", message: "Read-only support view" };

let db: Db;
let close: () => Promise<void>;
let teamId: string;
let ownTeamId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  h.db = db;
  await db.insert(schema.user).values([
    { id: OPERATOR, name: "Operator", email: "op@example.com", createdAt: new Date(0) },
    { id: OWNER, name: "Bob", email: "bob@example.com", createdAt: new Date(1) },
    { id: MEMBER, name: "Carol", email: "carol@example.com", createdAt: new Date(2) },
  ]);
  teamId = await createTeam(db, "acme");
  ownTeamId = await createTeam(db, "ops");
  await db.insert(schema.teamMembers).values([
    { teamId, userId: OWNER, role: "owner" },
    { teamId, userId: MEMBER, role: "member" },
    { teamId: ownTeamId, userId: OPERATOR, role: "owner" },
  ]);
});
afterAll(() => close());

beforeEach(() => {
  vi.stubEnv("SUPPORT_VIEW", "on");
  vi.stubEnv("APP_BASE_URL", APP);
  vi.stubEnv("AUTH_EMAIL_FROM", "MillionSend <hello@example.com>");
  h.session = null;
  h.cookies.clear();
  h.cookieSets = [];
  h.cookieDeletes = [];
  h.sent = [];
});
afterEach(async () => {
  vi.unstubAllEnvs();
  // Every test starts with no live grant, whatever the previous one left.
  await db.execute(
    "update support_view_grants set ended_at = now(), ended_by = 'operator' where ended_at is null",
  );
});

const user = (id: string) => ({ id, email: `${id}@example.com`, name: id });

function callerFor(
  userId: string,
  team: string | null = null,
  role: SessionRole | null = null,
  extra: Partial<Context> = {},
) {
  return createCaller({
    db,
    session: { user: user(userId), session: { id: `s-${userId}`, createdAt: new Date() } },
    teamId: team,
    role,
    ...extra,
  });
}
const operator = () => callerFor(OPERATOR, ownTeamId, "owner");
const owner = () => callerFor(OWNER, teamId, "owner");
const member = () => callerFor(MEMBER, teamId, "member");

type Grant = typeof schema.supportViewGrants.$inferSelect;

/** What createContext builds while the operator's cookie names a live grant. */
function viewer(
  grant: { id: string; teamId: string; expiresAt: Date },
  extra: Partial<Context> = {},
) {
  return callerFor(OPERATOR, grant.teamId, "viewer", {
    supportView: { grantId: grant.id, expiresAt: grant.expiresAt },
    ...extra,
  });
}

async function start(input: Partial<{ reason: Grant["reason"]; reference: string }> = {}) {
  const result = await operator().console.teams.startSupportView({
    id: teamId,
    reason: "support_ticket",
    reference: "#4812",
    ...input,
  });
  return grantRow(result.grantId);
}

async function grantRow(id: string): Promise<Grant> {
  const [row] = await db
    .select()
    .from(schema.supportViewGrants)
    .where(eq(schema.supportViewGrants.id, id));
  if (!row) throw new Error("grant missing");
  return row;
}

function auditRows(action: string) {
  return db
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.action, action))
    .orderBy(asc(schema.auditLog.createdAt));
}

describe("feature off", () => {
  it("refuses to start, shows nothing to the owner and disables the console item", async () => {
    vi.stubEnv("SUPPORT_VIEW", "off");
    await expect(
      operator().console.teams.startSupportView({ id: teamId, reason: "other" }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "support_view_off" });
    expect(await owner().team.supportView.current()).toEqual({ enabled: false, live: null });
    expect((await operator().console.teams.list({})).supportViewEnabled).toBe(false);
    expect((await operator().console.teams.detail({ id: teamId })).supportViewEnabled).toBe(false);
    // An existing cookie is ignored while the feature is off.
    vi.stubEnv("SUPPORT_VIEW", "on");
    const grant = await start();
    vi.stubEnv("SUPPORT_VIEW", "off");
    expect(await resolveSupportView(db, OPERATOR, grant.id)).toBeNull();
  });
});

describe("console.teams.startSupportView", () => {
  it("validates the team, the reason and the reference", async () => {
    const before = (await db.select().from(schema.supportViewGrants)).length;
    await expect(
      operator().console.teams.startSupportView({ id: ownTeamId, reason: "other" }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "own_team" });
    for (const reason of ["support_ticket", "billing_dispute"] as const) {
      await expect(
        operator().console.teams.startSupportView({ id: teamId, reason }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "reference_required" });
    }
    await expect(
      operator().console.teams.startSupportView({ id: randomUuid(), reason: "other" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await db.select().from(schema.supportViewGrants)).toHaveLength(before);
  });

  it("opens a 30-minute grant, sets the cookie, audits the team and emails its owners", async () => {
    const setCookie = vi.fn();
    const before = Date.now();
    const result = await callerFor(OPERATOR, ownTeamId, "owner", {
      setSupportViewCookie: setCookie,
    }).console.teams.startSupportView({ id: teamId, reason: "support_ticket", reference: "#4812" });
    const grant = await grantRow(result.grantId);
    expect(grant).toMatchObject({
      teamId,
      operatorUserId: OPERATOR,
      reason: "support_ticket",
      reference: "#4812",
      endedAt: null,
      endedBy: null,
      procedures: {},
    });
    const minutes = (grant.expiresAt.getTime() - grant.createdAt.getTime()) / 60_000;
    expect(minutes).toBe(SUPPORT_VIEW_MINUTES);
    expect(grant.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(grant.notifiedAt).toBeInstanceOf(Date);
    expect(setCookie).toHaveBeenCalledWith({ id: grant.id, expiresAt: grant.expiresAt });

    const started = (await auditRows("support.view_started")).at(-1);
    expect(started).toMatchObject({
      teamId,
      actorId: `user:${OPERATOR}`,
      target: `support_view:${grant.id}`,
      data: { reason: "support_ticket", reference: "#4812", minutes: 30 },
    });

    // Owners only, in their language, naming who, why, the reference and the deadline.
    expect(h.sent.map((m) => [m.kind, m.to])).toEqual([
      ["support.view_started", "bob@example.com"],
    ]);
    const mail = h.sent[0] as SystemMailMessage;
    expect(mail.subject).toBe("Support view of acme started");
    // The session's name and address, as the context carries them.
    expect(mail.text).toContain("op (op@example.com)");
    expect(mail.text).toContain("support ticket #4812");
    expect(mail.text).toContain(`${APP}/settings`);
  });

  it("keeps one live grant per operator: starting again ends the previous one", async () => {
    const first = await start();
    const second = await start({ reason: "other" });
    expect(second.id).not.toBe(first.id);
    expect(await grantRow(first.id)).toMatchObject({ endedBy: "operator" });
    expect((await grantRow(first.id)).endedAt).toBeInstanceOf(Date);
    const ended = await auditRows("support.view_ended");
    expect(ended.at(-1)).toMatchObject({
      teamId,
      actorId: `user:${OPERATOR}`,
      data: { by: "operator", procedures: 0 },
    });
    expect(await resolveSupportView(db, OPERATOR, first.id)).toBeNull();
    expect((await resolveSupportView(db, OPERATOR, second.id))?.grantId).toBe(second.id);
  });

  it("leaves notified_at null when the instance has no sender configured", async () => {
    vi.stubEnv("AUTH_EMAIL_FROM", "");
    vi.stubEnv("NOTIFICATIONS_EMAIL_FROM", "");
    const result = await operator().console.teams.startSupportView({
      id: teamId,
      reason: "other",
    });
    expect((await grantRow(result.grantId)).notifiedAt).toBeNull();
    expect(h.sent).toEqual([]);
  });

  it("leaves notified_at null when the team has no owner to write to", async () => {
    const orphan = await createTeam(db, `orphan-${Date.now()}`);
    const result = await operator().console.teams.startSupportView({
      id: orphan,
      reason: "other",
    });
    const grant = await grantRow(result.grantId);
    expect(grant.notifiedAt).toBeNull();
    expect(h.sent).toEqual([]);
  });

  it("never leaves two live grants when starts run at once", async () => {
    const results = await Promise.allSettled([
      operator().console.teams.startSupportView({ id: teamId, reason: "other" }),
      operator().console.teams.startSupportView({ id: teamId, reason: "other" }),
    ]);
    // Whoever loses the one-live-view index is told a view is live, never a
    // raw database error; the winner's grant is the only one still open.
    for (const result of results) {
      if (result.status === "rejected") {
        expect(result.reason).toMatchObject({
          code: "PRECONDITION_FAILED",
          message: "support_view_live",
        });
      }
    }
    const live = await db
      .select()
      .from(schema.supportViewGrants)
      .where(isNull(schema.supportViewGrants.endedAt));
    expect(live).toHaveLength(1);
  });

  it("has no reason that is not a request the customer made", async () => {
    expect(SUPPORT_VIEW_REASONS).toEqual(["support_ticket", "billing_dispute", "other"]);
    // The value the enum used to carry, typed back in so the router can refuse it.
    const removed = "abuse_report_check" as unknown as (typeof SUPPORT_VIEW_REASONS)[number];
    await expect(
      operator().console.teams.startSupportView({ id: teamId, reason: removed }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("cannot be nested: a view cannot start another", async () => {
    const grant = await start();
    await expect(
      viewer(grant).console.teams.startSupportView({ id: teamId, reason: "other" }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "support_view_live" });
  });
});

describe("resolveSupportView", () => {
  it("answers no view for a malformed, unknown, foreign, ended or expired id", async () => {
    const grant = await start();
    expect(await resolveSupportView(db, OPERATOR, undefined)).toBeNull();
    expect(await resolveSupportView(db, OPERATOR, "not-a-uuid")).toBeNull();
    expect(await resolveSupportView(db, OPERATOR, randomUuid())).toBeNull();
    // The owner holding the operator's grant id gets nothing, and no error.
    expect(await resolveSupportView(db, OWNER, grant.id)).toBeNull();
    expect(await resolveSupportView(db, OPERATOR, grant.id)).toMatchObject({
      grantId: grant.id,
      teamId,
      teamName: "acme",
      expiresAt: grant.expiresAt,
    });
  });

  it("ends an expired grant on first sight, dated at the deadline, and audits it", async () => {
    const grant = await start();
    const past = new Date(Date.now() - 60_000);
    await db
      .update(schema.supportViewGrants)
      .set({ createdAt: new Date(past.getTime() - SUPPORT_VIEW_MINUTES * 60_000), expiresAt: past })
      .where(eq(schema.supportViewGrants.id, grant.id));
    expect(await resolveSupportView(db, OPERATOR, grant.id)).toBeNull();
    expect(await grantRow(grant.id)).toMatchObject({ endedBy: "expiry", endedAt: past });
    const ended = await auditRows("support.view_ended");
    expect(ended.at(-1)).toMatchObject({
      teamId,
      actorId: "system",
      data: { by: "expiry", minutes: SUPPORT_VIEW_MINUTES },
    });
    // Once ended it stays ended: a second sight writes nothing more.
    expect(await resolveSupportView(db, OPERATOR, grant.id)).toBeNull();
    expect(await auditRows("support.view_ended")).toHaveLength(ended.length);
  });
});

describe("the read-only guard", () => {
  it("refuses every mutation under a view except support.end", async () => {
    const grant = await start();
    const v = viewer(grant);
    await expect(
      v.apiKeys.create({ name: "refused", permission: "full_access" }),
    ).rejects.toMatchObject(READ_ONLY);
    await expect(
      v.emails.suppressions.add({ email: "x@example.com", reason: "manual" }),
    ).rejects.toMatchObject(READ_ONLY);
    await expect(v.settings.team.rename({ name: "renamed" })).rejects.toMatchObject(READ_ONLY);
    await expect(v.team.switch({ teamId: ownTeamId })).rejects.toMatchObject(READ_ONLY);
    await expect(v.team.supportView.end()).rejects.toMatchObject(READ_ONLY);
    await expect(v.webhooks.create({ url: "https://hook.example.com/in" })).rejects.toMatchObject(
      READ_ONLY,
    );
    expect(
      await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.name, "refused")),
    ).toEqual([]);
    expect((await db.select().from(schema.teams).where(eq(schema.teams.id, teamId)))[0]?.name).toBe(
      "acme",
    );
  });

  it("lets the operator switch their own language during a view", async () => {
    const grant = await start();
    await viewer(grant).settings.locale.set({ locale: "pt-BR" });
    const [row] = await db
      .select({ locale: schema.user.locale })
      .from(schema.user)
      .where(eq(schema.user.id, OPERATOR));
    expect(row?.locale).toBe("pt-BR");
  });

  it("leaves the console's own procedures working during a view", async () => {
    const grant = await start();
    await viewer(grant).console.teams.adjustLimits({
      id: teamId,
      dailySendCeiling: 500,
      broadcastsPaused: false,
    });
    expect(
      (await db.select().from(schema.teams).where(eq(schema.teams.id, teamId)))[0],
    ).toMatchObject({ dailySendCeiling: 500 });
    await viewer(grant).console.teams.adjustLimits({
      id: teamId,
      dailySendCeiling: null,
      broadcastsPaused: false,
    });
  });

  it("counts every read by procedure path, console reads excluded", async () => {
    const grant = await start();
    const v = viewer(grant);
    await v.apiKeys.list();
    await v.apiKeys.list();
    await v.emails.stats();
    await v.console.teams.list({});
    expect((await grantRow(grant.id)).procedures).toEqual({ "apiKeys.list": 2, "emails.stats": 1 });
    await v.emails.stats();
    expect((await grantRow(grant.id)).procedures).toEqual({ "apiKeys.list": 2, "emails.stats": 2 });
  });

  it("lets the banner ask after its own session without counting it as a read", async () => {
    const grant = await start();
    const v = viewer(grant);
    expect(await v.support.current()).toMatchObject({ grantId: grant.id, teamId });
    await v.apiKeys.list();
    expect((await grantRow(grant.id)).procedures).toEqual({ "apiKeys.list": 1 });
    // The owner ends it; the next poll is what tells the operator's tab.
    await owner().team.supportView.end();
    expect(await callerFor(OPERATOR, ownTeamId, "owner").support.current()).toBeNull();
  });

  it("support.end ends the operator's grant, clears the cookie and audits the distinct reads", async () => {
    const grant = await start();
    const setCookie = vi.fn();
    const v = viewer(grant, { setSupportViewCookie: setCookie });
    await v.apiKeys.list();
    await v.emails.stats();
    expect(await v.support.end()).toEqual({ ended: true, teamId });
    expect(setCookie).toHaveBeenCalledWith(null);
    expect(await grantRow(grant.id)).toMatchObject({ endedBy: "operator" });
    const ended = await auditRows("support.view_ended");
    expect(ended.at(-1)).toMatchObject({
      teamId,
      actorId: `user:${OPERATOR}`,
      data: { by: "operator", minutes: 0, procedures: 2 },
    });
    // Nothing live: the call still clears the cookie and says so.
    expect(await operator().support.end()).toEqual({ ended: false, teamId: null });
  });
});

describe("what a view can and cannot see", () => {
  it("never decrypts an email body and says why", async () => {
    const keyring = EnvKeyring.fromBase64(TEST_KEK);
    const encrypted = await encryptEmailBody({ html: "<p>hi</p>", text: "hi" }, keyring);
    const [email] = await db
      .insert(schema.emails)
      .values({
        teamId,
        from: "sender@acme.test",
        to: ["ada@example.com"],
        subject: "hello",
        latestStatus: "delivered",
        bodyCiphertext: encrypted.ciphertext,
        bodyIv: encrypted.iv,
        bodyWrappedDek: encrypted.wrappedDek,
        bodyKeyVersion: encrypted.keyVersion,
      })
      .returning({ id: schema.emails.id });
    if (!email) throw new Error("email insert failed");
    const seen = await owner().emails.get({ id: email.id });
    expect(seen).toMatchObject({ html: "<p>hi</p>", text: "hi", hiddenBySupportView: false });

    const grant = await start();
    const viewed = await viewer(grant).emails.get({ id: email.id });
    expect(viewed).toMatchObject({
      id: email.id,
      subject: "hello",
      html: null,
      text: null,
      hiddenBySupportView: true,
    });
    expect(viewed).not.toHaveProperty("bodyCiphertext");
  });

  it("hides a broadcast's body once it has reached someone, and not before", async () => {
    const body = { html: "<p>the newsletter</p>", text: "the newsletter" };
    const [sent] = await db
      .insert(schema.broadcasts)
      .values({
        teamId,
        name: "September",
        from: "Example <hello@example.com>",
        subject: "Hello",
        status: "sent",
        previewText: "a peek at the newsletter",
        ...body,
      })
      .returning({ id: schema.broadcasts.id });
    const [draft] = await db
      .insert(schema.broadcasts)
      .values({
        teamId,
        name: "October",
        from: "Example <hello@example.com>",
        subject: "Draft",
        status: "draft",
        ...body,
      })
      .returning({ id: schema.broadcasts.id });
    const [scheduled] = await db
      .insert(schema.broadcasts)
      .values({
        teamId,
        name: "November",
        from: "Example <hello@example.com>",
        subject: "Scheduled",
        status: "scheduled",
        ...body,
      })
      .returning({ id: schema.broadcasts.id });
    if (!sent || !draft || !scheduled) throw new Error("broadcast insert failed");

    const grant = await start();
    const v = viewer(grant);
    const viewedSent = await v.broadcasts.get({ id: sent.id });
    expect(viewedSent).toMatchObject({
      subject: "Hello",
      html: null,
      text: null,
      document: null,
      // The preheader rides inside the html that went out.
      previewText: null,
      hiddenBySupportView: true,
    });
    // Nothing has left yet for either of these, and checking a broadcast
    // before it goes is what support is asked for.
    for (const id of [draft.id, scheduled.id]) {
      expect(await v.broadcasts.get({ id })).toMatchObject({
        html: body.html,
        hiddenBySupportView: false,
      });
    }
    // Sending and canceled count as reached: a cancel can land mid-fan-out.
    for (const status of ["sending", "canceled"] as const) {
      await db
        .update(schema.broadcasts)
        .set({ status })
        .where(eq(schema.broadcasts.id, scheduled.id));
      expect(await v.broadcasts.get({ id: scheduled.id })).toMatchObject({
        html: null,
        hiddenBySupportView: true,
      });
    }
    // The owner sees both, as before.
    expect((await owner().broadcasts.get({ id: sent.id })).html).toBe(body.html);
  });

  it("hides every template body, since a sent broadcast is copied from one", async () => {
    const body = { html: "<p>reusable</p>", text: "reusable" };
    const [template] = await db
      .insert(schema.templates)
      .values({ teamId, name: "Monthly", subject: "Hi", ...body })
      .returning({ id: schema.templates.id });
    if (!template) throw new Error("template insert failed");
    expect(await owner().templates.get({ id: template.id })).toMatchObject({
      html: body.html,
      hiddenBySupportView: false,
    });
    const grant = await start();
    expect(await viewer(grant).templates.get({ id: template.id })).toMatchObject({
      name: "Monthly",
      html: null,
      text: null,
      document: null,
      hiddenBySupportView: true,
    });
    // The list never carried a body to begin with.
    const listed = await viewer(grant).templates.list({});
    expect(listed.items[0]).not.toHaveProperty("html");
  });

  it("lets a support view read the team's own audit trail, and never a member", async () => {
    const grant = await start();
    const trail = await viewer(grant).audit.list({});
    expect(trail.items.some((r) => r.action === "support.view_started")).toBe(true);
    await expect(member().audit.list({})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("withholds API log bodies", async () => {
    const [log] = await db
      .insert(schema.apiRequests)
      .values({
        teamId,
        method: "POST",
        path: "/emails",
        statusCode: 200,
        requestBody: { subject: "s", html: "<p>secret</p>" },
        responseBody: { id: "x" },
      })
      .returning({ id: schema.apiRequests.id });
    if (!log) throw new Error("log insert failed");
    expect(await owner().logs.get({ id: log.id })).toMatchObject({
      requestBody: { subject: "s", html: "<p>secret</p>" },
      hiddenBySupportView: false,
    });
    const grant = await start();
    expect(await viewer(grant).logs.get({ id: log.id })).toMatchObject({
      requestBody: null,
      responseBody: null,
      hiddenBySupportView: true,
    });
  });

  it("returns no secret material on the key and webhook surfaces", async () => {
    const created = await owner().apiKeys.create({ name: "k", permission: "full_access" });
    const hook = await owner().webhooks.create({ url: "https://hook.example.com/in" });
    const grant = await start();
    const v = viewer(grant);
    const keys = await v.apiKeys.list();
    expect(keys).toHaveLength(1);
    // The mask's parts and nothing behind them, whatever the router adds later.
    for (const key of keys) {
      expect(Object.keys(key)).toEqual(expect.not.arrayContaining(["keyHash", "token", "secret"]));
    }
    expect(JSON.stringify(keys)).not.toContain(created.token);
    const endpoint = await v.webhooks.get({ id: hook.id });
    expect(endpoint.secretLast4).toBe(hook.secret.slice(-4));
    expect(Object.keys(endpoint)).toEqual(
      expect.not.arrayContaining(["secret", "secretCiphertext", "secretWrappedDek"]),
    );
    expect(JSON.stringify(endpoint)).not.toContain(hook.secret);
    await expect(v.webhooks.rotateSecret({ id: hook.id })).rejects.toMatchObject(READ_ONLY);
    await owner().apiKeys.revoke({ id: created.id });
    await owner().webhooks.delete({ id: hook.id });
  });

  it("refuses the CSV export under a view and serves it without one", async () => {
    const grant = await start();
    h.session = { user: user(OPERATOR) };
    h.cookies.set("ms_support_view", grant.id);
    const refused = await exportRoute.GET(new Request(`${APP}/export/contacts`), {
      params: Promise.resolve({ resource: "contacts" }),
    });
    expect(refused.status).toBe(403);
    // The same cookie once the grant has ended: the operator's own team exports.
    await operator().support.end();
    const served = await exportRoute.GET(new Request(`${APP}/export/contacts`), {
      params: Promise.resolve({ resource: "contacts" }),
    });
    expect(served.status).toBe(200);
    expect(served.headers.get("content-disposition")).toContain("contacts.csv");
  });
});

describe("the owner's side", () => {
  it("sees the live view, ends it, and both trails carry the rows", async () => {
    const grant = await start({ reason: "billing_dispute", reference: "INV-77" });
    const current = await owner().team.supportView.current();
    expect(current).toMatchObject({
      enabled: true,
      live: {
        id: grant.id,
        operator: { name: "Operator", email: "op@example.com" },
        reason: "billing_dispute",
        reference: "INV-77",
        expiresAt: grant.expiresAt,
      },
    });
    // The card is owner/admin only, and so is the read behind it.
    await expect(member().team.supportView.current()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(member().team.supportView.end()).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(await owner().team.supportView.end()).toEqual({ ended: true });
    expect(await grantRow(grant.id)).toMatchObject({ endedBy: "owner" });
    expect((await owner().team.supportView.current()).live).toBeNull();
    expect(await owner().team.supportView.end()).toEqual({ ended: false });
    expect(await resolveSupportView(db, OPERATOR, grant.id)).toBeNull();

    const teamTrail = await owner().audit.list({});
    const rows = teamTrail.items.filter((r) => r.target === `support_view:${grant.id}`);
    expect(rows.map((r) => [r.action, r.actor])).toEqual([
      ["support.view_ended", { kind: "user", id: OWNER, name: "Bob", email: "bob@example.com" }],
      [
        "support.view_started",
        { kind: "user", id: OPERATOR, name: "Operator", email: "op@example.com" },
      ],
    ]);
    expect(rows[0]?.data).toMatchObject({ by: "owner" });

    const instanceTrail = await operator().console.audit.list({});
    expect(instanceTrail.actions).toEqual(
      expect.arrayContaining(["support.view_started", "support.view_ended"]),
    );
    expect(
      instanceTrail.items
        .filter((r) => r.target === `support_view:${grant.id}`)
        .map((r) => [r.action, r.teamName]),
    ).toEqual([
      ["support.view_ended", "acme"],
      ["support.view_started", "acme"],
    ]);
  });
});

describe("through the tRPC route (cookie to context)", () => {
  const headers = {
    "content-type": "application/json",
    origin: APP,
    "sec-fetch-site": "same-origin",
  };
  const call = async (procedure: string, input?: unknown) => {
    const url = input
      ? `${APP}/api/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`
      : `${APP}/api/trpc/${procedure}`;
    const res = await trpcRoute.GET(new Request(url, { headers }));
    const body = (await res.json()) as { result?: { data?: { json?: unknown } } };
    return { status: res.status, data: body.result?.data?.json as Record<string, unknown> };
  };
  const mutate = async (procedure: string, input: unknown) => {
    const res = await trpcRoute.POST(
      new Request(`${APP}/api/trpc/${procedure}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ json: input }),
      }),
    );
    const body = (await res.json()) as { result?: { data?: { json?: unknown } } };
    return { status: res.status, data: body.result?.data?.json as Record<string, unknown> };
  };

  it("starts through the console, views through the cookie, and drops a dead cookie", async () => {
    h.session = { user: user(OPERATOR) };
    const started = await mutate("console.teams.startSupportView", {
      id: teamId,
      reason: "other",
    });
    expect(started.status).toBe(200);
    const grantId = started.data.grantId as string;
    // The grant rides in an httpOnly, same-site cookie that dies with it.
    expect(h.cookieSets.at(-1)).toMatchObject({
      name: "ms_support_view",
      value: grantId,
      options: { httpOnly: true, sameSite: "lax", path: "/" },
    });
    const expires = h.cookieSets.at(-1)?.options.expires;
    expect(expires).toBeInstanceOf(Date);
    expect((expires as Date).toISOString()).toBe(started.data.expiresAt);

    // The cookie the console set now selects the viewed team, read-only.
    const list = await call("team.list");
    expect(list.data.activeTeamId).toBe(teamId);
    expect((await mutate("settings.team.rename", { name: "x" })).status).toBe(403);
    expect((await grantRow(grantId)).procedures).toEqual({ "team.list": 1 });

    // The owner ends it: the next request falls back to the operator's own
    // team and tells the browser to drop the cookie.
    await owner().team.supportView.end();
    const after = await call("team.list");
    expect(after.data.activeTeamId).toBe(ownTeamId);
    expect(h.cookieDeletes).toContain("ms_support_view");
    expect(h.cookies.has("ms_support_view")).toBe(false);
  });

  it("ignores a grant of another operator's making", async () => {
    const grant = await start();
    h.session = { user: user(OWNER) };
    h.cookies.set("ms_support_view", grant.id);
    const list = await call("team.list");
    expect(list.data.activeTeamId).toBe(teamId);
    // Bob is the owner of acme: reads are his own, not counted on the grant.
    expect((await grantRow(grant.id)).procedures).toEqual({});
    expect(h.cookieDeletes).toContain("ms_support_view");
  });
});

function randomUuid(): string {
  return crypto.randomUUID();
}
