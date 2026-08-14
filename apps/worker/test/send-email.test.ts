import { randomBytes } from "node:crypto";
import { EnvKeyring, encryptEmailBody } from "@millionsend/core";
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
    })
    .returning({ id: schema.domains.id });
  if (!domain) throw new Error("domain insert failed");
  domainId = domain.id;
});
afterAll(() => close());

interface FakeSend {
  raw: Buffer;
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

async function insertEmail(
  overrides: Partial<typeof schema.emails.$inferInsert> = {},
): Promise<string> {
  const encrypted = await encryptEmailBody({ html: "<b>hi</b>", text: "hi" }, keyring);
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

  const [row] = await db.select().from(schema.emails).where(eq(schema.emails.id, emailId));
  expect(row?.sesMessageId).toBe("mid-happy");
  expect(row?.latestStatus).toBe("sent");
  expect(row?.sentAt).toBeInstanceOf(Date);
  const events = await db
    .select()
    .from(schema.emailEvents)
    .where(eq(schema.emailEvents.emailId, emailId));
  expect(events.map((e) => e.type)).toEqual(["sent"]);
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
