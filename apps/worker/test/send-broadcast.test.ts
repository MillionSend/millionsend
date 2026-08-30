import { randomBytes } from "node:crypto";
import {
  broadcastSendSpacingMs,
  decryptEmailBody,
  deriveUnsubscribeKey,
  EnvKeyring,
  hashRecipient,
  utcDay,
  verifyUnsubscribeToken,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { reconcileStalledBroadcasts } from "../src/handlers/cron.js";
import {
  applyMergeFields,
  type BroadcastDeps,
  injectPreheader,
  sendBroadcast,
} from "../src/handlers/send-broadcast.js";
import { type SesSender, sendEmail } from "../src/handlers/send-email.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
const secretKey = deriveUnsubscribeKey(randomBytes(32));
const BASE_URL = "https://app.example.com";

/**
 * Contacts are team-global, so each test needing an isolated contact set gets
 * its own team with a verified `<label>.dev` sender domain.
 */
async function seedTeam(
  label: string,
  contacts: (Partial<typeof schema.contacts.$inferInsert> & { email: string })[],
): Promise<{ teamId: string; ids: Record<string, string> }> {
  const tId = await createTeam(db, label);
  await db.insert(schema.domains).values({
    teamId: tId,
    name: `${label}.dev`,
    region: "us-east-1",
    status: "verified",
    verifiedAt: new Date(),
    sesConfigurationSet: "ms-set",
  });
  const ids: Record<string, string> = {};
  if (contacts.length > 0) {
    const inserted = await db
      .insert(schema.contacts)
      .values(contacts.map((c) => ({ ...c, teamId: tId })))
      .returning({ id: schema.contacts.id, email: schema.contacts.email });
    for (const c of inserted) ids[c.email] = c.id;
  }
  return { teamId: tId, ids };
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  ({ teamId } = await seedTeam("acme", [
    { email: "a@example.com" },
    { email: "b@example.com" },
    { email: "gone@example.com", unsubscribed: true },
  ]));
});
afterAll(() => close());

function makeDeps(overrides: Partial<BroadcastDeps> = {}): {
  deps: BroadcastDeps;
  enqueued: string[];
  startAfters: (Date | undefined)[];
} {
  const enqueued: string[] = [];
  const startAfters: (Date | undefined)[] = [];
  return {
    enqueued,
    startAfters,
    deps: {
      keyring,
      unsubscribeSecretKey: secretKey,
      appBaseUrl: BASE_URL,
      isCloud: false,
      enqueueEmailSend: async (emailId, startAfter) => {
        enqueued.push(emailId);
        startAfters.push(startAfter);
      },
      // Batch of 1 exercises the keyset pagination.
      batchSize: 1,
      ...overrides,
    },
  };
}

async function insertBroadcast(
  overrides: Partial<typeof schema.broadcasts.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(schema.broadcasts)
    .values({
      teamId,
      from: "Acme <hi@acme.dev>",
      subject: "launch",
      html: '<p>Hi</p><a href="{{{UNSUBSCRIBE_URL}}}">bye</a>',
      text: "Hi. Unsubscribe: {{{UNSUBSCRIBE_URL}}}",
      status: "scheduled",
      scheduledAt: new Date(Date.now() - 1000),
      ...overrides,
    })
    .returning({ id: schema.broadcasts.id });
  if (!row) throw new Error("broadcast insert failed");
  return row.id;
}

const emailsOf = (broadcastId: string) =>
  db.select().from(schema.emails).where(eq(schema.emails.broadcastId, broadcastId));

it("a broadcast with no segment or topic fans out to ALL subscribed team contacts, personalizes, and marks sent", async () => {
  const broadcastId = await insertBroadcast();
  const { deps, enqueued } = makeDeps();

  expect(await sendBroadcast(db, deps, { broadcastId })).toBe("sent");

  const rows = await emailsOf(broadcastId);
  expect(rows.map((r) => r.to[0]).sort()).toEqual(["a@example.com", "b@example.com"]);
  expect(enqueued.sort()).toEqual(rows.map((r) => r.id).sort());

  const [broadcast] = await db
    .select()
    .from(schema.broadcasts)
    .where(eq(schema.broadcasts.id, broadcastId));
  expect(broadcast?.status).toBe("sent");
  expect(broadcast?.sentAt).toBeInstanceOf(Date);

  // Per-recipient personalization: the literal token is replaced with the
  // hosted unsubscribe URL whose token verifies back to this contact.
  const first = rows[0];
  if (!first?.bodyCiphertext || !first.bodyIv || !first.bodyWrappedDek) throw new Error("no body");
  const body = await decryptEmailBody(
    {
      ciphertext: first.bodyCiphertext,
      iv: first.bodyIv,
      wrappedDek: first.bodyWrappedDek,
      keyVersion: first.bodyKeyVersion ?? 0,
    },
    keyring,
    { teamId: first.teamId, rowId: first.id },
  );
  expect(body.html).not.toContain("{{{UNSUBSCRIBE_URL}}}");
  expect(body.text).not.toContain("{{{UNSUBSCRIBE_URL}}}");
  const match = body.html?.match(new RegExp(`${BASE_URL}/unsubscribe/([^"]+)`));
  expect(match).toBeTruthy();
  expect(verifyUnsubscribeToken(match?.[1] ?? "", secretKey)).toEqual({
    contactId: first.contactId,
    topicId: null,
  });
});

it("substitutes the {{{RESEND_UNSUBSCRIBE_URL}}} alias in html and text", async () => {
  const { teamId: tid, ids } = await seedTeam("alias", [{ email: "al@example.com" }]);
  const broadcastId = await insertBroadcast({
    teamId: tid,
    from: "Alias <hi@alias.dev>",
    html: '<a href="{{{RESEND_UNSUBSCRIBE_URL}}}">bye</a>',
    text: "Bye: {{{RESEND_UNSUBSCRIBE_URL}}}",
  });
  const { deps } = makeDeps();

  expect(await sendBroadcast(db, deps, { broadcastId })).toBe("sent");
  const [row] = await emailsOf(broadcastId);
  if (!row?.bodyCiphertext || !row.bodyIv || !row.bodyWrappedDek) throw new Error("no body");
  const body = await decryptEmailBody(
    {
      ciphertext: row.bodyCiphertext,
      iv: row.bodyIv,
      wrappedDek: row.bodyWrappedDek,
      keyVersion: row.bodyKeyVersion ?? 0,
    },
    keyring,
    { teamId: row.teamId, rowId: row.id },
  );
  expect(body.html).not.toContain("{{{");
  expect(body.text).not.toContain("{{{");
  expect(body.text).toContain(`${BASE_URL}/unsubscribe/`);
  const match = body.html?.match(new RegExp(`${BASE_URL}/unsubscribe/([^"]+)`));
  expect(verifyUnsubscribeToken(match?.[1] ?? "", secretKey)).toEqual({
    contactId: ids["al@example.com"],
    topicId: null,
  });
});

it("suppressed recipients are skipped like unsubscribed ones", async () => {
  const [extra] = await db
    .insert(schema.contacts)
    .values({ teamId, email: "bounced@example.com" })
    .returning({ id: schema.contacts.id });
  if (!extra) throw new Error("contact insert failed");
  await db.insert(schema.suppressions).values({
    teamId,
    emailHash: hashRecipient("bounced@example.com"),
    email: "bounced@example.com",
    reason: "hard_bounce",
  });
  const broadcastId = await insertBroadcast();

  expect(await sendBroadcast(db, makeDeps().deps, { broadcastId })).toBe("sent");

  const rows = await emailsOf(broadcastId);
  expect(rows.map((r) => r.to[0]).sort()).toEqual(["a@example.com", "b@example.com"]);

  await db.delete(schema.suppressions).where(eq(schema.suppressions.teamId, teamId));
  await db.delete(schema.contacts).where(eq(schema.contacts.id, extra.id));
});

it("re-running a fan-out never double-sends: no duplicate rows or jobs", async () => {
  const broadcastId = await insertBroadcast();
  const first = makeDeps();
  expect(await sendBroadcast(db, first.deps, { broadcastId })).toBe("sent");
  expect(first.enqueued).toHaveLength(2);

  // Simulate a re-run after a crash mid-fan-out (status back to sending).
  await db
    .update(schema.broadcasts)
    .set({ status: "sending" })
    .where(eq(schema.broadcasts.id, broadcastId));
  const second = makeDeps();
  expect(await sendBroadcast(db, second.deps, { broadcastId })).toBe("sent");
  expect(await emailsOf(broadcastId)).toHaveLength(2);
  // Conflicted rows enqueue nothing — their jobs already exist.
  expect(second.enqueued).toHaveLength(0);

  // A completed broadcast is a no-op.
  const third = makeDeps();
  expect(await sendBroadcast(db, third.deps, { broadcastId })).toBe("skipped");
});

it("broadcast emails carry RFC 8058 headers through the SES send", async () => {
  const broadcastId = await insertBroadcast();
  const { deps } = makeDeps();
  await sendBroadcast(db, deps, { broadcastId });
  const [email] = await emailsOf(broadcastId);
  if (!email) throw new Error("no email row");

  const sends: Buffer[] = [];
  const ses: SesSender = {
    async sendRaw({ raw }) {
      sends.push(raw);
      return { messageId: `mid-${sends.length}` };
    },
  };
  const outcome = await sendEmail(
    db,
    { keyring, ses, unsubscribe: { secretKey, baseUrl: BASE_URL } },
    { emailId: email.id },
  );
  expect(outcome).toBe("sent");
  // Unfold wrapped headers before matching; casing is normalized by nodemailer.
  const mime = (sends[0]?.toString("utf8") ?? "").replace(/\r?\n[ \t]+/g, " ").toLowerCase();
  expect(mime).toContain(`list-unsubscribe: <${BASE_URL}/unsubscribe/`.toLowerCase());
  expect(mime).toContain("list-unsubscribe-post: list-unsubscribe=one-click");
});

it("a broadcast email refuses to send when unsubscribe is not configured", async () => {
  const broadcastId = await insertBroadcast();
  const { deps } = makeDeps();
  await sendBroadcast(db, deps, { broadcastId });
  const rows = await emailsOf(broadcastId);
  const pending = rows.find((r) => r.latestStatus === "queued");
  if (!pending) throw new Error("no queued email row");

  const ses: SesSender = {
    async sendRaw() {
      throw new Error("must not reach SES");
    },
  };
  await expect(sendEmail(db, { keyring, ses }, { emailId: pending.id })).rejects.toThrow(
    /unsubscribe is not configured/,
  );
});

it("cancel before fan-out sends nothing", async () => {
  const broadcastId = await insertBroadcast({ status: "canceled" });
  const { deps, enqueued } = makeDeps();
  expect(await sendBroadcast(db, deps, { broadcastId })).toBe("skipped");
  expect(await emailsOf(broadcastId)).toHaveLength(0);
  expect(enqueued).toHaveLength(0);
});

/**
 * Wraps db so the given hook runs (and commits) just before the FIRST
 * db.update(...) executes — deterministically reproducing a write landing in
 * the gap between sendBroadcast's status read and its sending-claim CAS.
 */
function interposeBeforeFirstUpdate(realDb: Db, hook: () => Promise<void>): Db {
  type AnyFn = (...args: unknown[]) => unknown;
  let armed = true;
  const wrapChain = (target: object): object =>
    new Proxy(target, {
      get(t, prop) {
        const value = (t as Record<PropertyKey, unknown>)[prop];
        if (prop === "then" && typeof value === "function") {
          return (onOk: AnyFn, onErr: AnyFn) =>
            hook().then(() => (value as AnyFn).call(t, onOk, onErr), onErr);
        }
        if (typeof value === "function") {
          return (...args: unknown[]) => wrapChain((value as AnyFn).apply(t, args) as object);
        }
        return value;
      },
    });
  return new Proxy(realDb as object, {
    get(t, prop) {
      const value = (t as Record<PropertyKey, unknown>)[prop];
      if (prop === "update" && armed) {
        return (...args: unknown[]) => {
          armed = false;
          return wrapChain((value as AnyFn).apply(t, args) as object);
        };
      }
      return typeof value === "function" ? (value as AnyFn).bind(t) : value;
    },
  }) as Db;
}

it("a cancel racing the sending claim fans out nothing", async () => {
  const broadcastId = await insertBroadcast();
  const { deps, enqueued } = makeDeps();
  // The cancel lands after sendBroadcast's status SELECT but before its
  // claim UPDATE — the claim must lose and the fan-out must not run.
  const racingDb = interposeBeforeFirstUpdate(db, async () => {
    await db
      .update(schema.broadcasts)
      .set({ status: "canceled", updatedAt: new Date() })
      .where(eq(schema.broadcasts.id, broadcastId));
  });

  expect(await sendBroadcast(racingDb, deps, { broadcastId })).toBe("skipped");
  expect(await emailsOf(broadcastId)).toHaveLength(0);
  expect(enqueued).toHaveLength(0);
  const [broadcast] = await db
    .select()
    .from(schema.broadcasts)
    .where(eq(schema.broadcasts.id, broadcastId));
  expect(broadcast?.status).toBe("canceled");
});

it("cloud fan-out reserves daily quota and parks the overflow as queued_quota", async () => {
  const { teamId: qTeamId } = await seedTeam("quota", [
    { email: "q1@example.com" },
    { email: "q2@example.com" },
    { email: "q3@example.com" },
  ]);
  // Free plan cap is 100/day; 98 already accepted → headroom for 2 of 3.
  await db.insert(schema.usageCounters).values({ teamId: qTeamId, day: utcDay(), accepted: 98 });
  const broadcastId = await insertBroadcast({
    teamId: qTeamId,
    from: "Acme <hi@quota.dev>",
  });
  const { deps, enqueued } = makeDeps({ isCloud: true });

  expect(await sendBroadcast(db, deps, { broadcastId })).toBe("sent");

  const rows = await emailsOf(broadcastId);
  expect(rows).toHaveLength(3);
  const queued = rows.filter((r) => r.latestStatus === "queued");
  const parked = rows.filter((r) => r.latestStatus === "queued_quota");
  expect(queued).toHaveLength(2);
  expect(parked).toHaveLength(1);
  // Only accepted rows get an email.send job; parked ones wait for the
  // daily quota drain.
  expect(enqueued.sort()).toEqual(queued.map((r) => r.id).sort());
  const [counter] = await db
    .select()
    .from(schema.usageCounters)
    .where(eq(schema.usageCounters.teamId, qTeamId));
  expect(counter?.accepted).toBe(100);
});

async function seedThrottleTeam(
  label: string,
  counter: Partial<typeof schema.usageCounters.$inferInsert>,
): Promise<{ broadcastId: string }> {
  const { teamId: tId } = await seedTeam(label, [
    { email: "t1@example.com" },
    { email: "t2@example.com" },
    { email: "t3@example.com" },
  ]);
  await db.insert(schema.usageCounters).values({ teamId: tId, day: utcDay(), ...counter });
  const broadcastId = await insertBroadcast({
    teamId: tId,
    from: `Acme <hi@${label}.dev>`,
  });
  return { broadcastId };
}

it("throttles the fan-out drip when the team is over the risk line", async () => {
  // 90/2000 = 4.5% bounce: over WARN (4%), under PAUSE (5%), volume >= floor.
  const { broadcastId } = await seedThrottleTeam("bc-throttle", {
    sent: 2000,
    bounced: 90,
  });
  const { deps, startAfters } = makeDeps();

  expect(await sendBroadcast(db, deps, { broadcastId })).toBe("sent");

  expect(startAfters).toHaveLength(3);
  expect(startAfters.every((d) => d instanceof Date)).toBe(true);
  const [t0, t1, t2] = startAfters.map((d) => (d as Date).getTime());
  if (t0 === undefined || t1 === undefined || t2 === undefined)
    throw new Error("missing startAfter");
  const spacing = broadcastSendSpacingMs("warning");
  // Deltas between consecutive enqueues equal the core spacing exactly; the
  // absolute base (wall clock) is never asserted.
  expect(t1 - t0).toBe(spacing);
  expect(t2 - t1).toBe(spacing);
});

it("fans out at full rate (no startAfter) when the team is ok", async () => {
  // 10/2000 = 0.5% bounce: clean, over the volume floor → ok, full rate.
  const { broadcastId } = await seedThrottleTeam("bc-fullrate", {
    sent: 2000,
    bounced: 10,
  });
  const { deps, startAfters } = makeDeps();

  expect(await sendBroadcast(db, deps, { broadcastId })).toBe("sent");

  expect(startAfters).toHaveLength(3);
  expect(startAfters.every((d) => d === undefined)).toBe(true);
});

it("defers a not-yet-due scheduled broadcast back to the queue", async () => {
  const due = new Date(Date.now() + 60 * 60 * 1000);
  const broadcastId = await insertBroadcast({ scheduledAt: due });
  const rescheduled: { id: string; at: Date }[] = [];
  const { deps } = makeDeps({
    reschedule: async (id, at) => {
      rescheduled.push({ id, at });
    },
  });
  expect(await sendBroadcast(db, deps, { broadcastId })).toBe("deferred");
  expect(rescheduled).toEqual([{ id: broadcastId, at: due }]);
  expect(await emailsOf(broadcastId)).toHaveLength(0);
});

it("a stored multi-mailbox from fails the fan-out loudly, sending nothing", async () => {
  // Legacy rows predate strict from validation: the last angle-addr's domain
  // (acme.dev) is verified, but the value is ambiguous — a lenient extractor
  // would verify one address while another could be emitted.
  const broadcastId = await insertBroadcast({
    from: "Acme <evil@other.test> <hi@acme.dev>",
  });
  const { deps, enqueued } = makeDeps();
  await expect(sendBroadcast(db, deps, { broadcastId })).rejects.toThrow(/single unambiguous/);
  expect(await emailsOf(broadcastId)).toHaveLength(0);
  expect(enqueued).toHaveLength(0);
});

it("missing APP_BASE_URL fails the fan-out loudly, sending nothing", async () => {
  const broadcastId = await insertBroadcast();
  const { deps, enqueued } = makeDeps({ appBaseUrl: undefined });
  await expect(sendBroadcast(db, deps, { broadcastId })).rejects.toThrow(/APP_BASE_URL/);
  expect(await emailsOf(broadcastId)).toHaveLength(0);
  expect(enqueued).toHaveLength(0);
  // Still scheduled: the job retry / reconcile sweep keeps it alive.
  const [broadcast] = await db
    .select()
    .from(schema.broadcasts)
    .where(eq(schema.broadcasts.id, broadcastId));
  expect(broadcast?.status).toBe("scheduled");
});

it("injectPreheader hides escaped preview text at the top of the body", () => {
  const doc = injectPreheader('<html><body class="x"><p>Hi</p></body></html>', "New <deals> &co");
  // Inserted right after the body tag, escaped, padded with zero-width chars.
  expect(doc.startsWith('<html><body class="x"><div style="display:none')).toBe(true);
  expect(doc).toContain("New &lt;deals&gt; &amp;co");
  expect(doc).toContain("&nbsp;&zwnj;");
  expect(doc.indexOf("New &lt;deals&gt;")).toBeLessThan(doc.indexOf("<p>Hi</p>"));
  // Fragment without a <body> tag: prepended.
  expect(injectPreheader("<p>Hi</p>", "peek").startsWith('<div style="display:none')).toBe(true);
});

it("fan-out injects the preheader into html only when preview_text is set", async () => {
  const { teamId: tId } = await seedTeam("preheader", [{ email: "ph@example.com" }]);
  const withPreview = await insertBroadcast({
    teamId: tId,
    from: "Acme <hi@preheader.dev>",
    previewText: "Sneak peek",
  });
  const without = await insertBroadcast({ teamId: tId, from: "Acme <hi@preheader.dev>" });

  const decrypt = async (broadcastId: string) => {
    expect(await sendBroadcast(db, makeDeps().deps, { broadcastId })).toBe("sent");
    const [row] = await emailsOf(broadcastId);
    if (!row?.bodyCiphertext || !row.bodyIv || !row.bodyWrappedDek) throw new Error("no body");
    return decryptEmailBody(
      {
        ciphertext: row.bodyCiphertext,
        iv: row.bodyIv,
        wrappedDek: row.bodyWrappedDek,
        keyVersion: row.bodyKeyVersion ?? 0,
      },
      keyring,
      { teamId: row.teamId, rowId: row.id },
    );
  };

  const body = await decrypt(withPreview);
  expect(body.html?.startsWith('<div style="display:none')).toBe(true);
  expect(body.html).toContain("Sneak peek");
  // The hidden div precedes the original content; text bodies stay untouched.
  expect(body.html?.indexOf("Sneak peek")).toBeLessThan(body.html?.indexOf("<p>Hi</p>") ?? -1);
  expect(body.text).not.toContain("Sneak peek");

  const plain = await decrypt(without);
  expect(plain.html).not.toContain("display:none");
});

it("applyMergeFields substitutes contact fields, with fallbacks for null and empty", () => {
  const contact = { email: "ada@example.com", firstName: "Ada", lastName: null, properties: {} };
  expect(
    applyMergeFields("Hi {{{FIRST_NAME|there}}} {{{LAST_NAME|friend}}} ({{{EMAIL}}})", contact, {
      html: false,
    }),
  ).toBe("Hi Ada friend (ada@example.com)");
  // Empty string counts as absent, same as null.
  expect(
    applyMergeFields("{{{FIRST_NAME|there}}}", { ...contact, firstName: "" }, { html: false }),
  ).toBe("there");
  // Absent field without a fallback yields "" — the raw token never ships.
  expect(applyMergeFields("Hi {{{LAST_NAME}}}.", contact, { html: false })).toBe("Hi .");
});

it("applyMergeFields resolves custom properties, with fallback and no leaked token", () => {
  const contact = {
    email: "ada@example.com",
    firstName: "Ada",
    lastName: null,
    properties: { plan: "free", tier: "" },
  };
  expect(applyMergeFields("Plan: {{{plan|paid}}}", contact, { html: false })).toBe("Plan: free");
  // Empty property value falls back like null.
  expect(applyMergeFields("{{{tier|basic}}}", contact, { html: false })).toBe("basic");
  // Unknown property without a fallback → "" (never the raw token).
  expect(applyMergeFields("[{{{unknown}}}]", contact, { html: false })).toBe("[]");
});

it("applyMergeFields prefers a builtin over a same-named property", () => {
  const contact = {
    email: "ada@example.com",
    firstName: "Ada",
    lastName: null,
    properties: { FIRST_NAME: "Overridden" },
  };
  expect(applyMergeFields("{{{FIRST_NAME}}}", contact, { html: false })).toBe("Ada");
});

it("applyMergeFields html-escapes a hostile property value in html bodies only", () => {
  const contact = {
    email: "ada@example.com",
    firstName: "Ada",
    lastName: null,
    properties: { plan: "<img src=x onerror=alert(1)>\"&'" },
  };
  expect(applyMergeFields("<p>{{{plan}}}</p>", contact, { html: true })).toBe(
    "<p>&lt;img src=x onerror=alert(1)&gt;&quot;&amp;&#39;</p>",
  );
  expect(applyMergeFields("{{{plan}}}", contact, { html: false })).toBe(contact.properties.plan);
});

it("applyMergeFields html-escapes contact values in html bodies only", () => {
  const contact = {
    email: "ada@example.com",
    firstName: "<img src=x onerror=alert(1)>\"&'",
    lastName: null,
    properties: {},
  };
  expect(applyMergeFields("<p>{{{FIRST_NAME}}}</p>", contact, { html: true })).toBe(
    "<p>&lt;img src=x onerror=alert(1)&gt;&quot;&amp;&#39;</p>",
  );
  expect(applyMergeFields("{{{FIRST_NAME}}}", contact, { html: false })).toBe(contact.firstName);
});

it("fan-out personalizes merge fields per contact in html and text", async () => {
  const { teamId: mergeTeamId } = await seedTeam("merge", [
    {
      email: "hostile@example.com",
      firstName: "<b>Ada</b>",
      lastName: null,
      properties: { plan: "<b>pro</b>" },
    },
  ]);
  const broadcastId = await insertBroadcast({
    teamId: mergeTeamId,
    from: "Acme <hi@merge.dev>",
    html: '<p>Hi {{{FIRST_NAME|there}}} {{{LAST_NAME|friend}}} on {{{plan}}}</p>{{{NOPE}}}<a href="{{{UNSUBSCRIBE_URL}}}">bye</a>',
    text: "Hi {{{FIRST_NAME|there}}} {{{LAST_NAME|friend}}} on {{{plan}}} {{{NOPE}}}",
  });

  expect(await sendBroadcast(db, makeDeps().deps, { broadcastId })).toBe("sent");
  const [email] = await emailsOf(broadcastId);
  if (!email?.bodyCiphertext || !email.bodyIv || !email.bodyWrappedDek) throw new Error("no body");
  const body = await decryptEmailBody(
    {
      ciphertext: email.bodyCiphertext,
      iv: email.bodyIv,
      wrappedDek: email.bodyWrappedDek,
      keyVersion: email.bodyKeyVersion ?? 0,
    },
    keyring,
    { teamId: email.teamId, rowId: email.id },
  );
  // Hostile name and property escaped in html, raw in text; null field →
  // fallback; unknown property token resolves to "" (never leaked); unsubscribe
  // URL still swapped in.
  expect(body.html).toContain("Hi &lt;b&gt;Ada&lt;/b&gt; friend on &lt;b&gt;pro&lt;/b&gt;");
  expect(body.html).not.toContain("{{{NOPE}}}");
  expect(body.html).toContain(`${BASE_URL}/unsubscribe/`);
  expect(body.html).not.toContain("{{{UNSUBSCRIBE_URL}}}");
  expect(body.text).toBe("Hi <b>Ada</b> friend on <b>pro</b> ");
});

async function seedTopicTeam(
  label: string,
  defaultSubscribed: boolean,
): Promise<{ teamId: string; topicId: string; ids: Record<string, string> }> {
  const { teamId: tId, ids } = await seedTeam(label, [
    { email: `${label}-default@example.com` },
    { email: `${label}-out@example.com` },
    { email: `${label}-in@example.com` },
  ]);
  const [topic] = await db
    .insert(schema.topics)
    .values({ teamId: tId, name: label, defaultSubscribed })
    .returning({ id: schema.topics.id });
  if (!topic) throw new Error("topic insert failed");
  await db.insert(schema.contactTopicSubscriptions).values([
    { contactId: ids[`${label}-out@example.com`] as string, topicId: topic.id, subscribed: false },
    { contactId: ids[`${label}-in@example.com`] as string, topicId: topic.id, subscribed: true },
  ]);
  return { teamId: tId, topicId: topic.id, ids };
}

it("opt-in topic: default (no row) and explicit-in send; explicit opt-out is skipped", async () => {
  const { teamId: tId, topicId } = await seedTopicTeam("optin", true);
  const broadcastId = await insertBroadcast({
    teamId: tId,
    from: "Acme <hi@optin.dev>",
    topicId,
  });

  expect(await sendBroadcast(db, makeDeps().deps, { broadcastId })).toBe("sent");

  const rows = await emailsOf(broadcastId);
  expect(rows.map((r) => r.to[0]).sort()).toEqual([
    "optin-default@example.com",
    "optin-in@example.com",
  ]);
  // The per-recipient token is topic-scoped.
  const first = rows[0];
  if (!first?.bodyCiphertext || !first.bodyIv || !first.bodyWrappedDek) throw new Error("no body");
  const body = await decryptEmailBody(
    {
      ciphertext: first.bodyCiphertext,
      iv: first.bodyIv,
      wrappedDek: first.bodyWrappedDek,
      keyVersion: first.bodyKeyVersion ?? 0,
    },
    keyring,
    { teamId: first.teamId, rowId: first.id },
  );
  const token = body.html?.match(new RegExp(`${BASE_URL}/unsubscribe/([^"]+)`))?.[1] ?? "";
  expect(verifyUnsubscribeToken(token, secretKey)).toEqual({
    contactId: first.contactId,
    topicId,
  });
});

it("opt-out topic: default (no row) is skipped; only explicit-in sends", async () => {
  const { teamId: tId, topicId } = await seedTopicTeam("optout", false);
  const broadcastId = await insertBroadcast({
    teamId: tId,
    from: "Acme <hi@optout.dev>",
    topicId,
  });

  expect(await sendBroadcast(db, makeDeps().deps, { broadcastId })).toBe("sent");

  const rows = await emailsOf(broadcastId);
  expect(rows.map((r) => r.to[0]).sort()).toEqual(["optout-in@example.com"]);
});

it("reconcile re-enqueues past-due scheduled and stale sending broadcasts", async () => {
  const past = new Date(Date.now() - 60 * 60 * 1000);
  const stuck = await insertBroadcast({ scheduledAt: past });
  const stale = await insertBroadcast({ status: "sending", updatedAt: past });
  const fresh = await insertBroadcast({ scheduledAt: new Date(Date.now() + 60_000) });

  const enqueued: string[] = [];
  const requeued = await reconcileStalledBroadcasts(db, {
    enqueue: async (id) => {
      enqueued.push(id);
    },
  });
  expect(requeued).toBeGreaterThanOrEqual(2);
  expect(enqueued).toContain(stuck);
  expect(enqueued).toContain(stale);
  expect(enqueued).not.toContain(fresh);
});

it("a segment broadcast fans out only to matching contacts, composing with the topic filter", async () => {
  const { teamId: tId, ids } = await seedTeam("seg", [
    { email: "vip-in@example.com", properties: { tier: "vip" } },
    { email: "vip-out@example.com", properties: { tier: "vip" } },
    { email: "basic@example.com", properties: { tier: "basic" } },
  ]);
  const [topic] = await db
    .insert(schema.topics)
    .values({ teamId: tId, name: "seg-topic", defaultSubscribed: true })
    .returning({ id: schema.topics.id });
  if (!topic) throw new Error("topic insert failed");
  // vip-out opts out of the topic: the segment matches it, the topic filter must
  // still exclude it — both predicates apply.
  await db.insert(schema.contactTopicSubscriptions).values({
    contactId: ids["vip-out@example.com"] as string,
    topicId: topic.id,
    subscribed: false,
  });
  const [segment] = await db
    .insert(schema.segments)
    .values({
      teamId: tId,
      name: "vips",
      filter: {
        match: "all",
        conditions: [{ field: "property:tier", op: "equals", value: "vip" }],
      },
    })
    .returning({ id: schema.segments.id });
  if (!segment) throw new Error("segment insert failed");

  const broadcastId = await insertBroadcast({
    teamId: tId,
    from: "Acme <hi@seg.dev>",
    segmentId: segment.id,
    topicId: topic.id,
  });
  expect(await sendBroadcast(db, makeDeps().deps, { broadcastId })).toBe("sent");

  const rows = await emailsOf(broadcastId);
  // basic@ fails the segment; vip-out@ passes the segment but fails the topic.
  expect(rows.map((r) => r.to[0]).sort()).toEqual(["vip-in@example.com"]);
});

it("a foreign-team segment on a broadcast refuses the fan-out, sending nothing", async () => {
  // A tampered/foreign segmentId must never scope (or widen) a send.
  const { teamId: otherTeam } = await seedTeam("foreignseg", []);
  const [foreign] = await db
    .insert(schema.segments)
    .values({ teamId: otherTeam, name: "not-yours", filter: { match: "all", conditions: [] } })
    .returning({ id: schema.segments.id });
  if (!foreign) throw new Error("segment insert failed");
  const broadcastId = await insertBroadcast({ segmentId: foreign.id });
  const { deps, enqueued } = makeDeps();

  await expect(sendBroadcast(db, deps, { broadcastId })).rejects.toThrow(/not found for its team/);
  expect(await emailsOf(broadcastId)).toHaveLength(0);
  expect(enqueued).toHaveLength(0);
});

it("a segment fan-out includes manual members alongside filter matches", async () => {
  const { teamId: tId, ids } = await seedTeam("segmem", [
    { email: "match@example.com", properties: { tier: "vip" } },
    { email: "hand-picked@example.com" },
    { email: "outsider@example.com" },
  ]);
  const [segment] = await db
    .insert(schema.segments)
    .values({
      teamId: tId,
      name: "vips-and-picks",
      filter: {
        match: "all",
        conditions: [{ field: "property:tier", op: "equals", value: "vip" }],
      },
    })
    .returning({ id: schema.segments.id });
  if (!segment) throw new Error("segment insert failed");
  await db.insert(schema.segmentMembers).values({
    segmentId: segment.id,
    contactId: ids["hand-picked@example.com"] as string,
  });

  const broadcastId = await insertBroadcast({
    teamId: tId,
    from: "Acme <hi@segmem.dev>",
    segmentId: segment.id,
  });
  expect(await sendBroadcast(db, makeDeps().deps, { broadcastId })).toBe("sent");

  const rows = await emailsOf(broadcastId);
  expect(rows.map((r) => r.to[0]).sort()).toEqual(["hand-picked@example.com", "match@example.com"]);
});

it("a null-filter (manual) segment fans out to its members only", async () => {
  const { teamId: tId, ids } = await seedTeam("segmanual", [
    { email: "picked@example.com" },
    { email: "unpicked@example.com" },
  ]);
  const [segment] = await db
    .insert(schema.segments)
    .values({ teamId: tId, name: "manual", filter: null })
    .returning({ id: schema.segments.id });
  if (!segment) throw new Error("segment insert failed");
  await db.insert(schema.segmentMembers).values({
    segmentId: segment.id,
    contactId: ids["picked@example.com"] as string,
  });

  const broadcastId = await insertBroadcast({
    teamId: tId,
    from: "Acme <hi@segmanual.dev>",
    segmentId: segment.id,
  });
  expect(await sendBroadcast(db, makeDeps().deps, { broadcastId })).toBe("sent");
  expect((await emailsOf(broadcastId)).map((r) => r.to[0])).toEqual(["picked@example.com"]);
});

it("applyMergeFields only lets web/mail URLs open an href or src; anything else falls back", () => {
  const contact = {
    email: "ada@example.com",
    firstName: null,
    lastName: null,
    properties: {
      site: "https://ada.example/?a=1&b=2",
      evil: "javascript:alert(1)",
      data: "data:text/html,hi",
      mail: "mailto:ada@example.com",
    },
  };
  const html = (s: string) => applyMergeFields(s, contact, { html: true });
  expect(html('<a href="{{{site}}}">x</a>')).toBe(
    '<a href="https://ada.example/?a=1&amp;b=2">x</a>',
  );
  expect(html('<a href="{{{mail}}}">x</a>')).toBe('<a href="mailto:ada@example.com">x</a>');
  expect(html('<a href="{{{evil}}}">x</a>')).toBe('<a href="">x</a>');
  expect(html('<a href="{{{evil|https://safe.example}}}">x</a>')).toBe(
    '<a href="https://safe.example">x</a>',
  );
  expect(html('<img src="{{{data}}}">')).toBe('<img src="">');
  expect(html("<a href='{{{evil}}}'>x</a>")).toBe("<a href=''>x</a>");
  // Outside a URL slot the value is ordinary escaped text; a fixed scheme
  // ahead of the token cannot be overridden either.
  expect(html("<p>{{{evil}}}</p>")).toBe("<p>javascript:alert(1)</p>");
  expect(html('<a href="https://x.example/{{{evil}}}">x</a>')).toBe(
    '<a href="https://x.example/javascript:alert(1)">x</a>',
  );
  expect(applyMergeFields('href="{{{evil}}}"', contact, { html: false })).toBe(
    'href="javascript:alert(1)"',
  );
});
