import { randomBytes } from "node:crypto";
import {
  CREDENTIAL_MAIL_KINDS,
  EnvKeyring,
  encryptEmailBody,
  SUPPORT_VIEW_MINUTES,
  SUPPORT_VIEW_REASONS,
  SUPPORT_VIEW_SIGN_IN_MINUTES,
  type SystemMailMessage,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { asc, eq, isNull, like } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONSOLE_CODE_MINUTES,
  CONSOLE_CODE_TRIES,
  CONSOLE_CODES_PER_HOUR,
  resetConsoleCodeSends,
} from "@/server/console-code";
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
  session: null as {
    user: { id: string; email: string; name: string };
    session?: { id: string; createdAt: Date };
  } | null,
  cookies: new Map<string, string>(),
  cookieSets: [] as { name: string; value: string; options: Record<string, unknown> }[],
  cookieDeletes: [] as string[],
  sent: [] as SystemMailMessage[],
  failSend: false,
}));

vi.mock("@/server/queue", () => ({
  getQueue: async () => ({ runCronNow: async () => {} }),
  enqueueEmailSend: async () => {},
  enqueueWebhookDeliveries: async () => {},
  enqueueRecipientErase: async () => {},
}));
vi.mock("@/server/system-mail", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/system-mail")>();
  return {
    ...actual,
    sendAccountMail: (m: SystemMailMessage) => void h.sent.push(m),
    defaultSystemMailDeps: {
      send: async (m: SystemMailMessage) => {
        if (h.failSend) throw new Error("SES refused the message");
        h.sent.push(m);
      },
    },
  };
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

const AUTH_SECRET = randomBytes(32).toString("base64");

beforeEach(() => {
  vi.stubEnv("SUPPORT_VIEW", "on");
  vi.stubEnv("APP_BASE_URL", APP);
  vi.stubEnv("AUTH_EMAIL_FROM", "MillionSend <hello@example.com>");
  vi.stubEnv("BETTER_AUTH_SECRET", AUTH_SECRET);
  // No SES reach unless a test grants it, so the instance cannot email a
  // code and a recent sign-in stands in, as on an instance without mail.
  vi.stubEnv("AWS_ACCESS_KEY_ID", "");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "");
  vi.stubEnv("AWS_DEFAULT_CHAIN", "");
  resetConsoleCodeSends();
  h.session = null;
  h.cookies.clear();
  h.cookieSets = [];
  h.cookieDeletes = [];
  h.sent = [];
  h.failSend = false;
});
afterEach(async () => {
  vi.unstubAllEnvs();
  // Every test starts with no live grant, whatever the previous one left.
  await db.execute(
    "update support_view_grants set ended_at = now(), ended_by = 'operator' where ended_at is null",
  );
  await db.delete(schema.verification).where(like(schema.verification.identifier, "console-code%"));
});

/** SES reach, so the instance can email the operator a code. */
function canSendMail() {
  vi.stubEnv("AWS_ACCESS_KEY_ID", "test-key");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test-secret");
}

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
    for (const reason of SUPPORT_VIEW_REASONS) {
      for (const reference of [undefined, "  "]) {
        await expect(
          operator().console.teams.startSupportView({ id: teamId, reason, reference }),
        ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "reference_required" });
      }
    }
    await expect(
      operator().console.teams.startSupportView({ id: randomUuid(), reason: "other" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await db.select().from(schema.supportViewGrants)).toHaveLength(before);
  });

  it("opens a 30-minute grant, sets the cookie, audits the team and mails nobody", async () => {
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
    expect(setCookie).toHaveBeenCalledWith({ id: grant.id, expiresAt: grant.expiresAt });

    const started = (await auditRows("support.view_started")).at(-1);
    expect(started).toMatchObject({
      teamId,
      actorId: `user:${OPERATOR}`,
      target: `support_view:${grant.id}`,
      data: { reason: "support_ticket", reference: "#4812", minutes: 30 },
    });

    // A sender is configured and the team has an owner, so an empty outbox
    // means the start itself mails nobody; the team audit row is the record.
    expect(h.sent).toEqual([]);
  });

  it("opens no view when its audit row cannot be written, and leaves the live one live", async () => {
    const live = await start();
    const ended = (await auditRows("support.view_ended")).length;
    await db.execute(
      "create function refuse_support_start() returns trigger language plpgsql as $$ begin raise exception 'audit down'; end $$",
    );
    await db.execute(
      "create trigger refuse_support_start before insert on audit_log for each row when (new.action = 'support.view_started') execute function refuse_support_start()",
    );
    try {
      await expect(start({ reference: "#2" })).rejects.toThrow();
      // The end of the live view rolls back with the failed start.
      const open = await db
        .select()
        .from(schema.supportViewGrants)
        .where(isNull(schema.supportViewGrants.endedAt));
      expect(open.map((g) => g.id)).toEqual([live.id]);
      expect(await auditRows("support.view_ended")).toHaveLength(ended);
    } finally {
      await db.execute("drop trigger refuse_support_start on audit_log");
      await db.execute("drop function refuse_support_start");
    }
  });

  it("asks for a recent sign-in before opening a view", async () => {
    const signedInAt = new Date(Date.now() - (SUPPORT_VIEW_SIGN_IN_MINUTES + 1) * 60_000);
    const stale = callerFor(OPERATOR, ownTeamId, "owner", {
      session: { user: user(OPERATOR), session: { id: "s-old", createdAt: signedInAt } },
    });
    await expect(
      stale.console.teams.startSupportView({
        id: teamId,
        reason: "support_ticket",
        reference: "#1",
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "sign_in_again" });
    const unknown = callerFor(OPERATOR, ownTeamId, "owner", { session: { user: user(OPERATOR) } });
    await expect(
      unknown.console.teams.startSupportView({
        id: teamId,
        reason: "support_ticket",
        reference: "#1",
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "sign_in_again" });
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

  it("leaves exactly one live grant when starts run at once, the later replacing the earlier", async () => {
    const [first, second] = await Promise.all([
      operator().console.teams.startSupportView({ id: teamId, reason: "other", reference: "#1" }),
      operator().console.teams.startSupportView({ id: teamId, reason: "other", reference: "#2" }),
    ]);
    const live = await db
      .select()
      .from(schema.supportViewGrants)
      .where(isNull(schema.supportViewGrants.endedAt));
    expect(live).toHaveLength(1);
    const winner = live[0]?.id;
    const loser = winner === first.grantId ? second.grantId : first.grantId;
    expect([first.grantId, second.grantId]).toContain(winner);
    expect(await grantRow(loser)).toMatchObject({ endedBy: "operator" });
  });

  it("ends the live view on another team first, as End session does, and its owner sees it end", async () => {
    const otherTeam = await createTeam(db, "globex");
    const first = await start();
    const before = (await auditRows("support.view_ended")).length;
    await operator().console.teams.startSupportView({
      id: otherTeam,
      reason: "other",
      reference: "#9",
    });
    expect(await grantRow(first.id)).toMatchObject({ endedBy: "operator" });
    const ended = await auditRows("support.view_ended");
    expect(ended).toHaveLength(before + 1);
    expect(ended.at(-1)).toMatchObject({
      teamId,
      actorId: `user:${OPERATOR}`,
      target: `support_view:${first.id}`,
      data: { by: "operator", minutes: 0, procedures: 0 },
    });
    // The owner's card shows nothing live, and the team's own trail the end.
    expect((await owner().team.supportView.current()).live).toBeNull();
    const trail = await owner().audit.list({});
    expect(
      trail.items.filter((r) => r.target === `support_view:${first.id}`).map((r) => r.action),
    ).toEqual(["support.view_ended", "support.view_started"]);
  });

  it("has no reason that is not a request the customer made", async () => {
    expect(SUPPORT_VIEW_REASONS).toEqual(["support_ticket", "billing_dispute", "other"]);
    // The value the enum used to carry, typed back in so the router can refuse it.
    const removed = "abuse_report_check" as unknown as (typeof SUPPORT_VIEW_REASONS)[number];
    await expect(
      operator().console.teams.startSupportView({ id: teamId, reason: removed }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("replaces a live view from under it, as after its tab was closed", async () => {
    const grant = await start();
    const setCookie = vi.fn();
    const next = await viewer(grant, {
      setSupportViewCookie: setCookie,
    }).console.teams.startSupportView({ id: teamId, reason: "other", reference: "#5" });
    expect(next.grantId).not.toBe(grant.id);
    expect(await grantRow(grant.id)).toMatchObject({ endedBy: "operator" });
    expect(setCookie).toHaveBeenCalledWith({ id: next.grantId, expiresAt: next.expiresAt });
    expect(await resolveSupportView(db, OPERATOR, grant.id)).toBeNull();
    expect((await resolveSupportView(db, OPERATOR, next.grantId))?.grantId).toBe(next.grantId);
  });
});

describe("the emailed code in front of a start", () => {
  const stale = () =>
    callerFor(OPERATOR, ownTeamId, "owner", {
      session: {
        user: user(OPERATOR),
        session: {
          id: "s-old",
          createdAt: new Date(Date.now() - (SUPPORT_VIEW_SIGN_IN_MINUTES + 1) * 60_000),
        },
      },
    });
  const startWith = (code?: string, caller = operator()) =>
    caller.console.teams.startSupportView({
      id: teamId,
      reason: "support_ticket",
      reference: "#4812",
      ...(code === undefined ? {} : { code }),
    });
  const sentCode = () => {
    const code = h.sent.at(-1)?.text.match(/\b\d{6}\b/)?.[0];
    if (!code) throw new Error("no code in the last mail");
    return code;
  };
  const otherCode = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, "0");
  const codeRows = () =>
    db
      .select()
      .from(schema.verification)
      .where(like(schema.verification.identifier, "console-code%"));

  it("mails the operator a code from AUTH_EMAIL_FROM and keeps only a keyed hash of it", async () => {
    canSendMail();
    expect(await operator().console.teams.sendSupportViewCode()).toEqual({
      sent: true,
      to: "op@example.com",
      minutes: CONSOLE_CODE_MINUTES,
    });
    expect(h.sent).toHaveLength(1);
    const mail = h.sent[0] as SystemMailMessage;
    const code = sentCode();
    expect(mail).toMatchObject({
      from: "MillionSend <hello@example.com>",
      to: "op@example.com",
      subject: "Your MillionSend console code",
      kind: "console_code",
    });
    // The worker drops the body once SES holds it, as for a reset link.
    expect(CREDENTIAL_MAIL_KINDS.has(mail.kind)).toBe(true);
    expect(mail.html).toContain(code);
    expect(mail.text).toContain(`It works once, for ${CONSOLE_CODE_MINUTES} minutes.`);
    expect(mail.text).toContain("Didn't ask for it?");
    // Nothing of any team, the one about to be viewed included.
    for (const part of [mail.subject, mail.text, mail.html]) expect(part).not.toContain("acme");

    const rows = await codeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.identifier).toBe(`console-code:${OPERATOR}`);
    expect(rows[0]?.value).toMatch(/^[0-9a-f]{64}:0$/);
    expect(rows[0]?.value).not.toContain(code);
    const minutes = ((rows[0]?.expiresAt.getTime() ?? 0) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(CONSOLE_CODE_MINUTES - 1);
    expect(minutes).toBeLessThanOrEqual(CONSOLE_CODE_MINUTES);
  });

  it("writes the code in the operator's language under a fixed subject", async () => {
    canSendMail();
    await db.update(schema.user).set({ locale: "pt-BR" }).where(eq(schema.user.id, OPERATOR));
    try {
      await operator().console.teams.sendSupportViewCode();
    } finally {
      await db.update(schema.user).set({ locale: null }).where(eq(schema.user.id, OPERATOR));
    }
    expect(h.sent.at(-1)?.subject).toBe("Seu código do console MillionSend");
    expect(h.sent.at(-1)?.text).toContain(`Ele vale uma vez, por ${CONSOLE_CODE_MINUTES} minutos.`);
  });

  it("starts the view with the code, once, leaving the team's start row as it was", async () => {
    canSendMail();
    await operator().console.teams.sendSupportViewCode();
    const code = sentCode();
    // The sign-in is old: the code alone is what lets the operator in.
    const result = await startWith(code, stale());
    const started = (await auditRows("support.view_started")).at(-1);
    expect(started?.target).toBe(`support_view:${result.grantId}`);
    expect(started?.data).toEqual({ reason: "support_ticket", reference: "#4812", minutes: 30 });
    expect(await codeRows()).toEqual([]);
    await expect(startWith(code)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "code_void",
    });
  });

  it("asks for the code while the instance can send one, however fresh the sign-in", async () => {
    canSendMail();
    await expect(startWith()).rejects.toMatchObject({ message: "code_required" });
    await operator().console.teams.sendSupportViewCode();
    await expect(startWith()).rejects.toMatchObject({ message: "code_required" });
    expect(
      await db
        .select()
        .from(schema.supportViewGrants)
        .where(isNull(schema.supportViewGrants.endedAt)),
    ).toEqual([]);
  });

  it("voids a code after its wrong tries, the right one included after that", async () => {
    canSendMail();
    await operator().console.teams.sendSupportViewCode();
    const code = sentCode();
    for (let i = 1; i < CONSOLE_CODE_TRIES; i++) {
      await expect(startWith(otherCode(code))).rejects.toMatchObject({ message: "code_invalid" });
    }
    await expect(startWith(otherCode(code))).rejects.toMatchObject({ message: "code_void" });
    await expect(startWith(code)).rejects.toMatchObject({ message: "code_void" });
    expect(await codeRows()).toEqual([]);
  });

  it("takes only the newest code, and none past its minutes", async () => {
    canSendMail();
    await operator().console.teams.sendSupportViewCode();
    const first = sentCode();
    await operator().console.teams.sendSupportViewCode();
    const second = sentCode();
    if (first !== second) {
      await expect(startWith(first)).rejects.toMatchObject({ message: "code_invalid" });
    }
    await db
      .update(schema.verification)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.verification.identifier, `console-code:${OPERATOR}`));
    await expect(startWith(second)).rejects.toMatchObject({ message: "code_void" });
    await operator().console.teams.sendSupportViewCode();
    expect((await startWith(sentCode())).grantId).toBeTruthy();
  });

  it("limits how many codes one operator is sent in an hour", async () => {
    canSendMail();
    for (let i = 0; i < CONSOLE_CODES_PER_HOUR; i++) {
      await operator().console.teams.sendSupportViewCode();
    }
    await expect(operator().console.teams.sendSupportViewCode()).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
      message: "code_limit",
    });
    expect(h.sent).toHaveLength(CONSOLE_CODES_PER_HOUR);
  });

  it("lets a recent sign-in stand in when the instance cannot send mail, and says so", async () => {
    expect(await operator().console.teams.sendSupportViewCode()).toEqual({
      sent: false,
      reason: "no_mail",
      signedInRecently: true,
      minutes: SUPPORT_VIEW_SIGN_IN_MINUTES,
    });
    expect(await stale().console.teams.sendSupportViewCode()).toMatchObject({
      sent: false,
      signedInRecently: false,
    });
    expect(h.sent).toEqual([]);
    expect((await startWith()).grantId).toBeTruthy();
    await expect(startWith(undefined, stale())).rejects.toMatchObject({
      message: "sign_in_again",
    });
  });

  it("lets a recent sign-in stand in only after the server's own send failed", async () => {
    canSendMail();
    h.failSend = true;
    expect(await operator().console.teams.sendSupportViewCode()).toEqual({
      sent: false,
      reason: "send_failed",
      signedInRecently: true,
      minutes: SUPPORT_VIEW_SIGN_IN_MINUTES,
    });
    await expect(startWith(undefined, stale())).rejects.toMatchObject({
      message: "sign_in_again",
    });
    expect((await startWith()).grantId).toBeTruthy();
    // A send that goes through closes the fallback again.
    h.failSend = false;
    await operator().console.teams.sendSupportViewCode();
    await expect(startWith()).rejects.toMatchObject({ message: "code_required" });
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

  it("cuts a clicked link to its origin in events and webhook payloads, and drops echoed bodies", async () => {
    const [email] = await db
      .insert(schema.emails)
      .values({
        teamId,
        from: "sender@acme.test",
        to: ["ada@example.com"],
        subject: "Reset your password",
        latestStatus: "delivered",
      })
      .returning({ id: schema.emails.id });
    if (!email) throw new Error("email insert failed");
    const click = {
      link: "https://shop.example.com/reset?token=s3cret",
      ipAddress: "203.0.113.9",
      userAgent: "Mail",
    };
    await db
      .insert(schema.emailEvents)
      .values({ emailId: email.id, type: "clicked", occurredAt: new Date(), data: { click } });
    const hook = await owner().webhooks.create({ url: "https://hook.example.com/in" });
    const payload = { type: "email.clicked", data: { email_id: email.id, click } };
    const [delivery] = await db
      .insert(schema.webhookDeliveries)
      .values({
        endpointId: hook.id,
        emailId: email.id,
        messageId: "msg_click",
        eventType: "email.clicked",
        payload,
        // Receivers often echo what they were sent.
        lastResponseBody: JSON.stringify(payload),
      })
      .returning({ id: schema.webhookDeliveries.id });
    if (!delivery) throw new Error("delivery insert failed");

    const grant = await start();
    const v = viewer(grant);
    const cut = { ...click, link: "https://shop.example.com" };
    expect((await v.emails.get({ id: email.id })).events.map((e) => e.data)).toEqual([
      { click: cut },
    ]);
    const viewedDelivery = await v.webhooks.deliveries.get({ id: delivery.id });
    expect(viewedDelivery.payload).toEqual({ ...payload, data: { ...payload.data, click: cut } });
    expect(viewedDelivery.lastResponseBody).toBeNull();
    // The owner still sees where every click went.
    expect((await owner().emails.get({ id: email.id })).events.map((e) => e.data)).toEqual([
      { click },
    ]);
    const ownDelivery = await owner().webhooks.deliveries.get({ id: delivery.id });
    expect(ownDelivery.payload).toEqual(payload);
    expect(ownDelivery.lastResponseBody).toBe(JSON.stringify(payload));
    await owner().webhooks.delete({ id: hook.id });
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
    h.session = { user: user(OPERATOR), session: { id: "s-op", createdAt: new Date() } };
    const started = await mutate("console.teams.startSupportView", {
      id: teamId,
      reason: "other",
      reference: "#4812",
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

  it("replaces the live view a closed tab left behind, through the cookie it left", async () => {
    h.session = { user: user(OPERATOR), session: { id: "s-op", createdAt: new Date() } };
    const first = await mutate("console.teams.startSupportView", {
      id: teamId,
      reason: "other",
      reference: "#1",
    });
    const firstId = first.data.grantId as string;
    // The tab is gone; its cookie still rides on every console request.
    expect(h.cookies.get("ms_support_view")).toBe(firstId);
    const second = await mutate("console.teams.startSupportView", {
      id: teamId,
      reason: "other",
      reference: "#2",
    });
    expect(second.status).toBe(200);
    expect(h.cookies.get("ms_support_view")).toBe(second.data.grantId);
    expect(await grantRow(firstId)).toMatchObject({ endedBy: "operator" });
    expect((await call("support.current")).data).toMatchObject({ grantId: second.data.grantId });
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
