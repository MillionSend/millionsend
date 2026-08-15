import { randomBytes } from "node:crypto";
import {
  decryptEmailBody,
  deriveUnsubscribeKey,
  EnvKeyring,
  hashRecipient,
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
  sendBroadcast,
} from "../src/handlers/send-broadcast.js";
import { type SesSender, sendEmail } from "../src/handlers/send-email.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;
let audienceId: string;
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
const secretKey = deriveUnsubscribeKey(randomBytes(32));
const BASE_URL = "https://app.example.com";

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "bc-worker");
  await db.insert(schema.domains).values({
    teamId,
    name: "acme.dev",
    region: "us-east-1",
    status: "verified",
    verifiedAt: new Date(),
    sesConfigurationSet: "ms-set",
  });
  const [audience] = await db
    .insert(schema.audiences)
    .values({ teamId, name: "news" })
    .returning({ id: schema.audiences.id });
  if (!audience) throw new Error("audience insert failed");
  audienceId = audience.id;
  await db.insert(schema.contacts).values([
    { audienceId, teamId, email: "a@example.com" },
    { audienceId, teamId, email: "b@example.com" },
    { audienceId, teamId, email: "gone@example.com", unsubscribed: true },
  ]);
});
afterAll(() => close());

function makeDeps(overrides: Partial<BroadcastDeps> = {}): {
  deps: BroadcastDeps;
  enqueued: string[];
} {
  const enqueued: string[] = [];
  return {
    enqueued,
    deps: {
      keyring,
      unsubscribeSecretKey: secretKey,
      appBaseUrl: BASE_URL,
      enqueueEmailSend: async (emailId) => {
        enqueued.push(emailId);
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
      audienceId,
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

it("fans out to subscribed contacts only, personalizes, and marks sent", async () => {
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
  );
  expect(body.html).not.toContain("{{{UNSUBSCRIBE_URL}}}");
  expect(body.text).not.toContain("{{{UNSUBSCRIBE_URL}}}");
  const match = body.html?.match(new RegExp(`${BASE_URL}/unsubscribe/([^"]+)`));
  expect(match).toBeTruthy();
  expect(verifyUnsubscribeToken(match?.[1] ?? "", secretKey)).toBe(first.contactId);
});

it("suppressed recipients are skipped like unsubscribed ones", async () => {
  const [extra] = await db
    .insert(schema.contacts)
    .values({ audienceId, teamId, email: "bounced@example.com" })
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

it("applyMergeFields substitutes contact fields, with fallbacks for null and empty", () => {
  const contact = { email: "ada@example.com", firstName: "Ada", lastName: null };
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

it("applyMergeFields leaves unknown tokens untouched", () => {
  const contact = { email: "ada@example.com", firstName: "Ada", lastName: null };
  expect(applyMergeFields("{{{NOPE}}} {{{FULL_NAME|x}}}", contact, { html: false })).toBe(
    "{{{NOPE}}} {{{FULL_NAME|x}}}",
  );
});

it("applyMergeFields html-escapes contact values in html bodies only", () => {
  const contact = {
    email: "ada@example.com",
    firstName: "<img src=x onerror=alert(1)>\"&'",
    lastName: null,
  };
  expect(applyMergeFields("<p>{{{FIRST_NAME}}}</p>", contact, { html: true })).toBe(
    "<p>&lt;img src=x onerror=alert(1)&gt;&quot;&amp;&#39;</p>",
  );
  expect(applyMergeFields("{{{FIRST_NAME}}}", contact, { html: false })).toBe(contact.firstName);
});

it("fan-out personalizes merge fields per contact in html and text", async () => {
  const [audience] = await db
    .insert(schema.audiences)
    .values({ teamId, name: "merge" })
    .returning({ id: schema.audiences.id });
  if (!audience) throw new Error("audience insert failed");
  await db.insert(schema.contacts).values({
    audienceId: audience.id,
    teamId,
    email: "hostile@example.com",
    firstName: "<b>Ada</b>",
    lastName: null,
  });
  const broadcastId = await insertBroadcast({
    audienceId: audience.id,
    html: '<p>Hi {{{FIRST_NAME|there}}} {{{LAST_NAME|friend}}}</p>{{{NOPE}}}<a href="{{{UNSUBSCRIBE_URL}}}">bye</a>',
    text: "Hi {{{FIRST_NAME|there}}} {{{LAST_NAME|friend}}} {{{NOPE}}}",
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
  );
  // Hostile name escaped in html, raw in text; null field → fallback;
  // unknown token untouched; unsubscribe URL still swapped in.
  expect(body.html).toContain("Hi &lt;b&gt;Ada&lt;/b&gt; friend");
  expect(body.html).toContain("{{{NOPE}}}");
  expect(body.html).toContain(`${BASE_URL}/unsubscribe/`);
  expect(body.html).not.toContain("{{{UNSUBSCRIBE_URL}}}");
  expect(body.text).toBe("Hi <b>Ada</b> friend {{{NOPE}}}");
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
