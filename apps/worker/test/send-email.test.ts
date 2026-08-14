import { randomBytes } from "node:crypto";
import { EnvKeyring, encryptEmailBody } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type SendDeps, type SesSender, sendEmail } from "../src/handlers/send-email.js";

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

it("skips scheduled emails whose time has not come", async () => {
  const { ses, sends } = fakeSes();
  const emailId = await insertEmail({ scheduledAt: new Date(Date.now() + 60 * 60 * 1000) });
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
});
