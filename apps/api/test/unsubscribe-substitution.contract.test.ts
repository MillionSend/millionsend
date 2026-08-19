import { randomBytes } from "node:crypto";
import { type ServerType, serve } from "@hono/node-server";
import {
  deriveUnsubscribeKey,
  EnvKeyring,
  generateApiKey,
  verifyUnsubscribeToken,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { Resend } from "resend";
import { afterAll, beforeAll, expect, it } from "vitest";
// The fan-out that performs the substitution lives in the worker; imported by
// path because @millionsend/worker is an app without a package export map.
import { sendBroadcast } from "../../worker/src/handlers/send-broadcast.js";
import { createApi } from "../src/app.js";

/**
 * Unsubscribe-substitution gate, SDK to inbox payload: a broadcast created
 * through the official `resend` SDK with the {{{RESEND_UNSUBSCRIBE_URL}}}
 * placeholder must fan out into per-contact emails whose bodies carry a real,
 * verifiable unsubscribe URL — never the literal placeholder.
 */

const APP_BASE_URL = "https://app.example.test";

let db: Db;
let closeDb: () => Promise<void>;
let server: ServerType;
let resend: Resend;
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
const unsubscribeSecretKey = deriveUnsubscribeKey(randomBytes(32));

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
  const teamId = await createTeam(db, "unsub-contract");
  await db.insert(schema.domains).values({
    teamId,
    name: "acme.dev",
    region: "us-east-1",
    status: "verified",
    verifiedAt: new Date(),
  });
  const key = generateApiKey();
  await db.insert(schema.apiKeys).values({
    teamId,
    name: "contract",
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
  });
  const app = createApi({
    db,
    keyring,
    isCloud: false,
    enqueueEmailSend: async () => {},
    enqueueBroadcastSend: async () => {},
    appBaseUrl: APP_BASE_URL,
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

it("fans out with a real per-contact unsubscribe URL, never the literal placeholder", async () => {
  const segment = await resend.segments.create({ name: "readers" });
  expect(segment.error).toBeNull();
  const segmentId = segment.data?.id ?? "";
  const contact = await resend.contacts.create({
    email: "reader@example.com",
    segments: [{ id: segmentId }],
  });
  expect(contact.error).toBeNull();

  const created = await resend.broadcasts.create({
    segmentId,
    from: "Acme <news@acme.dev>",
    subject: "launch",
    html: '<p>Hi</p><a href="{{{RESEND_UNSUBSCRIBE_URL}}}">Unsubscribe</a>',
    text: "Bye: {{{RESEND_UNSUBSCRIBE_URL}}}",
  });
  expect(created.error).toBeNull();
  const broadcastId = created.data?.id ?? "";
  const sent = await resend.broadcasts.send(broadcastId);
  expect(sent.error).toBeNull();

  // The worker fan-out — the step that substitutes the placeholder per contact.
  const queuedEmailIds: string[] = [];
  const outcome = await sendBroadcast(
    db,
    {
      keyring,
      unsubscribeSecretKey,
      appBaseUrl: APP_BASE_URL,
      isCloud: false,
      enqueueEmailSend: async (emailId) => {
        queuedEmailIds.push(emailId);
      },
    },
    { broadcastId },
  );
  expect(outcome).toBe("sent");
  expect(queuedEmailIds).toHaveLength(1);

  // The queued payload, read back through the SDK, carries the hosted URL.
  const email = await resend.emails.get(queuedEmailIds[0] ?? "");
  expect(email.error).toBeNull();
  for (const body of [email.data?.html ?? "", email.data?.text ?? ""]) {
    expect(body).not.toContain("{{{");
    expect(body).toContain(`${APP_BASE_URL}/unsubscribe/`);
  }

  // And the URL is real: its token verifies and names the fanned-out contact.
  const token = /\/unsubscribe\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/.exec(email.data?.html ?? "")?.[1];
  expect(token).toBeTruthy();
  expect(verifyUnsubscribeToken(token ?? "", unsubscribeSecretKey)).toEqual({
    contactId: contact.data?.id,
    topicId: null,
  });
});
