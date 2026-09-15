import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { EnvKeyring, generateApiKey } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import nodemailer from "nodemailer";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createSmtpServer, SMTP_USERNAME } from "../src/smtp.js";

let db: Db;
let closeDb: () => Promise<void>;
let teamId: string;
let token: string;
let port: number;
let server: ReturnType<typeof createSmtpServer>;
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));

const mail = { from: "Acme <a@acme.dev>", to: "r@example.com", subject: "s", text: "t" };

const transport = () =>
  nodemailer.createTransport({
    host: "127.0.0.1",
    port,
    secure: false,
    ignoreTLS: true,
    auth: { user: SMTP_USERNAME, pass: token },
  });

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
  teamId = await createTeam(db, "smtp-suspended");
  await db.insert(schema.domains).values({
    teamId,
    name: "acme.dev",
    region: "us-east-1",
    status: "verified",
    verifiedAt: new Date(),
  });
  const key = generateApiKey();
  token = key.token;
  await db.insert(schema.apiKeys).values({
    teamId,
    name: "smtp",
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
  });
  server = createSmtpServer({
    db,
    keyring,
    isCloud: true,
    allowInsecureAuth: true,
    enqueueEmailSend: async () => {},
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(resolve));
  await closeDb();
});

it("refuses a suspended team's message with 550 and accepts it again once reinstated", async () => {
  await db
    .update(schema.teams)
    .set({ suspendedAt: new Date(), suspensionReason: "manual" })
    .where(eq(schema.teams.id, teamId));
  await expect(transport().sendMail(mail)).rejects.toMatchObject({
    responseCode: 550,
    response: expect.stringContaining("suspended"),
  });
  expect(await db.select().from(schema.emails).where(eq(schema.emails.teamId, teamId))).toEqual([]);

  await db
    .update(schema.teams)
    .set({ suspendedAt: null, suspensionReason: null })
    .where(eq(schema.teams.id, teamId));
  const info = await transport().sendMail(mail);
  expect(info.response).toContain("Queued as");
});
