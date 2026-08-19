import { randomBytes } from "node:crypto";
import { EnvKeyring, generateApiKey, hashRecipient, openAttachments } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/app.js";

let db: Db;
let close: () => Promise<void>;
let app: ReturnType<typeof createApi>;
let teamId: string;
let token: string;
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
const enqueuedSends: { emailId: string; startAfter?: Date }[] = [];

async function post(body: unknown, headers: Record<string, string> = {}) {
  return app.request("/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const validBody = {
  from: "Acme <a@acme.dev>",
  to: ["r@example.com"],
  subject: "s",
  text: "t",
};

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "api-team");
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
    name: "t",
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
  });
  app = createApi({
    db,
    keyring,
    isCloud: true,
    enqueueEmailSend: async (emailId, opts) => {
      enqueuedSends.push({ emailId, ...(opts?.startAfter ? { startAfter: opts.startAfter } : {}) });
    },
  });
});
afterAll(() => close());

describe("auth", () => {
  it("401s without a key, with Resend's error shape", async () => {
    const res = await app.request("/emails", { method: "POST" });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ statusCode: 401, name: "missing_api_key" });
  });
});

describe("not-fully-verified domain send gate", () => {
  // A domain row that exists for the team but whose status is short of
  // 'verified' (e.g. SPF still propagating) must never send: verifySenderDomain
  // keys off the stored status, which strict verification only sets to
  // 'verified' when every required DNS record passes both gates.
  const notVerified = { ...validBody, from: "Pending <a@pending.dev>", to: ["x@example.com"] };

  beforeAll(async () => {
    await db.insert(schema.domains).values({
      teamId,
      name: "pending.dev",
      region: "us-east-1",
      status: "pending",
    });
  });

  it("422s POST /emails from a pending domain", async () => {
    const res = await post(notVerified);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ statusCode: 422, name: "validation_error" });
  });

  it("422s POST /emails/batch when an item is from a pending domain, accepting nothing", async () => {
    const before = enqueuedSends.length;
    const res = await app.request("/emails/batch", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify([{ ...validBody, to: ["ok@example.com"] }, notVerified]),
    });
    expect(res.status).toBe(422);
    expect(enqueuedSends.length).toBe(before);
  });
});

describe("send edge cases", () => {
  it("parks the 101st email of the day as queued_quota but still accepts it", async () => {
    // Free plan cap is 100/day; burn it, then send one more.
    for (let i = 0; i < 4; i++) {
      const res = await post({ ...validBody, to: [`bulk${i}@example.com`] });
      expect(res.status).toBe(200);
    }
    await db
      .update(schema.usageCounters)
      .set({ accepted: 100 })
      .where(eq(schema.usageCounters.teamId, teamId));
    const res = await post({ ...validBody, to: ["overflow@example.com"] });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    const [row] = await db
      .select({ s: schema.emails.latestStatus })
      .from(schema.emails)
      .where(eq(schema.emails.id, id));
    expect(row?.s).toBe("queued_quota");
  });

  it("rejects when all recipients are suppressed", async () => {
    await db.insert(schema.suppressions).values({
      teamId,
      email: "dead@example.com",
      emailHash: hashRecipient("dead@example.com"),
      reason: "hard_bounce",
    });
    const res = await post({ ...validBody, to: ["dead@example.com"] });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ name: "validation_error" });
  });

  it("replays an idempotent send and conflicts on payload drift", async () => {
    const first = await post(validBody, { "idempotency-key": "same-key" });
    const { id } = (await first.json()) as { id: string };
    const replay = await post(validBody, { "idempotency-key": "same-key" });
    expect(((await replay.json()) as { id: string }).id).toBe(id);
    const drifted = await post(
      { ...validBody, subject: "different" },
      { "idempotency-key": "same-key" },
    );
    expect(drifted.status).toBe(409);
  });

  it("stores bodies encrypted at rest", async () => {
    const res = await post({ ...validBody, to: ["sealed@example.com"], html: "<p>secret</p>" });
    const { id } = (await res.json()) as { id: string };
    const [row] = await db
      .select({ ct: schema.emails.bodyCiphertext })
      .from(schema.emails)
      .where(eq(schema.emails.id, id));
    expect(row?.ct).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(row?.ct ?? []).includes("secret")).toBe(false);
  });

  it("is tenant-isolated on reads", async () => {
    const res = await post(validBody);
    const { id } = (await res.json()) as { id: string };
    const otherTeam = await createTeam(db, "intruder");
    const otherKey = generateApiKey();
    await db.insert(schema.apiKeys).values({
      teamId: otherTeam,
      name: "o",
      tokenPrefix: otherKey.tokenPrefix,
      keyHash: otherKey.keyHash,
      last4: otherKey.last4,
    });
    const stolen = await app.request(`/emails/${id}`, {
      headers: { authorization: `Bearer ${otherKey.token}` },
    });
    expect(stolen.status).toBe(404);
  });
});

describe("get email wire shape", () => {
  const get = (id: string) =>
    app.request(`/emails/${id}`, { headers: { authorization: `Bearer ${token}` } });

  it("maps internal queued_quota to queued and emits a placeholder message_id", async () => {
    const res = await post({ ...validBody, to: ["wire@example.com"] });
    const { id } = (await res.json()) as { id: string };
    await db
      .update(schema.emails)
      .set({ latestStatus: "queued_quota" })
      .where(eq(schema.emails.id, id));

    const body = (await (await get(id)).json()) as { last_event: string; message_id: string };
    // 'queued_quota' is not a member of the SDK's last_event union.
    expect(body.last_event).toBe("queued");
    expect(body.message_id).toBe(`<${id}@unsent.millionsend>`);
  });

  it("emits an RFC 5322 message_id from the stored SES message id", async () => {
    const res = await post({ ...validBody, to: ["wire2@example.com"] });
    const { id } = (await res.json()) as { id: string };
    await db
      .update(schema.emails)
      .set({ sesMessageId: "0100019abc" })
      .where(eq(schema.emails.id, id));
    const body = (await (await get(id)).json()) as { message_id: string };
    expect(body.message_id).toBe("<0100019abc@email.amazonses.com>");
  });
});

describe("batch send", () => {
  const batch = (items: unknown[], headers: Record<string, string> = {}) =>
    app.request("/emails/batch", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
      body: JSON.stringify(items),
    });

  it("accepts each item and returns ids in SDK shape", async () => {
    // Earlier suites burned the daily quota; clear it so accepts enqueue
    // instead of parking as queued_quota.
    await db
      .update(schema.usageCounters)
      .set({ accepted: 0 })
      .where(eq(schema.usageCounters.teamId, teamId));
    const res = await batch([
      { ...validBody, to: ["b1@example.com"] },
      { ...validBody, to: ["b2@example.com"] },
    ]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string }[] };
    expect(body.data).toHaveLength(2);
    for (const { id } of body.data) expect(id).toMatch(/^[0-9a-f-]{36}$/);
    // Each item ran through the accept pipeline and was enqueued.
    for (const { id } of body.data) {
      expect(enqueuedSends.some((e) => e.emailId === id)).toBe(true);
    }
  });

  it("fails the whole batch up front when any item is invalid (nothing accepted)", async () => {
    const before = enqueuedSends.length;
    const res = await batch([
      { ...validBody, to: ["ok@example.com"] },
      { ...validBody, from: "Nope <a@unverified.dev>", to: ["bad@example.com"] },
    ]);
    expect(res.status).toBe(422);
    expect(enqueuedSends.length).toBe(before);
  });

  it("422s over the 100-email cap", async () => {
    const items = Array.from({ length: 101 }, (_, i) => ({
      ...validBody,
      to: [`cap${i}@example.com`],
    }));
    expect((await batch(items)).status).toBe(422);
  });

  it("replays a repeated Idempotency-Key to the same ids", async () => {
    const items = [{ ...validBody, to: ["idem@example.com"] }];
    const first = (await (await batch(items, { "idempotency-key": "batch-key-1" })).json()) as {
      data: { id: string }[];
    };
    const second = (await (await batch(items, { "idempotency-key": "batch-key-1" })).json()) as {
      data: { id: string }[];
    };
    expect(second.data).toEqual(first.data);
  });
});

describe("batch send is atomic (no double-send on retry)", () => {
  it("a mid-batch failure after item 1 does not re-send item 1 on retry", async () => {
    const atomicTeam = await createTeam(db, "batch-atomic");
    await db.insert(schema.domains).values({
      teamId: atomicTeam,
      name: "atomic.dev",
      region: "us-east-1",
      status: "verified",
      verifiedAt: new Date(),
    });
    const key = generateApiKey();
    await db.insert(schema.apiKeys).values({
      teamId: atomicTeam,
      name: "atomic",
      tokenPrefix: key.tokenPrefix,
      keyHash: key.keyHash,
      last4: key.last4,
    });

    // Fail the Nth body-encryption to force a failure mid Pass-2, after an
    // earlier item's insert but before the batch commits.
    const realKeyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
    let failAt = Number.POSITIVE_INFINITY;
    let wraps = 0;
    const keyring = {
      async wrapDek(dek: Buffer) {
        wraps += 1;
        if (wraps >= failAt) throw new Error("injected wrap failure");
        return realKeyring.wrapDek(dek);
      },
      unwrapDek: (wrapped: Buffer, keyVersion: number) =>
        realKeyring.unwrapDek(wrapped, keyVersion),
    };

    const enqueued: string[] = [];
    const atomicApp = createApi({
      db,
      keyring,
      isCloud: true,
      enqueueEmailSend: async (id) => {
        enqueued.push(id);
      },
    });

    const items = [
      { from: "A <a@atomic.dev>", to: ["one@example.com"], subject: "atomic-1", text: "t" },
      { from: "A <a@atomic.dev>", to: ["two@example.com"], subject: "atomic-2", text: "t" },
    ];
    const send = (headers: Record<string, string>) =>
      atomicApp.request("/emails/batch", {
        method: "POST",
        headers: {
          authorization: `Bearer ${key.token}`,
          "content-type": "application/json",
          ...headers,
        },
        body: JSON.stringify(items),
      });

    // Attempt 1: second item's encryption throws inside the Pass-2 transaction.
    failAt = 2;
    const first = await send({ "idempotency-key": "atomic-key" });
    expect(first.status).toBeGreaterThanOrEqual(500);
    // Whole batch rolled back: item 1 was neither committed nor enqueued.
    expect(enqueued).toHaveLength(0);
    const afterFail = await db
      .select({ id: schema.emails.id })
      .from(schema.emails)
      .where(eq(schema.emails.teamId, atomicTeam));
    expect(afterFail).toHaveLength(0);

    // Attempt 2 (retry, same key): the batch succeeds exactly once.
    failAt = Number.POSITIVE_INFINITY;
    const retry = await send({ "idempotency-key": "atomic-key" });
    expect(retry.status).toBe(200);
    const rows = await db
      .select({ subject: schema.emails.subject })
      .from(schema.emails)
      .where(eq(schema.emails.teamId, atomicTeam));
    // Exactly two emails: item 1 from the failed attempt was NOT sent again.
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.subject === "atomic-1")).toHaveLength(1);
    expect(enqueued).toHaveLength(2);
  });
});

describe("cancel scheduled email", () => {
  const cancel = (id: string) =>
    app.request(`/emails/${id}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });

  async function scheduleEmail(to: string): Promise<string> {
    const res = await post({
      ...validBody,
      to: [to],
      scheduled_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
    return ((await res.json()) as { id: string }).id;
  }

  it("cancels a future-scheduled email and marks it canceled", async () => {
    const id = await scheduleEmail("cancel1@example.com");
    const res = await cancel(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ object: "email", id });
    const [row] = await db
      .select({ s: schema.emails.latestStatus })
      .from(schema.emails)
      .where(eq(schema.emails.id, id));
    expect(row?.s).toBe("canceled");
  });

  it("errors when the email was already sent", async () => {
    const id = await scheduleEmail("cancel2@example.com");
    await db
      .update(schema.emails)
      .set({ latestStatus: "sent", sentAt: new Date() })
      .where(eq(schema.emails.id, id));
    const res = await cancel(id);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ name: "validation_error" });
  });

  it("404s a cross-team email rather than canceling it", async () => {
    // A fresh team's scheduled email must be invisible to this token.
    const otherTeam = await createTeam(db, "cancel-other");
    await db.insert(schema.domains).values({
      teamId: otherTeam,
      name: "other-cancel.dev",
      region: "us-east-1",
      status: "verified",
      verifiedAt: new Date(),
    });
    const [foreign] = await db
      .insert(schema.emails)
      .values({
        teamId: otherTeam,
        from: "A <a@other-cancel.dev>",
        to: ["x@example.com"],
        subject: "s",
        latestStatus: "queued",
        scheduledAt: new Date(Date.now() + 3_600_000),
      })
      .returning({ id: schema.emails.id });
    if (!foreign) throw new Error("insert failed");
    const res = await cancel(foreign.id);
    expect(res.status).toBe(404);
    const [row] = await db
      .select({ s: schema.emails.latestStatus })
      .from(schema.emails)
      .where(eq(schema.emails.id, foreign.id));
    expect(row?.s).toBe("queued");
  });

  it("rejects canceling a non-scheduled (immediate) email", async () => {
    const res = await post({ ...validBody, to: ["immediate@example.com"] });
    const { id } = (await res.json()) as { id: string };
    expect((await cancel(id)).status).toBe(422);
  });
});

describe("reschedule scheduled email (PATCH /emails/{id})", () => {
  const patch = (id: string, body: unknown) =>
    app.request(`/emails/${id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const scheduledAtOf = async (id: string) =>
    (
      await db
        .select({ scheduledAt: schema.emails.scheduledAt })
        .from(schema.emails)
        .where(eq(schema.emails.id, id))
    )[0]?.scheduledAt;

  async function scheduleEmail(to: string): Promise<string> {
    const res = await post({
      ...validBody,
      to: [to],
      scheduled_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
    return ((await res.json()) as { id: string }).id;
  }

  it("reschedules a future email and re-enqueues at the new time", async () => {
    const id = await scheduleEmail("resched1@example.com");
    const at = new Date(Date.now() + 7_200_000);
    const res = await patch(id, { scheduled_at: at.toISOString() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ object: "email", id });
    expect((await scheduledAtOf(id))?.getTime()).toBe(at.getTime());
    const nudge = enqueuedSends.filter((e) => e.emailId === id);
    expect(nudge.at(-1)?.startAfter?.getTime()).toBe(at.getTime());
  });

  it("accepts a relative scheduled_at resolved against now", async () => {
    const id = await scheduleEmail("resched2@example.com");
    const before = Date.now();
    const res = await patch(id, { scheduled_at: "in 2 hours" });
    expect(res.status).toBe(200);
    const stored = (await scheduledAtOf(id))?.getTime() ?? 0;
    expect(stored).toBeGreaterThanOrEqual(before + 2 * 3_600_000);
    expect(stored).toBeLessThanOrEqual(Date.now() + 2 * 3_600_000);
  });

  it("422s when the email was already sent", async () => {
    const id = await scheduleEmail("resched3@example.com");
    await db
      .update(schema.emails)
      .set({ latestStatus: "sent", sentAt: new Date() })
      .where(eq(schema.emails.id, id));
    const res = await patch(id, { scheduled_at: new Date(Date.now() + 60_000).toISOString() });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ name: "validation_error" });
  });

  it("422s a canceled email", async () => {
    const id = await scheduleEmail("resched4@example.com");
    await app.request(`/emails/${id}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    const res = await patch(id, { scheduled_at: new Date(Date.now() + 60_000).toISOString() });
    expect(res.status).toBe(422);
  });

  it("422s a non-scheduled (immediate) email", async () => {
    const res = await post({ ...validBody, to: ["resched5@example.com"] });
    const { id } = (await res.json()) as { id: string };
    expect((await patch(id, { scheduled_at: "in 1 hour" })).status).toBe(422);
  });

  it("404s a cross-team email without touching it", async () => {
    const otherTeam = await createTeam(db, "resched-other");
    const [foreign] = await db
      .insert(schema.emails)
      .values({
        teamId: otherTeam,
        from: "A <a@other.dev>",
        to: ["x@example.com"],
        subject: "s",
        latestStatus: "queued",
        scheduledAt: new Date(Date.now() + 3_600_000),
      })
      .returning({ id: schema.emails.id, scheduledAt: schema.emails.scheduledAt });
    if (!foreign) throw new Error("insert failed");
    const res = await patch(foreign.id, { scheduled_at: "in 1 day" });
    expect(res.status).toBe(404);
    expect((await scheduledAtOf(foreign.id))?.getTime()).toBe(foreign.scheduledAt?.getTime());
  });

  it("re-validates the 30-day cap and the accepted forms", async () => {
    const id = await scheduleEmail("resched6@example.com");
    const tooFar = await patch(id, {
      scheduled_at: new Date(Date.now() + 31 * 86_400_000).toISOString(),
    });
    expect(tooFar.status).toBe(422);
    expect(await tooFar.json()).toMatchObject({
      message: expect.stringMatching(/30 days/),
    });
    const garbage = await patch(id, { scheduled_at: "tomorrow" });
    expect(garbage.status).toBe(422);
    // The 422 names both accepted forms.
    expect(await garbage.json()).toMatchObject({
      message: expect.stringMatching(/ISO 8601.*in 5 mins/),
    });
  });
});

describe("natural-language scheduled_at on send", () => {
  it("accepts 'in N mins' and enqueues with the resolved startAfter", async () => {
    const before = Date.now();
    const res = await post({
      ...validBody,
      to: ["nl-sched@example.com"],
      scheduled_at: "in 5 mins",
    });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    const enqueued = enqueuedSends.find((e) => e.emailId === id);
    expect(enqueued?.startAfter?.getTime()).toBeGreaterThanOrEqual(before + 5 * 60_000);
    expect(enqueued?.startAfter?.getTime()).toBeLessThanOrEqual(Date.now() + 5 * 60_000);
  });

  it("still rejects unparseable values naming both forms", async () => {
    const res = await post({ ...validBody, scheduled_at: "next tuesday" });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      name: "validation_error",
      message: expect.stringMatching(/ISO 8601.*in 5 mins/),
    });
  });
});

describe("batch permissive validation", () => {
  const batch = (items: unknown[], headers: Record<string, string> = {}) =>
    app.request("/emails/batch", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
      body: JSON.stringify(items),
    });
  const permissive = { "x-batch-validation": "permissive" };

  it("accepts the valid subset and reports the rest per index", async () => {
    const before = enqueuedSends.length;
    const res = await batch(
      [
        { ...validBody, to: ["perm-ok@example.com"] },
        { ...validBody, text: undefined }, // schema-invalid: no html, no text
        { ...validBody, from: "Nope <a@unverified.dev>" }, // unverified domain
        { ...validBody, to: ["dead@example.com"] }, // suppressed earlier in this suite
      ],
      permissive,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { id: string }[];
      errors: { index: number; message: string }[];
    };
    expect(body.data).toHaveLength(1);
    expect(body.errors).toEqual([
      { index: 1, message: expect.stringMatching(/html or text/) },
      { index: 2, message: expect.stringMatching(/not verified/) },
      { index: 3, message: expect.stringMatching(/suppressed/) },
    ]);
    // Only the valid item was accepted and enqueued.
    expect(enqueuedSends.slice(before).map((e) => e.emailId)).toEqual([body.data[0]?.id]);
  });

  it("includes an empty errors array when every item is valid", async () => {
    const res = await batch([{ ...validBody, to: ["perm-all-ok@example.com"] }], permissive);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string }[]; errors: unknown[] };
    expect(body.data).toHaveLength(1);
    expect(body.errors).toEqual([]);
  });

  it("accepts nothing when every item fails, still a 200 with errors", async () => {
    const before = enqueuedSends.length;
    const res = await batch([{ ...validBody, text: undefined }], permissive);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; errors: { index: number }[] };
    expect(body.data).toEqual([]);
    expect(body.errors).toHaveLength(1);
    expect(enqueuedSends.length).toBe(before);
  });

  it("strict mode (default) still fails the whole batch and omits errors", async () => {
    const before = enqueuedSends.length;
    const res = await batch([
      { ...validBody, to: ["strict-ok@example.com"] },
      { ...validBody, text: undefined },
    ]);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      name: "validation_error",
      message: expect.stringMatching(/^emails\.1: /),
    });
    expect(enqueuedSends.length).toBe(before);
  });
});

describe("attachments and custom headers", () => {
  const pdfBase64 = Buffer.from("%PDF-1.4 fake pdf bytes").toString("base64");

  it("accepts them, stores headers as metadata and attachments sealed", async () => {
    const res = await post({
      ...validBody,
      to: ["attach@example.com"],
      attachments: [{ filename: "x.pdf", content: pdfBase64, content_type: "application/pdf" }],
      headers: { "X-Entity-Ref-ID": "ref-1" },
    });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    const [row] = await db
      .select({ headers: schema.emails.headers, attachments: schema.emails.attachments })
      .from(schema.emails)
      .where(eq(schema.emails.id, id));
    expect(row?.headers).toEqual({ "X-Entity-Ref-ID": "ref-1" });
    // Sealed at rest: neither the payload nor the filename is stored in the clear.
    expect(row?.attachments).toBeTruthy();
    expect(row?.attachments).not.toContain(pdfBase64);
    expect(row?.attachments).not.toContain("x.pdf");
    expect(await openAttachments(row?.attachments ?? "", keyring)).toEqual([
      { filename: "x.pdf", content: pdfBase64, contentType: "application/pdf" },
    ]);
  });

  it("rejects path attachments with a clear message, never fetching the URL", async () => {
    const res = await post({
      ...validBody,
      attachments: [{ filename: "x.pdf", path: "https://evil.test/x.pdf" }],
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      name: "validation_error",
      message: expect.stringMatching(/path attachments are not supported/),
    });
  });

  it("rejects non-base64 attachment content", async () => {
    const res = await post({
      ...validBody,
      attachments: [{ filename: "x.txt", content: "not base64!!" }],
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      message: expect.stringMatching(/base64/),
    });
  });

  it("rejects attachments missing content", async () => {
    const res = await post({ ...validBody, attachments: [{ filename: "x.txt" }] });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      message: expect.stringMatching(/content is required/),
    });
  });

  it("rejects reserved transport headers case-insensitively", async () => {
    for (const name of ["From", "bCC", "list-UNSUBSCRIBE", "Content-Type", "X-SES-SOURCE-ARN"]) {
      const res = await post({ ...validBody, headers: { [name]: "x" } });
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({
        message: expect.stringMatching(/reserved header/),
      });
    }
  });

  it("rejects header values that could smuggle extra headers", async () => {
    const res = await post({
      ...validBody,
      headers: { "X-Entity-Ref-ID": "a\r\nBcc: evil@example.com" },
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      message: expect.stringMatching(/control characters/),
    });
  });

  it("validates batch items the same way and accepts valid ones", async () => {
    const bad = await app.request("/emails/batch", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify([
        { ...validBody, attachments: [{ filename: "x.pdf", path: "https://evil.test/x" }] },
      ]),
    });
    expect(bad.status).toBe(422);

    const ok = await app.request("/emails/batch", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify([
        {
          ...validBody,
          to: ["batch-attach@example.com"],
          attachments: [{ filename: "a.txt", content: Buffer.from("hi").toString("base64") }],
          headers: { "X-Entity-Ref-ID": "batch-1" },
        },
      ]),
    });
    expect(ok.status).toBe(200);
    const { data } = (await ok.json()) as { data: { id: string }[] };
    const [row] = await db
      .select({ headers: schema.emails.headers, attachments: schema.emails.attachments })
      .from(schema.emails)
      .where(eq(schema.emails.id, data[0]?.id ?? ""));
    expect(row?.headers).toEqual({ "X-Entity-Ref-ID": "batch-1" });
    expect(row?.attachments).toBeTruthy();
  });
});

describe("openapi", () => {
  it("serves the generated spec without auth", async () => {
    const res = await app.request("/openapi.json");
    expect(res.status).toBe(200);
    const spec = (await res.json()) as { paths: Record<string, unknown> };
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining(["/emails", "/emails/{id}", "/emails/batch", "/emails/{id}/cancel"]),
    );
  });
});
