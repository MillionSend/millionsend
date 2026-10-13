import {
  generateApiKey,
  PLAN_CONTACT_LIMIT,
  type UndeliverableReason,
  undeliverableRecipientMessage,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addInbox,
  addThread,
  receive,
  seedWorld,
  type World,
} from "../../../packages/core/test/inbox-send-fixtures.js";
import { createApi } from "../src/app.js";

/**
 * Recipients on domains that can never receive mail are refused at accept
 * time: sends name the address with the simulator tip, new contacts with the
 * plain message. Static rules only, so no test waits on DNS.
 */

let db: Db;
let close: () => Promise<void>;
let w: World;
let app: ReturnType<typeof createApi>;
let token: string;

const PASS = "success@simulator.amazonses.com";

async function addKey(teamId: string): Promise<string> {
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

const call = (
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
  as = token,
) =>
  app.request(path, {
    method,
    headers: { authorization: `Bearer ${as}`, "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const forSend = (address: string, reason: UndeliverableReason) =>
  undeliverableRecipientMessage({ address, reason }, { forSend: true });
const plain = (address: string, reason: UndeliverableReason) =>
  undeliverableRecipientMessage({ address, reason });
const invalid = (message: string) => ({ statusCode: 422, name: "validation_error", message });

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  w = await seedWorld(db, "rd");
  app = createApi({
    ...w.deps,
    receiving: { mxHost: "mx.example.test", ingestSecret: "s".repeat(40) },
    sharedInboxDomain: w.sharedDomain,
  });
  token = await addKey(w.teamId);
});
afterAll(() => close());
beforeEach(() => {
  vi.stubEnv("RECIPIENT_DOMAIN_CHECK", "on");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("sends", () => {
  const email = (extra: Record<string, unknown>) => ({
    from: `Acme <a@${w.domain}>`,
    to: [PASS],
    subject: "s",
    text: "t",
    ...extra,
  });

  it("refuses POST /emails naming the impossible recipient in to, cc or bcc", async () => {
    const cases = [
      [{ to: [PASS, "Someone <Someone@Test.INVALID>"] }, "someone@test.invalid", "reserved_name"],
      [{ cc: ["x@mail.example.com"] }, "x@mail.example.com", "documentation_domain"],
      [{ bcc: ["x@mail.123"] }, "x@mail.123", "nonexistent_tld"],
    ] as const;
    const before = w.enqueuedEmails.length;
    for (const [extra, address, reason] of cases) {
      const res = await call("POST", "/emails", email(extra));
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual(invalid(forSend(address, reason)));
    }
    expect(w.enqueuedEmails.length).toBe(before);
  });

  it("accepts a reply_to that can never receive mail", async () => {
    const res = await call("POST", "/emails", email({ reply_to: "no-reply@app.invalid" }));
    expect(res.status).toBe(200);
  });

  it("answers a strict batch with its lowest failing index", async () => {
    const before = w.enqueuedEmails.length;
    const hitFirst = await call("POST", "/emails/batch", [
      email({}),
      email({ to: [PASS, "a@app.test"], cc: ["b@example.net"] }),
      email({ subject: undefined }),
    ]);
    expect(hitFirst.status).toBe(422);
    expect(await hitFirst.json()).toEqual(
      invalid(`emails.1: ${forSend("a@app.test", "reserved_name")}`),
    );

    const parseFirst = await call("POST", "/emails/batch", [
      email({}),
      email({ subject: undefined }),
      email({ to: ["a@app.test"] }),
    ]);
    expect(parseFirst.status).toBe(422);
    expect(((await parseFirst.json()) as { message: string }).message).toMatch(
      /^emails\.1: subject: /,
    );
    expect(w.enqueuedEmails.length).toBe(before);
  });

  it("lists a permissive batch's refusals per index, in index order", async () => {
    const res = await call(
      "POST",
      "/emails/batch",
      [
        email({}),
        email({ bcc: ["b@example.org"] }),
        email({ subject: undefined }),
        email({ cc: ["c@app.invalid"] }),
      ],
      { "x-batch-validation": "permissive" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; errors: unknown[] };
    expect(body.data).toHaveLength(1);
    expect(body.errors).toEqual([
      { index: 1, message: forSend("b@example.org", "documentation_domain") },
      { index: 2, message: expect.stringMatching(/^subject: /) },
      { index: 3, message: forSend("c@app.invalid", "reserved_name") },
    ]);
  });

  it("replays an idempotent batch whose recipient is refused since", async () => {
    const items = [email({}), email({ cc: ["x@foo.test"] })];
    const headers = { "idempotency-key": "rd-batch" };
    expect((await call("POST", "/emails/batch", items, headers)).status).toBe(422);
    // The refusal released the key, so the same request can still be accepted.
    vi.stubEnv("RECIPIENT_DOMAIN_CHECK", "off");
    const accepted = await call("POST", "/emails/batch", items, headers);
    expect(accepted.status).toBe(200);
    vi.stubEnv("RECIPIENT_DOMAIN_CHECK", "on");
    const replay = await call("POST", "/emails/batch", items, headers);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(await accepted.json());
  });

  it("refuses an inbox forward with 422", async () => {
    const inbox = await addInbox(w, { local: "desk", kind: "human" });
    const threadId = await addThread(w, inbox.id);
    const received = await receive(w, { inbox, threadId });
    const res = await call(
      "POST",
      `/inboxes/${inbox.id}/threads/${threadId}/emails/${received.id}/forward`,
      { to: "someone@test.invalid", text: "FYI" },
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual(invalid(forSend("someone@test.invalid", "reserved_name")));
  });
});

describe("contacts", () => {
  it("refuses a new contact on POST /contacts", async () => {
    const res = await call("POST", "/contacts", { email: "Ana@Test.INVALID" });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual(invalid(plain("ana@test.invalid", "reserved_name")));
  });

  it("fails a strict batch and marks the row in a permissive one", async () => {
    const items = [{ email: PASS }, { email: "x@mail.example.com" }];
    const message = plain("x@mail.example.com", "documentation_domain");
    const strict = await call("POST", "/contacts/batch", items);
    expect(strict.status).toBe(422);
    expect(await strict.json()).toEqual(invalid(`contacts.1: ${message}`));
    expect(await db.select().from(schema.contacts).where(eq(schema.contacts.email, PASS))).toEqual(
      [],
    );

    const permissive = await call("POST", "/contacts/batch", items, {
      "x-batch-validation": "permissive",
    });
    expect(permissive.status).toBe(200);
    expect(await permissive.json()).toMatchObject({
      data: [{ index: 0, status: "created" }],
      counts: { created: 1, updated: 0, skipped: 0, failed: 1 },
      errors: [{ index: 1, message }],
    });
  });

  it("skips, upserts and patches a stored contact on such a domain", async () => {
    const stored = "stored@app.invalid";
    const [row] = await db
      .insert(schema.contacts)
      .values({ teamId: w.teamId, email: stored })
      .returning({ id: schema.contacts.id });
    const skip = await call("POST", "/contacts/batch?on_conflict=skip", [{ email: stored }]);
    expect(await skip.json()).toMatchObject({ data: [{ id: row?.id, status: "skipped" }] });
    const upsert = await call("POST", "/contacts/batch?on_conflict=upsert", [
      { email: stored, first_name: "Ada" },
    ]);
    expect(await upsert.json()).toMatchObject({ data: [{ id: row?.id, status: "updated" }] });
    const patch = await call("PATCH", `/contacts/${stored}`, { last_name: "Lovelace" });
    expect(patch.status).toBe(200);
    const [after] = await db
      .select({ firstName: schema.contacts.firstName, lastName: schema.contacts.lastName })
      .from(schema.contacts)
      .where(eq(schema.contacts.email, stored));
    expect(after).toEqual({ firstName: "Ada", lastName: "Lovelace" });
  });

  it("lets a refused row use up no plan room", async () => {
    const teamId = await createTeam(db, "rd-free");
    await db.insert(schema.contacts).values(
      Array.from({ length: (PLAN_CONTACT_LIMIT.free ?? 0) - 1 }, (_, i) => ({
        teamId,
        email: `seed-${i}@example.com`,
      })),
    );
    const res = await call(
      "POST",
      "/contacts/batch",
      [{ email: "new@test.invalid" }, { email: PASS }],
      { "x-batch-validation": "permissive" },
      await addKey(teamId),
    );
    expect(await res.json()).toMatchObject({
      data: [{ index: 1, status: "created" }],
      errors: [{ index: 0, message: plain("new@test.invalid", "reserved_name") }],
    });
  });
});
