import { randomBytes } from "node:crypto";
import { EnvKeyring, generateApiKey } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/app.js";

const PLATFORM = "MillionSend <hello@ms.example>";
const RESERVED = {
  statusCode: 422,
  name: "reserved_sender",
  message:
    "hello@ms.example is reserved for MillionSend's own onboarding email. Add and verify a domain to send your own emails: https://docs.millionsend.com/concepts/domains",
};

let db: Db;
let close: () => Promise<void>;
/** Holds the shared sender's own domain, verified: the operator's team, or a self-host tenant. */
let holderToken: string;
/** An ordinary customer: no domain at all, one verified member. */
let customerToken: string;

/** null: the instance configures no onboarding sender. */
function api(onboardingEmailFrom: string | null = PLATFORM) {
  return createApi({
    db,
    keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
    isCloud: true,
    onboardingEmailFrom: onboardingEmailFrom ?? undefined,
    appBaseUrl: "https://app.example.test",
    enqueueEmailSend: async () => {},
    enqueueBroadcastSend: async () => {},
  });
}

function post(
  app: ReturnType<typeof createApi>,
  token: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return app.request(path, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const email = (from: string, to = "ada@example.com") => ({
  from,
  to: [to],
  subject: "Recuperação de Senha",
  html: '<a href="https://evil.example/reset">Reset</a>',
});

async function keyFor(teamId: string): Promise<string> {
  const key = generateApiKey();
  await db.insert(schema.apiKeys).values({
    teamId,
    name: "k",
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
  });
  return key.token;
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  const holder = await createTeam(db, "holder");
  await db.insert(schema.domains).values(
    ["ms.example", "acme.dev"].map((name) => ({
      teamId: holder,
      name,
      region: "us-east-1",
      status: "verified" as const,
      verifiedAt: new Date(),
    })),
  );
  holderToken = await keyFor(holder);

  const customer = await createTeam(db, "customer");
  await db
    .insert(schema.user)
    .values({ id: "ada", name: "Ada", email: "ada@example.com", emailVerified: true });
  await db.insert(schema.teamMembers).values({ teamId: customer, userId: "ada", role: "owner" });
  customerToken = await keyFor(customer);
});
afterAll(() => close());

describe("the shared onboarding sender is reserved", () => {
  it("POST /emails refuses it, even to the team's own verified member", async () => {
    const res = await post(api(), customerToken, "/emails", email(PLATFORM));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual(RESERVED);
  });

  it("refuses it in any letter case or display name, even for the team holding its domain; other senders, and an instance without one, are unaffected", async () => {
    const app = api();
    for (const from of [PLATFORM, "HELLO@MS.EXAMPLE", "Security <Hello@ms.example>"]) {
      const res = await post(app, holderToken, "/emails", email(from));
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual(RESERVED);
    }
    expect((await post(app, holderToken, "/emails", email("news@ms.example"))).status).toBe(200);
    expect((await post(app, holderToken, "/emails", email("Acme <a@acme.dev>"))).status).toBe(200);
    expect((await post(api(null), holderToken, "/emails", email(PLATFORM))).status).toBe(200);
  });

  it("POST /emails/batch refuses it: the whole batch strict, the item alone permissive", async () => {
    const app = api();
    const batch = [email("a@acme.dev"), email(PLATFORM)];
    const strict = await post(app, holderToken, "/emails/batch", batch);
    expect(strict.status).toBe(422);
    expect(await strict.json()).toEqual({ ...RESERVED, message: `emails.1: ${RESERVED.message}` });

    const permissive = await post(app, holderToken, "/emails/batch", batch, {
      "x-batch-validation": "permissive",
    });
    expect(permissive.status).toBe(200);
    expect(await permissive.json()).toMatchObject({
      data: [{ id: expect.any(String) }],
      errors: [{ index: 1, message: RESERVED.message }],
    });
  });

  it("a broadcast from it is refused at send, on its own and with send: true", async () => {
    const app = api();
    const draft = { from: PLATFORM, subject: "News", html: "<p>hi</p>" };
    const created = await post(app, holderToken, "/broadcasts", draft);
    expect(created.status).toBe(200);
    const { id } = (await created.json()) as { id: string };
    const sent = await post(app, holderToken, `/broadcasts/${id}/send`, {});
    expect(sent.status).toBe(422);
    expect(await sent.json()).toEqual(RESERVED);

    const sendOnCreate = await post(app, holderToken, "/broadcasts", { ...draft, send: true });
    expect(sendOnCreate.status).toBe(422);
    expect(await sendOnCreate.json()).toEqual(RESERVED);
  });
});
