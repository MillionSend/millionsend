import { randomBytes } from "node:crypto";
import {
  acceptEmail,
  bindConsoleCodeMail,
  CONSOLE_CODE_MINUTES,
  consoleCodeId,
  consoleCodeUnsentId,
  EnvKeyring,
  hashRecipient,
  replaceConsoleCodeRow,
  SYSTEM_MAIL_TAG,
  sendSystemMail,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import type { SerializedSesEvent } from "@millionsend/queue";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq, like } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { processSesEvent } from "../src/handlers/process-ses-event.js";
import { type SesSender, sendEmail } from "../src/handlers/send-email.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;
let domainId: string;
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
const operatorId = crypto.randomUUID();
const operatorEmail = "op@example.com";
const FROM = "MillionSend <hello@mail.example.com>";

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  // The team that holds AUTH_EMAIL_FROM's domain, so account mail rides the queue.
  teamId = await createTeam(db, "account-mail");
  const [domain] = await db
    .insert(schema.domains)
    .values({
      teamId,
      name: "mail.example.com",
      region: "us-east-1",
      status: "verified",
      verifiedAt: new Date(),
    })
    .returning({ id: schema.domains.id });
  if (!domain) throw new Error("domain insert failed");
  domainId = domain.id;
  await db.insert(schema.user).values({ id: operatorId, name: "Operator", email: operatorEmail });
});
afterAll(() => close());
afterEach(async () => {
  await db.delete(schema.verification).where(like(schema.verification.identifier, "console-code%"));
  await db.delete(schema.suppressions).where(eq(schema.suppressions.teamId, teamId));
  await db
    .update(schema.teams)
    .set({ suspendedAt: null, suspensionReason: null })
    .where(eq(schema.teams.id, teamId));
});

const acceptDeps = () => ({ db, keyring, isCloud: false, enqueueEmailSend: async () => {} });

/** What the web app does for one code: the code's row, then its email, bound in its own accept. */
async function codeMail(): Promise<string> {
  const now = new Date();
  await replaceConsoleCodeRow(
    db,
    operatorId,
    { identifier: consoleCodeId(operatorId), value: `${"0".repeat(64)}:0` },
    now,
  );
  let emailId = "";
  const route = await sendSystemMail(
    {
      ...acceptDeps(),
      raw: async () => {
        throw new Error("a team holds the sender's domain");
      },
    },
    {
      from: FROM,
      to: operatorEmail,
      subject: "Your MillionSend console code",
      html: "<h1>123456</h1>",
      text: "123456",
      kind: "console_code",
    },
    {
      completeInTx: async (tx, id) => {
        emailId = id;
        await bindConsoleCodeMail(tx, operatorId, id, now);
      },
    },
  );
  expect(route).toBe("pipeline");
  return emailId;
}

function ses(answer: "accept" | Error): SesSender {
  return {
    async sendRaw() {
      if (answer instanceof Error) throw answer;
      return { messageId: `mid-${crypto.randomUUID()}` };
    },
  };
}

const sesError = (name: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(name), { name, ...extra });

const send = (emailId: string, answer: "accept" | Error) =>
  sendEmail(db, { keyring, ses: ses(answer) }, { emailId });

async function fallbackMark() {
  const [row] = await db
    .select()
    .from(schema.verification)
    .where(eq(schema.verification.identifier, consoleCodeUnsentId(operatorId)));
  return row;
}

async function codeRow() {
  const [row] = await db
    .select()
    .from(schema.verification)
    .where(eq(schema.verification.identifier, consoleCodeId(operatorId)));
  return row;
}

async function sesEvent(emailId: string, event: Partial<SerializedSesEvent>): Promise<void> {
  const [row] = await db
    .select({ mid: schema.emails.sesMessageId })
    .from(schema.emails)
    .where(eq(schema.emails.id, emailId));
  await processSesEvent(db, {
    eventType: "Delivery",
    sesMessageId: row?.mid ?? "",
    occurredAt: new Date().toISOString(),
    data: {},
    ...event,
  });
}

describe("a console code email the queue accepted and could not deliver", () => {
  it("opens the operator's fallback for the code's minutes when SES refuses it", async () => {
    expect(await send(await codeMail(), sesError("MessageRejected"))).toBe("failed");
    const mark = await fallbackMark();
    expect(mark?.value).toBe("1");
    const minutes = ((mark?.expiresAt.getTime() ?? 0) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(CONSOLE_CODE_MINUTES - 1);
    expect(minutes).toBeLessThanOrEqual(CONSOLE_CODE_MINUTES);
  });

  it("opens it when the queue never hands it to SES", async () => {
    // Refused at send: the address was suppressed after the accept.
    let emailId = await codeMail();
    await db.insert(schema.suppressions).values({
      teamId,
      email: operatorEmail,
      emailHash: hashRecipient(operatorEmail),
      reason: "manual",
    });
    expect(await send(emailId, "accept")).toBe("suppressed");
    expect(await fallbackMark()).toBeDefined();
    await db.delete(schema.suppressions).where(eq(schema.suppressions.teamId, teamId));

    // Held while the team holding the sender's domain is suspended.
    emailId = await codeMail();
    expect(await fallbackMark()).toBeUndefined();
    await db
      .update(schema.teams)
      .set({ suspendedAt: new Date(), suspensionReason: "manual" })
      .where(eq(schema.teams.id, teamId));
    expect(await send(emailId, "accept")).toBe("parked");
    expect(await fallbackMark()).toBeDefined();
    await db
      .update(schema.teams)
      .set({ suspendedAt: null, suspensionReason: null })
      .where(eq(schema.teams.id, teamId));

    // An attempt that throws: a retry may still deliver it, so the code stays.
    emailId = await codeMail();
    await expect(
      send(emailId, sesError("ServiceUnavailable", { $fault: "server" })),
    ).rejects.toThrow("ServiceUnavailable");
    expect(await fallbackMark()).toBeDefined();
    expect(await codeRow()).toBeDefined();
  });

  it("stays shut when SES took the email and only the bookkeeping after failed", async () => {
    const messageId = `mid-${crypto.randomUUID()}`;
    const took: SesSender = { sendRaw: async () => ({ messageId }) };
    expect(await sendEmail(db, { keyring, ses: took }, { emailId: await codeMail() })).toBe("sent");
    // The same message id again: recording it fails once SES has the email.
    const emailId = await codeMail();
    await expect(sendEmail(db, { keyring, ses: took }, { emailId })).rejects.toThrow();
    expect(await fallbackMark()).toBeUndefined();
  });

  it("opens it when SES reports a bounce or a reject, not on its accept", async () => {
    let emailId = await codeMail();
    expect(await send(emailId, "accept")).toBe("sent");
    expect(await fallbackMark()).toBeUndefined();
    await sesEvent(emailId, {
      eventType: "Bounce",
      bounce: {
        bounceType: "Transient",
        bounceSubType: "MailboxFull",
        recipients: [operatorEmail],
      },
    });
    expect(await fallbackMark()).toBeDefined();

    emailId = await codeMail();
    expect(await send(emailId, "accept")).toBe("sent");
    await sesEvent(emailId, { eventType: "Delivery" });
    expect(await fallbackMark()).toBeUndefined();
    await sesEvent(emailId, { eventType: "Reject" });
    expect(await fallbackMark()).toBeDefined();
  });

  it("is never opened by mail a client sent, whatever its tag and recipient", async () => {
    await codeMail();
    const forged = await acceptEmail(
      acceptDeps(),
      { teamId, billing: "uncapped", apiKeyId: crypto.randomUUID() },
      {
        from: FROM,
        to: [operatorEmail],
        subject: "Your MillionSend console code",
        text: "000000",
        domainId,
        tags: { [SYSTEM_MAIL_TAG]: "console_code" },
      },
    );
    if (!forged.ok) throw new Error("accept refused");
    expect(await send(forged.id, sesError("MessageRejected"))).toBe("failed");
    expect(await fallbackMark()).toBeUndefined();
  });

  it("leaves the fallback to the newest code's own email", async () => {
    const replaced = await codeMail();
    const newest = await codeMail();
    expect(await send(replaced, sesError("MessageRejected"))).toBe("failed");
    expect(await fallbackMark()).toBeUndefined();
    expect(await send(newest, sesError("MessageRejected"))).toBe("failed");
    expect(await fallbackMark()).toBeDefined();
  });
});
