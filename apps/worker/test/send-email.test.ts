import { randomBytes } from "node:crypto";
import {
  EnvKeyring,
  encryptEmailBody,
  hashRecipient,
  sealAttachments,
  utcDay,
  verifyClickToken,
  verifyOpenToken,
  verifyUnsubscribeToken,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  createTokenBucket,
  type SendDeps,
  type SesSender,
  sendEmail,
} from "../src/handlers/send-email.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;
let domainId: string;
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "send-team");
  const [domain] = await db
    .insert(schema.domains)
    .values({
      teamId,
      name: "acme.dev",
      region: "us-east-1",
      status: "verified",
      verifiedAt: new Date(),
      sesConfigurationSet: "ms-config-set",
      // The suite's tracking assertions are calibrated to a click-tracking
      // domain; the column default is off, so opt in explicitly.
      clickTracking: true,
    })
    .returning({ id: schema.domains.id });
  if (!domain) throw new Error("domain insert failed");
  domainId = domain.id;
});
afterAll(() => close());

interface FakeSend {
  raw: Buffer;
  emailId: string;
  configurationSetName?: string | undefined;
  region?: string | undefined;
}

function fakeSes(messageId = "fake-mid"): { ses: SesSender; sends: FakeSend[] } {
  const sends: FakeSend[] = [];
  return {
    sends,
    ses: {
      async sendRaw(params) {
        sends.push(params);
        return { messageId };
      },
    },
  };
}

const trackingSecret = randomBytes(32);

// nodemailer quoted-printable-encodes the html part and soft-wraps at 76 cols;
// dropping the `=\r\n` soft breaks reassembles token URLs (base64url chars are
// never QP-encoded) so they can be matched and verified.
function unwrapQp(mime: string): string {
  return mime.replace(/=\r\n/g, "");
}

async function insertEmail(
  overrides: Partial<typeof schema.emails.$inferInsert> = {},
  bodyHtml = "<b>hi</b>",
  bodyText = "hi",
): Promise<string> {
  const encrypted = await encryptEmailBody({ html: bodyHtml, text: bodyText }, keyring);
  const [row] = await db
    .insert(schema.emails)
    .values({
      teamId,
      domainId,
      from: "Acme <a@acme.dev>",
      to: ["r@example.com"],
      subject: "greetings",
      latestStatus: "queued",
      bodyCiphertext: encrypted.ciphertext,
      bodyIv: encrypted.iv,
      bodyWrappedDek: encrypted.wrappedDek,
      bodyKeyVersion: encrypted.keyVersion,
      ...overrides,
    })
    .returning({ id: schema.emails.id });
  if (!row) throw new Error("email insert failed");
  return row.id;
}

async function insertContact(email: string): Promise<string> {
  const [row] = await db
    .insert(schema.contacts)
    .values({ teamId, email })
    .returning({ id: schema.contacts.id });
  if (!row) throw new Error("contact insert failed");
  return row.id;
}

it("sends a queued email: MIME, join key, status, event row", async () => {
  const { ses, sends } = fakeSes("mid-happy");
  const deps: SendDeps = { keyring, ses };
  const emailId = await insertEmail();

  expect(await sendEmail(db, deps, { emailId })).toBe("sent");

  expect(sends).toHaveLength(1);
  const mime = sends[0]?.raw.toString("utf8") ?? "";
  // Header casing is normalized by nodemailer; compare case-insensitively.
  expect(mime.toLowerCase()).toContain(`x-millionsend-email-id: ${emailId}`);
  expect(mime).toContain("Subject: greetings");
  expect(mime).toContain("r@example.com");
  expect(sends[0]?.configurationSetName).toBe("ms-config-set");
  expect(sends[0]?.region).toBe("us-east-1");
  expect(sends[0]?.emailId).toBe(emailId);

  // Transactional mail carries none of the bulk-class headers.
  for (const h of ["List-Id", "List-Unsubscribe", "Precedence", "Auto-Submitted"]) {
    expect(mime.toLowerCase()).not.toContain(`${h.toLowerCase()}:`);
  }

  const [row] = await db.select().from(schema.emails).where(eq(schema.emails.id, emailId));
  expect(row?.sesMessageId).toBe("mid-happy");
  expect(row?.latestStatus).toBe("sent");
  expect(row?.sentAt).toBeInstanceOf(Date);
  const events = await db
    .select()
    .from(schema.emailEvents)
    .where(eq(schema.emailEvents.emailId, emailId));
  expect(events.map((e) => e.type)).toEqual(["sent"]);
  const [usage] = await db
    .select({ sent: schema.usageCounters.sent })
    .from(schema.usageCounters)
    .where(eq(schema.usageCounters.day, utcDay()));
  expect(usage?.sent).toBe(1);
});

it("a broadcast send carries the RFC bulk-mail headers", async () => {
  const [topic] = await db
    .insert(schema.topics)
    .values({ teamId, name: "Product news", defaultSubscribed: true })
    .returning({ id: schema.topics.id });
  if (!topic) throw new Error("topic insert failed");
  const [broadcast] = await db
    .insert(schema.broadcasts)
    .values({ teamId, topicId: topic.id, from: "Acme <a@acme.dev>", subject: "hi" })
    .returning({ id: schema.broadcasts.id });
  if (!broadcast) throw new Error("broadcast insert failed");

  const { ses, sends } = fakeSes("mid-bulk");
  const contactId = await insertContact("r@example.com");
  const emailId = await insertEmail({ broadcastId: broadcast.id, contactId });
  const unsubscribeSecret = randomBytes(32);
  const deps: SendDeps = {
    keyring,
    ses,
    unsubscribe: { secretKey: unsubscribeSecret, baseUrl: "https://app.example.com" },
  };

  expect(await sendEmail(db, deps, { emailId })).toBe("sent");
  // Unfold RFC 5322 header folding before matching; nodemailer normalizes
  // header casing, so compare case-insensitively like the transactional test.
  const mime = (sends[0]?.raw.toString("utf8") ?? "").replace(/\r\n[ \t]/g, "");
  const lowerMime = mime.toLowerCase();
  expect(lowerMime).toContain(`list-id: <${broadcast.id}.acme.dev>`);
  expect(lowerMime).toContain("precedence: bulk");
  expect(lowerMime).toContain("auto-submitted: auto-generated");
  expect(lowerMime).toContain("list-unsubscribe:");
  expect(lowerMime).toContain("list-unsubscribe-post: list-unsubscribe=one-click");
  const token = mime.match(/unsubscribe\/([A-Za-z0-9_.-]+)/)?.[1] ?? "";
  expect(verifyUnsubscribeToken(token, unsubscribeSecret)).toEqual({
    contactId,
    topicId: topic.id,
  });
});

it("a topic send to a contact substitutes both unsubscribe tokens and carries RFC 8058 headers", async () => {
  const [topic] = await db
    .insert(schema.topics)
    .values({ teamId, name: "Tx receipts", defaultSubscribed: true })
    .returning({ id: schema.topics.id });
  if (!topic) throw new Error("topic insert failed");
  const contactId = await insertContact("topic-contact@example.com");
  const { ses, sends } = fakeSes("mid-topic");
  const emailId = await insertEmail(
    { topicId: topic.id, to: ["topic-contact@example.com"] },
    '<a href="{{{UNSUBSCRIBE_URL}}}">a</a><a href="{{{RESEND_UNSUBSCRIBE_URL}}}">b</a>',
    "bye: {{{RESEND_UNSUBSCRIBE_URL}}}",
  );
  const unsubscribeSecret = randomBytes(32);
  const deps: SendDeps = {
    keyring,
    ses,
    unsubscribe: { secretKey: unsubscribeSecret, baseUrl: "https://app.example.com" },
  };

  expect(await sendEmail(db, deps, { emailId })).toBe("sent");
  const mime = unwrapQp(sends[0]?.raw.toString("utf8") ?? "").replace(/\r\n[ \t]/g, "");
  expect(mime).not.toContain("{{{");
  const lowerMime = mime.toLowerCase();
  expect(lowerMime).toMatch(/list-unsubscribe: ?<https:\/\/app\.example\.com\/unsubscribe\//);
  expect(lowerMime).toContain("list-unsubscribe-post: list-unsubscribe=one-click");
  // Both html tokens and the text token expand to the same signed URL.
  const tokens = [...mime.matchAll(/unsubscribe\/([A-Za-z0-9_.-]+)/g)].map((m) => m[1]);
  expect(tokens.length).toBeGreaterThanOrEqual(3);
  for (const t of tokens) {
    expect(verifyUnsubscribeToken(t ?? "", unsubscribeSecret)).toEqual({
      contactId,
      topicId: topic.id,
    });
  }
  // Topic sends are transactional: no bulk-mail class headers.
  expect(lowerMime).not.toContain("precedence:");
  expect(lowerMime).not.toContain("list-id:");
});

it("a topic send to a non-contact strips the placeholder tokens and carries no unsubscribe headers", async () => {
  const [topic] = await db
    .insert(schema.topics)
    .values({ teamId, name: "Tx alerts", defaultSubscribed: true })
    .returning({ id: schema.topics.id });
  if (!topic) throw new Error("topic insert failed");
  const { ses, sends } = fakeSes("mid-topic-stranger");
  const emailId = await insertEmail(
    { topicId: topic.id, to: ["stranger-topic@example.com"] },
    '<p>hi</p><a href="{{{UNSUBSCRIBE_URL}}}">a</a>',
    "bye: {{{RESEND_UNSUBSCRIBE_URL}}}",
  );
  const deps: SendDeps = {
    keyring,
    ses,
    unsubscribe: { secretKey: randomBytes(32), baseUrl: "https://app.example.com" },
  };

  expect(await sendEmail(db, deps, { emailId })).toBe("sent");
  const mime = unwrapQp(sends[0]?.raw.toString("utf8") ?? "");
  expect(mime).not.toContain("{{{");
  expect(mime.toLowerCase()).not.toContain("list-unsubscribe");
  expect(mime).not.toContain("/unsubscribe/");
});

it("suppresses a queued broadcast when the contact globally unsubscribes after fan-out", async () => {
  const contactId = await insertContact("late-global@example.com");
  const [broadcast] = await db
    .insert(schema.broadcasts)
    .values({ teamId, from: "Acme <a@acme.dev>", subject: "late" })
    .returning({ id: schema.broadcasts.id });
  if (!broadcast) throw new Error("broadcast insert failed");
  const emailId = await insertEmail({
    broadcastId: broadcast.id,
    contactId,
    to: ["late-global@example.com"],
  });
  await db
    .update(schema.contacts)
    .set({ unsubscribed: true, unsubscribedAt: new Date() })
    .where(eq(schema.contacts.id, contactId));

  const { ses, sends } = fakeSes();
  expect(
    await sendEmail(
      db,
      {
        keyring,
        ses,
        unsubscribe: { secretKey: randomBytes(32), baseUrl: "https://app.example.com" },
      },
      { emailId },
    ),
  ).toBe("suppressed");
  expect(sends).toHaveLength(0);
  const [row] = await db.select().from(schema.emails).where(eq(schema.emails.id, emailId));
  expect(row?.latestStatus).toBe("suppressed");
  const [event] = await db
    .select()
    .from(schema.emailEvents)
    .where(eq(schema.emailEvents.emailId, emailId));
  expect(event).toMatchObject({ type: "suppressed", data: { reason: "contact_unsubscribed" } });
});

it("suppresses a queued broadcast when the recipient is suppressed after fan-out", async () => {
  const address = "late-suppression@example.com";
  const contactId = await insertContact(address);
  const [broadcast] = await db
    .insert(schema.broadcasts)
    .values({ teamId, from: "Acme <a@acme.dev>", subject: "late" })
    .returning({ id: schema.broadcasts.id });
  if (!broadcast) throw new Error("broadcast insert failed");
  const emailId = await insertEmail({ broadcastId: broadcast.id, contactId, to: [address] });
  await db.insert(schema.suppressions).values({
    teamId,
    email: address,
    emailHash: hashRecipient(address),
    reason: "complaint",
  });

  const { ses, sends } = fakeSes();
  expect(
    await sendEmail(
      db,
      {
        keyring,
        ses,
        unsubscribe: { secretKey: randomBytes(32), baseUrl: "https://app.example.com" },
      },
      { emailId },
    ),
  ).toBe("suppressed");
  expect(sends).toHaveLength(0);
});

it("suppresses a queued broadcast when the contact opts out of its topic after fan-out", async () => {
  const address = "late-topic@example.com";
  const contactId = await insertContact(address);
  const [topic] = await db
    .insert(schema.topics)
    .values({ teamId, name: "Late topic", defaultSubscribed: true })
    .returning({ id: schema.topics.id });
  if (!topic) throw new Error("topic insert failed");
  const [broadcast] = await db
    .insert(schema.broadcasts)
    .values({ teamId, topicId: topic.id, from: "Acme <a@acme.dev>", subject: "late" })
    .returning({ id: schema.broadcasts.id });
  if (!broadcast) throw new Error("broadcast insert failed");
  const emailId = await insertEmail({ broadcastId: broadcast.id, contactId, to: [address] });
  await db.insert(schema.contactTopicSubscriptions).values({
    contactId,
    topicId: topic.id,
    subscribed: false,
  });

  const { ses, sends } = fakeSes();
  expect(
    await sendEmail(
      db,
      {
        keyring,
        ses,
        unsubscribe: { secretKey: randomBytes(32), baseUrl: "https://app.example.com" },
      },
      { emailId },
    ),
  ).toBe("suppressed");
  expect(sends).toHaveLength(0);
});

it("sends through the domain's own SES region, not the deployment default", async () => {
  const [saDomain] = await db
    .insert(schema.domains)
    .values({
      teamId,
      name: "acme.com.br",
      region: "sa-east-1",
      status: "verified",
      verifiedAt: new Date(),
    })
    .returning({ id: schema.domains.id });
  if (!saDomain) throw new Error("domain insert failed");
  const { ses, sends } = fakeSes("mid-region");
  const emailId = await insertEmail({ domainId: saDomain.id, from: "Acme <a@acme.com.br>" });

  expect(await sendEmail(db, { keyring, ses }, { emailId })).toBe("sent");
  expect(sends[0]?.region).toBe("sa-east-1");
});

it("falls back to the deployment configuration set when the domain has none", async () => {
  const [bareDomain] = await db
    .insert(schema.domains)
    .values({
      teamId,
      name: "bare.dev",
      region: "eu-west-1",
      status: "verified",
      verifiedAt: new Date(),
    })
    .returning({ id: schema.domains.id });
  if (!bareDomain) throw new Error("domain insert failed");
  const { ses, sends } = fakeSes("mid-fallback");
  const emailId = await insertEmail({ domainId: bareDomain.id, from: "Bare <a@bare.dev>" });

  const deps: SendDeps = { keyring, ses, defaultConfigurationSet: "deployment-set" };
  expect(await sendEmail(db, deps, { emailId })).toBe("sent");
  expect(sends[0]?.configurationSetName).toBe("deployment-set");
});

it("the domain's configuration set wins over the deployment fallback", async () => {
  const { ses, sends } = fakeSes("mid-domain-set");
  const emailId = await insertEmail();

  const deps: SendDeps = { keyring, ses, defaultConfigurationSet: "deployment-set" };
  expect(await sendEmail(db, deps, { emailId })).toBe("sent");
  expect(sends[0]?.configurationSetName).toBe("ms-config-set");
});

it("skips anything not in queued state — a job cannot force a send", async () => {
  const { ses, sends } = fakeSes();
  const deps: SendDeps = { keyring, ses };
  for (const latestStatus of ["queued_quota", "sent", "failed"] as const) {
    const emailId = await insertEmail({ latestStatus });
    expect(await sendEmail(db, deps, { emailId })).toBe("skipped");
  }
  expect(await sendEmail(db, deps, { emailId: crypto.randomUUID() })).toBe("skipped");
  expect(sends).toHaveLength(0);
});

it("defers a not-yet-due scheduled email back to the queue", async () => {
  const { ses, sends } = fakeSes();
  const due = new Date(Date.now() + 60 * 60 * 1000);
  const emailId = await insertEmail({ scheduledAt: due });
  const rescheduled: { emailId: string; at: Date }[] = [];
  const outcome = await sendEmail(
    db,
    {
      keyring,
      ses,
      reschedule: async (id, at) => {
        rescheduled.push({ emailId: id, at });
      },
    },
    { emailId },
  );
  // "skipped" here would ack the job and strand the email forever.
  expect(outcome).toBe("deferred");
  expect(rescheduled).toEqual([{ emailId, at: due }]);
  expect(sends).toHaveLength(0);
});

it("skips an already-claimed email — no duplicate delivery on retry", async () => {
  const { ses, sends } = fakeSes();
  // A prior attempt claimed the row (sentAt set) and reached SES before its
  // bookkeeping failed; the retry must NOT send again.
  const emailId = await insertEmail({ sentAt: new Date() });
  expect(await sendEmail(db, { keyring, ses }, { emailId })).toBe("skipped");
  expect(sends).toHaveLength(0);
});

it("sends once a past schedule has elapsed", async () => {
  const { ses } = fakeSes("mid-scheduled");
  const emailId = await insertEmail({ scheduledAt: new Date(Date.now() - 1000) });
  expect(await sendEmail(db, { keyring, ses }, { emailId })).toBe("sent");
});

it("missing body (e.g. purged before send) marks the email failed", async () => {
  const { ses, sends } = fakeSes();
  const emailId = await insertEmail({
    bodyCiphertext: null,
    bodyIv: null,
    bodyWrappedDek: null,
    bodyKeyVersion: null,
  });
  expect(await sendEmail(db, { keyring, ses }, { emailId })).toBe("failed");
  expect(sends).toHaveLength(0);
  const [row] = await db.select().from(schema.emails).where(eq(schema.emails.id, emailId));
  expect(row?.latestStatus).toBe("failed");
});

it("SES failure leaves the email queued for the job retry", async () => {
  const ses: SesSender = {
    async sendRaw() {
      throw new Error("throttled");
    },
  };
  const emailId = await insertEmail();
  await expect(sendEmail(db, { keyring, ses }, { emailId })).rejects.toThrow("throttled");
  const [row] = await db.select().from(schema.emails).where(eq(schema.emails.id, emailId));
  expect(row?.latestStatus).toBe("queued");
  expect(row?.sesMessageId).toBeNull();
  // The claim must be released, or the retry would skip and strand the email.
  expect(row?.sentAt).toBeNull();
});

it("no-ops a canceled email: no SES call, status stays canceled", async () => {
  const { ses, sends } = fakeSes("mid-cancel");
  const deps: SendDeps = { keyring, ses };
  // A future-scheduled email that a cancel flipped to canceled before its
  // send job ran.
  const emailId = await insertEmail({
    latestStatus: "canceled",
    scheduledAt: new Date(Date.now() + 3_600_000),
  });

  expect(await sendEmail(db, deps, { emailId })).toBe("skipped");
  expect(sends).toHaveLength(0);

  const [row] = await db.select().from(schema.emails).where(eq(schema.emails.id, emailId));
  expect(row?.latestStatus).toBe("canceled");
  expect(row?.sentAt).toBeNull();
});

it("a cancel that wins the race blocks the send claim", async () => {
  const { ses, sends } = fakeSes("mid-race");
  const deps: SendDeps = { keyring, ses };
  const emailId = await insertEmail({ scheduledAt: new Date(Date.now() - 1000) });
  // Cancel commits first (queued -> canceled), mirroring the API's CAS.
  await db
    .update(schema.emails)
    .set({ latestStatus: "canceled" })
    .where(eq(schema.emails.id, emailId));

  expect(await sendEmail(db, deps, { emailId })).toBe("skipped");
  expect(sends).toHaveLength(0);
});

it("attachments and custom headers ride the raw MIME; tracking still rewrites the html part", async () => {
  const { ses, sends } = fakeSes("mid-attach");
  const content = Buffer.from("hello attachment").toString("base64");
  const emailId = await insertEmail(
    {
      headers: { "X-Entity-Ref-ID": "ref-1" },
      attachments: await sealAttachments(
        [{ filename: "hi.txt", content, contentType: "text/plain" }],
        keyring,
      ),
    },
    `<a href="https://dest.test/landing">go</a>`,
  );
  const deps: SendDeps = {
    keyring,
    ses,
    tracking: { secretKey: trackingSecret, defaultBaseUrl: "https://track.example.com" },
  };
  expect(await sendEmail(db, deps, { emailId })).toBe("sent");

  // Raw MIME for structure; the qp-unwrapped copy only for URLs inside the
  // html part (unwrapQp would also eat the base64 padding at line ends).
  const raw = sends[0]?.raw.toString("utf8") ?? "";
  const lower = raw.toLowerCase();
  // Structural MIME shape: attachments force multipart/mixed with the
  // alternative body nested inside, plus one attachment part.
  expect(lower).toContain("content-type: multipart/mixed");
  expect(lower).toContain("content-type: multipart/alternative");
  expect(lower).toContain("content-type: text/plain; name=hi.txt");
  expect(lower).toContain("content-disposition: attachment; filename=hi.txt");
  expect(raw).toContain(content);
  // Custom header shipped; the transport-owned join header is still ours.
  expect(lower).toContain("x-entity-ref-id: ref-1");
  expect(lower).toContain(`x-millionsend-email-id: ${emailId}`);
  // Tracking rewrote the html part even on the attachment path.
  const mime = unwrapQp(raw);
  expect(mime).toContain("https://track.example.com/t/c/");
  expect(mime).not.toContain("dest.test");
});

it("clickTracking on routes <a href> through /t/c and the token verifies to the original url", async () => {
  const { ses, sends } = fakeSes("mid-click-track");
  const url = "https://dest.test/landing?x=1";
  const emailId = await insertEmail({}, `<a href="${url}">click</a>`);
  const deps: SendDeps = {
    keyring,
    ses,
    tracking: { secretKey: trackingSecret, defaultBaseUrl: "https://track.example.com" },
  };
  expect(await sendEmail(db, deps, { emailId })).toBe("sent");

  const mime = unwrapQp(sends[0]?.raw.toString("utf8") ?? "");
  expect(mime).toContain("https://track.example.com/t/c/");
  // The raw destination is gone: it lives only inside the signed token.
  expect(mime).not.toContain("dest.test");
  const match = mime.match(/\/t\/c\/([A-Za-z0-9_.-]+)/);
  expect(match).not.toBeNull();
  expect(verifyClickToken(match?.[1] ?? "", trackingSecret)).toEqual({ emailId, url });
});

it("openTracking on injects the pixel; a custom subdomain sets the tracking host", async () => {
  const [both] = await db
    .insert(schema.domains)
    .values({
      teamId,
      name: "both.dev",
      region: "us-east-1",
      status: "verified",
      verifiedAt: new Date(),
      clickTracking: true,
      openTracking: true,
      trackingSubdomain: "track",
    })
    .returning({ id: schema.domains.id });
  if (!both) throw new Error("domain insert failed");
  const { ses, sends } = fakeSes("mid-both");
  const emailId = await insertEmail(
    { domainId: both.id, from: "Both <a@both.dev>" },
    `<a href="https://dest.test/a">go</a>`,
  );
  const deps: SendDeps = {
    keyring,
    ses,
    tracking: { secretKey: trackingSecret, defaultBaseUrl: "https://fallback.test" },
  };
  expect(await sendEmail(db, deps, { emailId })).toBe("sent");

  const mime = unwrapQp(sends[0]?.raw.toString("utf8") ?? "");
  // The custom subdomain host wins over the deployment default.
  expect(mime).toContain("https://track.both.dev/t/c/");
  expect(mime).not.toContain("fallback.test");
  const pixel = mime.match(/\/t\/o\/([A-Za-z0-9_.-]+)/);
  expect(pixel).not.toBeNull();
  expect(verifyOpenToken(pixel?.[1] ?? "", trackingSecret)).toEqual({ emailId });
});

// A deployment with no certificate for customer hostnames must not ship links
// through one, even for a subdomain stored while the feature was available —
// mail already sent cannot be recalled.
it("allowSubdomains false falls back to the deployment host, stored subdomain and all", async () => {
  const [branded] = await db
    .insert(schema.domains)
    .values({
      teamId,
      name: "branded.dev",
      region: "us-east-1",
      status: "verified",
      verifiedAt: new Date(),
      clickTracking: true,
      openTracking: true,
      trackingSubdomain: "track",
    })
    .returning({ id: schema.domains.id });
  if (!branded) throw new Error("domain insert failed");
  const { ses, sends } = fakeSes("mid-branded");
  const emailId = await insertEmail(
    { domainId: branded.id, from: "Branded <a@branded.dev>" },
    `<a href="https://dest.test/a">go</a>`,
  );
  const deps: SendDeps = {
    keyring,
    ses,
    tracking: {
      secretKey: trackingSecret,
      defaultBaseUrl: "https://fallback.test",
      allowSubdomains: false,
    },
  };
  expect(await sendEmail(db, deps, { emailId })).toBe("sent");

  const mime = unwrapQp(sends[0]?.raw.toString("utf8") ?? "");
  expect(mime).toContain("https://fallback.test/t/c/");
  expect(mime).not.toContain("track.branded.dev");
  // Tracking itself still works — only the host changed.
  const pixel = mime.match(/\/t\/o\/([A-Za-z0-9_.-]+)/);
  expect(verifyOpenToken(pixel?.[1] ?? "", trackingSecret)).toEqual({ emailId });
});

it("both toggles off ships the raw link and no pixel (clean links)", async () => {
  const [clean] = await db
    .insert(schema.domains)
    .values({
      teamId,
      name: "clean.dev",
      region: "us-east-1",
      status: "verified",
      verifiedAt: new Date(),
      clickTracking: false,
      openTracking: false,
    })
    .returning({ id: schema.domains.id });
  if (!clean) throw new Error("domain insert failed");
  const { ses, sends } = fakeSes("mid-clean");
  const emailId = await insertEmail(
    { domainId: clean.id, from: "Clean <a@clean.dev>" },
    `<a href="https://dest.test/keepme">go</a>`,
  );
  const deps: SendDeps = {
    keyring,
    ses,
    tracking: { secretKey: trackingSecret, defaultBaseUrl: "https://track.example.com" },
  };
  expect(await sendEmail(db, deps, { emailId })).toBe("sent");

  const mime = unwrapQp(sends[0]?.raw.toString("utf8") ?? "");
  expect(mime).toContain("dest.test/keepme");
  expect(mime).not.toContain("/t/c/");
  expect(mime).not.toContain("/t/o/");
});

it("click on leaves an unexpanded {{{UNSUBSCRIBE_URL}}} intact", async () => {
  const { ses, sends } = fakeSes("mid-unsub-token");
  const emailId = await insertEmail(
    {},
    `<a href="{{{UNSUBSCRIBE_URL}}}">unsub</a><a href="https://dest.test/y">y</a>`,
  );
  const deps: SendDeps = {
    keyring,
    ses,
    tracking: { secretKey: trackingSecret, defaultBaseUrl: "https://track.example.com" },
  };
  expect(await sendEmail(db, deps, { emailId })).toBe("sent");

  const mime = unwrapQp(sends[0]?.raw.toString("utf8") ?? "");
  expect(mime).toContain("{{{UNSUBSCRIBE_URL}}}");
  expect(mime).toContain("/t/c/");
});

it("broadcast: an already-expanded in-body unsubscribe link is NOT click-wrapped, but ordinary links are", async () => {
  const [ct] = await db
    .insert(schema.domains)
    .values({
      teamId,
      name: "ct.dev",
      region: "us-east-1",
      status: "verified",
      verifiedAt: new Date(),
      clickTracking: true,
    })
    .returning({ id: schema.domains.id });
  if (!ct) throw new Error("domain insert failed");

  // send-broadcast substitutes {{{UNSUBSCRIBE_URL}}} to the real URL before
  // encryption; by send-time no {{{-token remains to guard it.
  const unsubUrl = "https://app.example.com/unsubscribe/Zm9v.YmFy";
  const { ses, sends } = fakeSes("mid-unsub-body");
  const contactId = await insertContact("tracking-unsub@example.com");
  const emailId = await insertEmail(
    {
      domainId: ct.id,
      from: "CT <a@ct.dev>",
      broadcastId: null,
      contactId,
      to: ["tracking-unsub@example.com"],
    },
    `<a href="${unsubUrl}">Unsubscribe</a><a href="https://dest.test/read">read</a>`,
  );
  const deps: SendDeps = {
    keyring,
    ses,
    unsubscribe: { secretKey: randomBytes(32), baseUrl: "https://app.example.com" },
    tracking: { secretKey: trackingSecret, defaultBaseUrl: "https://track.example.com" },
  };
  expect(await sendEmail(db, deps, { emailId })).toBe("sent");

  const mime = unwrapQp(sends[0]?.raw.toString("utf8") ?? "");
  // The visible unsubscribe link survives verbatim — no /t/c hop, no bogus
  // click. Wrapping would fold the raw URL into a signed token, so its literal
  // presence proves it was left untouched.
  expect(mime).toContain(unsubUrl);
  expect(mime).not.toMatch(/t\/c\/[^"']*unsubscribe/);
  // The ordinary link is still wrapped.
  expect(mime).toContain("https://track.example.com/t/c/");
  expect(mime).not.toContain("dest.test/read");
  // RFC 8058 header still points at the unsubscribe URL (unfold header folding).
  const headers = mime.replace(/\r\n[ \t]/g, "").toLowerCase();
  expect(headers).toContain("list-unsubscribe:<https://app.example.com/unsubscribe/");
});

it("tracking on with no base url and no subdomain fails loudly", async () => {
  const { ses, sends } = fakeSes();
  const emailId = await insertEmail({}, `<a href="https://dest.test/z">z</a>`);
  const deps: SendDeps = { keyring, ses, tracking: { secretKey: trackingSecret } };
  await expect(sendEmail(db, deps, { emailId })).rejects.toThrow(/APP_BASE_URL/);
  // Failed before the claim: nothing was sent and the row stays queued.
  expect(sends).toHaveLength(0);
  const [row] = await db.select().from(schema.emails).where(eq(schema.emails.id, emailId));
  expect(row?.latestStatus).toBe("queued");
  expect(row?.sentAt).toBeNull();
});

it("token bucket setRate re-paces the existing bucket", async () => {
  const bucket = createTokenBucket(1);
  await bucket.take(); // consumes the single initial token
  // At 1/s the next 10 takes would need ~10s; at 1000/s they refill almost
  // instantly. A generous bound keeps this robust on slow CI.
  bucket.setRate(1000);
  const start = Date.now();
  for (let i = 0; i < 10; i++) await bucket.take();
  expect(Date.now() - start).toBeLessThan(2000);
});

// A tracking host shared by every tenant is what ad blockers learn to block,
// so a deployment may require the domain's own subdomain — links then ship
// clean rather than through the shared host.
it("requireBrandedHost ships clean links when the domain has no subdomain", async () => {
  const [untracked] = await db
    .insert(schema.domains)
    .values({
      teamId,
      name: "untracked.dev",
      region: "us-east-1",
      status: "verified",
      verifiedAt: new Date(),
      clickTracking: true,
      openTracking: true,
    })
    .returning({ id: schema.domains.id });
  if (!untracked) throw new Error("domain insert failed");
  const { ses, sends } = fakeSes("mid-untracked");
  const emailId = await insertEmail(
    { domainId: untracked.id, from: "Untracked <a@untracked.dev>" },
    `<a href="https://dest.test/a">go</a>`,
  );
  const deps: SendDeps = {
    keyring,
    ses,
    tracking: {
      secretKey: trackingSecret,
      defaultBaseUrl: "https://fallback.test",
      requireBrandedHost: true,
    },
  };
  expect(await sendEmail(db, deps, { emailId })).toBe("sent");
  const mime = unwrapQp(sends[0]?.raw.toString("utf8") ?? "");
  expect(mime).toContain("https://dest.test/a");
  expect(mime).not.toContain("/t/c/");
  expect(mime).not.toContain("/t/o/");
  expect(mime).not.toContain("fallback.test");
});

it("requireBrandedHost still tracks through the domain's own subdomain", async () => {
  const [own] = await db
    .insert(schema.domains)
    .values({
      teamId,
      name: "ownhost.dev",
      region: "us-east-1",
      status: "verified",
      verifiedAt: new Date(),
      clickTracking: true,
      openTracking: false,
      trackingSubdomain: "track",
    })
    .returning({ id: schema.domains.id });
  if (!own) throw new Error("domain insert failed");
  const { ses, sends } = fakeSes("mid-own");
  const emailId = await insertEmail(
    { domainId: own.id, from: "Own <a@ownhost.dev>" },
    `<a href="https://dest.test/a">go</a>`,
  );
  const deps: SendDeps = {
    keyring,
    ses,
    tracking: {
      secretKey: trackingSecret,
      defaultBaseUrl: "https://fallback.test",
      requireBrandedHost: true,
    },
  };
  expect(await sendEmail(db, deps, { emailId })).toBe("sent");
  const mime = unwrapQp(sends[0]?.raw.toString("utf8") ?? "");
  expect(mime).toContain("https://track.ownhost.dev/t/c/");
  expect(mime).not.toContain("fallback.test");
});

it("a permanent SES refusal fails the email with an event instead of retrying", async () => {
  const ses: SesSender = {
    async sendRaw() {
      throw Object.assign(new Error("Email address is not verified"), { name: "MessageRejected" });
    },
  };
  const emailId = await insertEmail();
  expect(await sendEmail(db, { keyring, ses }, { emailId })).toBe("failed");
  const [row] = await db.select().from(schema.emails).where(eq(schema.emails.id, emailId));
  expect(row?.latestStatus).toBe("failed");
  expect(row?.sentAt).toBeNull();
  const events = await db
    .select()
    .from(schema.emailEvents)
    .where(eq(schema.emailEvents.emailId, emailId));
  expect(events.map((e) => [e.type, e.data?.reason])).toEqual([["failed", "ses_MessageRejected"]]);
});

it("an unverified sending domain fails the email terminally, before any decrypt or SES call", async () => {
  const { ses, sends } = fakeSes();
  const [pending] = await db
    .insert(schema.domains)
    .values({ teamId, name: "pending.dev", region: "us-east-1", status: "pending" })
    .returning({ id: schema.domains.id });
  const emailId = await insertEmail({
    domainId: pending?.id,
    // Undecryptable body: a decrypt before the domain gate would throw here.
    bodyCiphertext: Buffer.from("garbage"),
  });
  expect(await sendEmail(db, { keyring, ses }, { emailId })).toBe("failed");
  expect(sends).toHaveLength(0);
  const [row] = await db.select().from(schema.emails).where(eq(schema.emails.id, emailId));
  expect(row?.latestStatus).toBe("failed");
});

it("a transactional row re-checks suppression at send time: hits are stripped, an empty to refuses", async () => {
  const { ses, sends } = fakeSes("mid-strip");
  await db
    .insert(schema.suppressions)
    .values({
      teamId,
      email: "gone@example.com",
      emailHash: hashRecipient("gone@example.com"),
      reason: "hard_bounce",
    })
    .onConflictDoNothing();

  const stripped = await insertEmail({
    to: ["ok@example.com", "gone@example.com"],
    cc: ["gone@example.com"],
  });
  expect(await sendEmail(db, { keyring, ses }, { emailId: stripped })).toBe("sent");
  const [row] = await db.select().from(schema.emails).where(eq(schema.emails.id, stripped));
  expect(row?.to).toEqual(["ok@example.com"]);
  expect(row?.cc).toEqual([]);
  expect(sends[0]?.raw.toString()).not.toContain("gone@example.com");

  const refused = await insertEmail({ to: ["gone@example.com"] });
  expect(await sendEmail(db, { keyring, ses }, { emailId: refused })).toBe("suppressed");
  expect(sends).toHaveLength(1);
});

it("the send-rate token is taken only after every check that can still skip the row", async () => {
  const { ses } = fakeSes();
  let throttled = 0;
  const throttle = async () => {
    throttled += 1;
  };
  // Not in queued state: never reaches the bucket.
  const parked = await insertEmail({ latestStatus: "queued_quota" });
  expect(await sendEmail(db, { keyring, ses, throttle }, { emailId: parked })).toBe("skipped");
  expect(throttled).toBe(0);
  const emailId = await insertEmail();
  expect(await sendEmail(db, { keyring, ses, throttle }, { emailId })).toBe("sent");
  expect(throttled).toBe(1);
});
