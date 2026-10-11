import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { type ServerType, serve } from "@hono/node-server";
import { createApi } from "@millionsend/api";
import { EnvKeyring, generateApiKey } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { Resend } from "resend";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type SesSender, sendEmail } from "../src/handlers/send-email.js";

/**
 * Refused files, end to end: the official resend SDK sends through a live
 * MillionSend API, and the worker hands what it accepts to a fake SES.
 * Program files never reach a row, a send job or SES.
 */

let db: Db;
let closeDb: () => Promise<void>;
let server: ServerType;
let resend: Resend;
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
const sendJobs: string[] = [];
const rawSends: Buffer[] = [];
const fakeSes: SesSender = {
  async sendRaw({ raw }) {
    rawSends.push(raw);
    return { messageId: `ses-attachments-${rawSends.length}` };
  },
};
const message = {
  from: "Billing <billing@e2e.dev>",
  to: ["customer@e2e.test"],
  subject: "Sua fatura",
  html: "<p>Segue a fatura de outubro.</p>",
};

const program = Buffer.alloc(0x80);
program.write("MZ", 0);
program.writeUInt32LE(0x40, 0x3c);
program.write("PE\0\0", 0x40);
// A stored ZIP holding a/run.js.
const zipWithScript = Buffer.from(
  "UEsDBBQAAAAAAHSDS12DFtyMAQAAAAEAAAAIAAAAYS9ydW4uanN4UEsBAhQDFAAAAAAAdINLXYMW3IwBAAAAAQAAAAgAAAAAAAAAAAAAAIABAAAAAGEvcnVuLmpzUEsFBgAAAAABAAEANgAAACcAAAAAAA==",
  "base64",
);
const invite = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "SUMMARY:Revisão do contrato",
  "DTSTART:20261020T130000Z",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
  const teamId = await createTeam(db, "e2e-attachments");
  await db.insert(schema.domains).values({
    teamId,
    name: "e2e.dev",
    region: "us-east-1",
    status: "verified",
    verifiedAt: new Date(),
  });
  const key = generateApiKey();
  await db.insert(schema.apiKeys).values({
    teamId,
    name: "e2e",
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
  });
  const app = createApi({
    db,
    keyring,
    isCloud: true,
    enqueueEmailSend: async (emailId) => {
      sendJobs.push(emailId);
    },
  });
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  resend = new Resend(key.token, { baseUrl: `http://127.0.0.1:${address.port}` });
});

afterAll(async () => {
  server.close();
  await closeDb();
});

it.each([
  ["invoice.exe", Buffer.from("hello"), `"invoice.exe" is refused: .exe files can't be sent`],
  [
    "fatura.pdf",
    program,
    `"fatura.pdf" is refused: its content is a Windows program, which can't be sent under any name`,
  ],
  [
    "files.zip",
    zipWithScript,
    `"files.zip" is refused: it holds "a/run.js", and .js files can't be sent`,
  ],
])("refuses %s with a 422 that names the file and why", async (filename, content, reason) => {
  const { data, error } = await resend.emails.send({
    ...message,
    attachments: [{ filename, content: content.toString("base64") }],
  });
  expect(data).toBeNull();
  expect(error).toMatchObject({
    statusCode: 422,
    name: "validation_error",
    message: `attachments.0.filename: ${reason}`,
  });
  expect(sendJobs).toEqual([]);
  expect(await db.select({ id: schema.emails.id }).from(schema.emails)).toEqual([]);
});

it("accepts a PDF and a calendar invite, and the worker sends both files", async () => {
  const pdf = readFileSync(new URL("./fixtures/media/owner-only.pdf", import.meta.url));
  const { data, error } = await resend.emails.send({
    ...message,
    attachments: [
      { filename: "statement.pdf", content: pdf.toString("base64") },
      {
        filename: "invite.ics",
        content: Buffer.from(invite).toString("base64"),
        contentType: "text/calendar",
      },
    ],
  });
  expect(error).toBeNull();
  if (!data) throw new Error("no data");
  expect(sendJobs).toEqual([data.id]);
  expect(await sendEmail(db, { keyring, ses: fakeSes }, { emailId: data.id })).toBe("sent");
  const raw = rawSends.at(-1)?.toString("utf8") ?? "";
  expect(raw).toContain("filename=statement.pdf");
  expect(raw).toContain("filename=invite.ics");
  expect(raw).toContain(pdf.subarray(0, 48).toString("base64").slice(0, 40));
  const [row] = await db.select().from(schema.emails).where(eq(schema.emails.id, data.id));
  expect(row?.latestStatus).toBe("sent");
});
