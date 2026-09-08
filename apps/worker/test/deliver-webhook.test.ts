import { randomBytes } from "node:crypto";
import {
  EnvKeyring,
  encryptWebhookSecret,
  generateWebhookSecret,
  type Keyring,
  verifyWebhookSignature,
  WEBHOOK_MAX_ATTEMPTS,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  type DrainDeps,
  drainWebhookEndpoint,
  WEBHOOK_AUTO_DISABLE_AFTER,
} from "../src/handlers/deliver-webhook.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
const secret = generateWebhookSecret();

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "deliver-team");
});
afterAll(() => close());

async function insertEndpoint(
  overrides: Partial<typeof schema.webhookEndpoints.$inferInsert> = {},
): Promise<string> {
  const encrypted = await encryptWebhookSecret(secret, keyring);
  const [row] = await db
    .insert(schema.webhookEndpoints)
    .values({
      teamId,
      url: "https://receiver.example.com/hook",
      secretCiphertext: encrypted.ciphertext,
      secretIv: encrypted.iv,
      secretWrappedDek: encrypted.wrappedDek,
      secretKeyVersion: encrypted.keyVersion,
      secretLast4: secret.slice(-4),
      events: null,
      ...overrides,
    })
    .returning({ id: schema.webhookEndpoints.id });
  if (!row) throw new Error("endpoint insert failed");
  return row.id;
}

/** An open row due one second ago unless told otherwise. */
async function insertDelivery(
  endpointId: string,
  overrides: Partial<typeof schema.webhookDeliveries.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(schema.webhookDeliveries)
    .values({
      endpointId,
      messageId: `msg_${randomBytes(8).toString("hex")}`,
      eventType: "email.delivered",
      payload: { type: "email.delivered", data: { email_id: "e-1" } },
      nextAttemptAt: new Date(Date.now() - 1000),
      ...overrides,
    })
    .returning({ id: schema.webhookDeliveries.id });
  if (!row) throw new Error("delivery insert failed");
  return row.id;
}

interface FakePost {
  url: string;
  body: string;
  headers: Record<string, string>;
}

type Reply = { status: number; body: string; retryAfter?: string };

function fakeDeps(
  respond: (post: FakePost) => Promise<Reply>,
  now?: () => Date,
): DrainDeps & { posts: FakePost[]; rearmed: { endpointId: string; at: Date }[] } {
  const posts: FakePost[] = [];
  const rearmed: { endpointId: string; at: Date }[] = [];
  return {
    keyring,
    posts,
    rearmed,
    post: async (url, body, headers) => {
      const post = { url, body, headers };
      posts.push(post);
      return respond(post);
    },
    rearm: async (endpointId, at) => {
      rearmed.push({ endpointId, at });
    },
    ...(now ? { now } : {}),
  };
}

async function deliveryRow(id: string) {
  const [row] = await db
    .select()
    .from(schema.webhookDeliveries)
    .where(eq(schema.webhookDeliveries.id, id));
  if (!row) throw new Error("delivery row missing");
  return row;
}

async function endpointStatus(id: string) {
  const [row] = await db
    .select({ status: schema.webhookEndpoints.status })
    .from(schema.webhookEndpoints)
    .where(eq(schema.webhookEndpoints.id, id));
  return row?.status;
}

it("2xx: signs with Standard Webhooks headers, marks success, nothing left to re-arm", async () => {
  const endpointId = await insertEndpoint();
  const id = await insertDelivery(endpointId);
  const deps = fakeDeps(async () => ({ status: 200, body: "ok" }));

  expect(await drainWebhookEndpoint(db, deps, { endpointId })).toEqual({
    posted: 1,
    exhausted: 0,
    rearmAt: null,
  });

  expect(deps.posts).toHaveLength(1);
  const post = deps.posts[0];
  if (!post) throw new Error("no post");
  expect(post.url).toBe("https://receiver.example.com/hook");
  expect(JSON.parse(post.body)).toEqual({ type: "email.delivered", data: { email_id: "e-1" } });
  expect(
    verifyWebhookSignature(
      secret,
      {
        id: post.headers["webhook-id"] ?? "",
        timestamp: post.headers["webhook-timestamp"] ?? "",
        signature: post.headers["webhook-signature"] ?? "",
      },
      post.body,
    ),
  ).toBe(true);
  // Resend/Svix receivers read the svix-* names; both sets go out, identical.
  expect(post.headers["svix-id"]).toBe(post.headers["webhook-id"]);
  expect(post.headers["svix-timestamp"]).toBe(post.headers["webhook-timestamp"]);
  expect(post.headers["svix-signature"]).toBe(post.headers["webhook-signature"]);

  const row = await deliveryRow(id);
  expect(row.status).toBe("success");
  expect(row.attempts).toBe(1);
  expect(row.lastResponseCode).toBe(200);
  expect(row.lastResponseBody).toBe("ok");
  expect(row.nextAttemptAt).toBeNull();
  expect(deps.rearmed).toHaveLength(0);
});

it("failure: walks the backoff ladder and re-arms at min(next due, a minute out)", async () => {
  const endpointId = await insertEndpoint();
  const id = await insertDelivery(endpointId);
  let t = Date.now();
  const deps = fakeDeps(
    async () => ({ status: 500, body: "boom" }),
    () => new Date(t),
  );

  const first = await drainWebhookEndpoint(db, deps, { endpointId });
  expect(first.posted).toBe(1);
  const row = await deliveryRow(id);
  expect(row.status).toBe("failed");
  expect(row.attempts).toBe(1);
  expect(row.lastResponseCode).toBe(500);
  expect(row.nextAttemptAt?.getTime()).toBe(t + 5_000);
  // The first rung is inside the idle cap, so the re-arm lands exactly on it.
  expect(first.rearmAt?.getTime()).toBe(t + 5_000);
  expect(deps.rearmed).toEqual([{ endpointId, at: first.rearmAt }]);

  // Not yet due: the next pass posts nothing and parks on the same instant.
  t += 4_000;
  expect((await drainWebhookEndpoint(db, deps, { endpointId })).posted).toBe(0);
  expect(deps.posts).toHaveLength(1);

  // Due: second failure, five minutes out, and the re-arm caps at a minute.
  t += 2_000;
  const third = await drainWebhookEndpoint(db, deps, { endpointId });
  expect(third.posted).toBe(1);
  const row2 = await deliveryRow(id);
  expect(row2.attempts).toBe(2);
  expect(row2.nextAttemptAt?.getTime()).toBe(t + 5 * 60_000);
  expect(third.rearmAt?.getTime()).toBe(t + 60_000);
});

it("network error: records the message and retries", async () => {
  const endpointId = await insertEndpoint();
  const id = await insertDelivery(endpointId);
  const deps = fakeDeps(async () => {
    throw new Error("connect ECONNREFUSED");
  });

  expect((await drainWebhookEndpoint(db, deps, { endpointId })).posted).toBe(1);
  const row = await deliveryRow(id);
  expect(row.status).toBe("failed");
  expect(row.lastResponseCode).toBeNull();
  expect(row.lastResponseBody).toContain("ECONNREFUSED");
});

it("the last rung exhausts the delivery", async () => {
  const endpointId = await insertEndpoint();
  const id = await insertDelivery(endpointId, {
    status: "failed",
    attempts: WEBHOOK_MAX_ATTEMPTS - 1,
  });
  const deps = fakeDeps(async () => ({ status: 500, body: "still down" }));

  expect(await drainWebhookEndpoint(db, deps, { endpointId })).toEqual({
    posted: 1,
    exhausted: 1,
    rearmAt: null,
  });
  const row = await deliveryRow(id);
  expect(row.status).toBe("exhausted");
  expect(row.attempts).toBe(WEBHOOK_MAX_ATTEMPTS);
  expect(row.nextAttemptAt).toBeNull();
});

it("settled rows are never posted again", async () => {
  const endpointId = await insertEndpoint();
  await insertDelivery(endpointId, { status: "success", attempts: 1 });
  await insertDelivery(endpointId, { status: "exhausted", attempts: 6 });
  const deps = fakeDeps(async () => ({ status: 200, body: "ok" }));

  expect((await drainWebhookEndpoint(db, deps, { endpointId })).posted).toBe(0);
  expect(deps.posts).toHaveLength(0);
});

it("disabled endpoint: no request, every open row abandoned", async () => {
  const endpointId = await insertEndpoint({ status: "disabled" });
  const a = await insertDelivery(endpointId);
  const b = await insertDelivery(endpointId, { status: "failed", attempts: 2 });
  const settled = await insertDelivery(endpointId, { status: "success", attempts: 1 });
  const deps = fakeDeps(async () => ({ status: 200, body: "ok" }));

  expect(await drainWebhookEndpoint(db, deps, { endpointId })).toEqual({
    posted: 0,
    exhausted: 2,
    rearmAt: null,
  });
  expect(deps.posts).toHaveLength(0);
  expect((await deliveryRow(a)).status).toBe("exhausted");
  expect((await deliveryRow(b)).status).toBe("exhausted");
  expect((await deliveryRow(settled)).status).toBe("success");
});

it("unknown endpoint: a no-op", async () => {
  const deps = fakeDeps(async () => ({ status: 200, body: "ok" }));
  expect(
    await drainWebhookEndpoint(db, deps, { endpointId: "00000000-0000-0000-0000-000000000000" }),
  ).toEqual({ posted: 0, exhausted: 0, rearmAt: null });
});

it("auto-disables an endpoint once its recent settled deliveries are all exhausted", async () => {
  const endpointId = await insertEndpoint();
  for (let i = 0; i < WEBHOOK_AUTO_DISABLE_AFTER - 1; i += 1) {
    await insertDelivery(endpointId, { status: "exhausted", attempts: 6, nextAttemptAt: null });
  }
  // A still-retrying row is not settled and must not count either way.
  const retrying = await insertDelivery(endpointId, {
    status: "failed",
    attempts: 2,
    nextAttemptAt: new Date(Date.now() + 60_000),
  });
  const id = await insertDelivery(endpointId, { status: "failed", attempts: 5 });
  const deps = fakeDeps(async () => ({ status: 503, body: "down" }));

  const outcome = await drainWebhookEndpoint(db, deps, { endpointId });
  expect(outcome.exhausted).toBe(1);
  expect((await deliveryRow(id)).status).toBe("exhausted");
  expect(await endpointStatus(endpointId)).toBe("auto_disabled");
  // The retrying row is still open; the next pass sees the disabled endpoint and settles it.
  expect((await deliveryRow(retrying)).status).toBe("failed");
  expect(outcome.rearmAt).not.toBeNull();
});

it("one success inside the window keeps the breaker open", async () => {
  const endpointId = await insertEndpoint();
  for (let i = 0; i < WEBHOOK_AUTO_DISABLE_AFTER; i += 1) {
    await insertDelivery(endpointId, { status: "exhausted", attempts: 6, nextAttemptAt: null });
  }
  await insertDelivery(endpointId, { status: "success", attempts: 1, nextAttemptAt: null });
  const id = await insertDelivery(endpointId, { status: "failed", attempts: 5 });
  const deps = fakeDeps(async () => ({ status: 503, body: "down" }));

  expect((await drainWebhookEndpoint(db, deps, { endpointId })).exhausted).toBe(1);
  expect((await deliveryRow(id)).status).toBe("exhausted");
  expect(await endpointStatus(endpointId)).toBe("enabled");
});

it("posts due rows in due order and leaves rows not yet due alone", async () => {
  const endpointId = await insertEndpoint();
  const base = Date.now();
  const later = await insertDelivery(endpointId, {
    messageId: "msg_later",
    nextAttemptAt: new Date(base - 1_000),
  });
  const earliest = await insertDelivery(endpointId, {
    messageId: "msg_earliest",
    nextAttemptAt: new Date(base - 3_000),
  });
  const middle = await insertDelivery(endpointId, {
    messageId: "msg_middle",
    nextAttemptAt: new Date(base - 2_000),
  });
  const future = await insertDelivery(endpointId, {
    messageId: "msg_future",
    nextAttemptAt: new Date(base + 30_000),
  });
  const deps = fakeDeps(
    async () => ({ status: 200, body: "ok" }),
    () => new Date(base),
  );

  const outcome = await drainWebhookEndpoint(db, deps, { endpointId });
  expect(outcome.posted).toBe(3);
  expect(deps.posts.map((p) => p.headers["webhook-id"])).toEqual([
    "msg_earliest",
    "msg_middle",
    "msg_later",
  ]);
  for (const id of [earliest, middle, later])
    expect((await deliveryRow(id)).status).toBe("success");
  const untouched = await deliveryRow(future);
  expect(untouched.status).toBe("pending");
  expect(untouched.attempts).toBe(0);
  expect(untouched.nextAttemptAt?.getTime()).toBe(base + 30_000);
  // The re-arm lands on that row's due instant, inside the idle cap.
  expect(outcome.rearmAt?.getTime()).toBe(base + 30_000);
});

it("the time budget ends a pass mid-page and releases the rest as due now", async () => {
  const endpointId = await insertEndpoint();
  const ids = await Promise.all([1, 2, 3].map(() => insertDelivery(endpointId)));
  let t = Date.now();
  const deps = fakeDeps(
    async () => {
      // The receiver took longer than the whole budget.
      t += 30_000;
      return { status: 200, body: "ok" };
    },
    () => new Date(t),
  );

  const outcome = await drainWebhookEndpoint(db, deps, { endpointId });
  expect(outcome.posted).toBe(1);
  const rows = await db
    .select()
    .from(schema.webhookDeliveries)
    .where(inArray(schema.webhookDeliveries.id, ids));
  expect(rows.filter((r) => r.status === "success")).toHaveLength(1);
  const open = rows.filter((r) => r.status === "pending");
  expect(open).toHaveLength(2);
  for (const row of open) {
    expect(row.attempts).toBe(0);
    expect(row.nextAttemptAt?.getTime()).toBe(t);
  }
  // Still due: the successor is armed for right now.
  expect(outcome.rearmAt?.getTime()).toBe(t);
});

it("429: honours Retry-After without charging an attempt, parks the page, pauses the endpoint", async () => {
  const endpointId = await insertEndpoint();
  const base = Date.now();
  // More due rows than requests in flight: the first eight are posted and
  // throttled, the rest are handed back without ever reaching the receiver.
  const due = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      insertDelivery(endpointId, { nextAttemptAt: new Date(base - 2_000 + i) }),
    ),
  );
  // Due before Retry-After ends and never claimed: it still waits, because
  // the pause is the endpoint's, not the page's.
  const soon = await insertDelivery(endpointId, { nextAttemptAt: new Date(base + 10_000) });
  const deps = fakeDeps(
    async () => ({ status: 429, body: "slow down", retryAfter: "120" }),
    () => new Date(base),
  );

  const outcome = await drainWebhookEndpoint(db, deps, { endpointId });
  expect(outcome).toEqual({ posted: 8, exhausted: 0, rearmAt: new Date(base + 120_000) });
  expect(deps.rearmed).toEqual([{ endpointId, at: new Date(base + 120_000) }]);
  expect((await deliveryRow(soon)).nextAttemptAt?.getTime()).toBe(base + 10_000);
  let throttled = 0;
  let handedBack = 0;
  for (const id of due) {
    const row = await deliveryRow(id);
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(row.nextAttemptAt?.getTime()).toBe(base + 120_000);
    if (row.lastResponseCode === 429) throttled += 1;
    else if (row.lastResponseCode === null) handedBack += 1;
  }
  expect([throttled, handedBack]).toEqual([8, 4]);
});

it("a 429 that lands after a sibling ran out the budget still pauses the endpoint", async () => {
  const endpointId = await insertEndpoint();
  const base = Date.now();
  const okRow = await insertDelivery(endpointId, { nextAttemptAt: new Date(base - 2_000) });
  const throttledRow = await insertDelivery(endpointId, { nextAttemptAt: new Date(base - 1_000) });
  let t = base;
  let calls = 0;
  const deps = fakeDeps(
    async () => {
      calls += 1;
      if (calls === 1) {
        // The first response takes the whole budget and lands after the
        // sibling's request has already gone out; the sibling's answer is a 429.
        await new Promise((resolve) => setTimeout(resolve, 0));
        t += 30_000;
        return { status: 200, body: "ok" };
      }
      return { status: 429, body: "slow down", retryAfter: "120" };
    },
    () => new Date(t),
  );

  const outcome = await drainWebhookEndpoint(db, deps, { endpointId });
  expect(outcome.posted).toBe(2);
  expect(outcome.rearmAt?.getTime()).toBe(base + 120_000);
  expect(deps.rearmed).toEqual([{ endpointId, at: new Date(base + 120_000) }]);
  expect((await deliveryRow(okRow)).status).toBe("success");
  const parked = await deliveryRow(throttledRow);
  expect(parked.attempts).toBe(0);
  expect(parked.nextAttemptAt?.getTime()).toBe(base + 120_000);
});

it("a breaker trip mid-page hands the untaken rows back due now", async () => {
  const endpointId = await insertEndpoint();
  for (let i = 0; i < WEBHOOK_AUTO_DISABLE_AFTER - 1; i += 1) {
    await insertDelivery(endpointId, {
      status: "exhausted",
      attempts: WEBHOOK_MAX_ATTEMPTS,
      nextAttemptAt: null,
    });
  }
  // Twelve due rows on their last rung: the first exhaustion trips the breaker
  // while four rows are still untaken.
  const due = await Promise.all(
    Array.from({ length: 12 }, () =>
      insertDelivery(endpointId, { status: "failed", attempts: WEBHOOK_MAX_ATTEMPTS - 1 }),
    ),
  );
  const deps = fakeDeps(async () => ({ status: 503, body: "down" }));

  const before = Date.now();
  const outcome = await drainWebhookEndpoint(db, deps, { endpointId });
  expect(await endpointStatus(endpointId)).toBe("auto_disabled");
  expect(outcome.posted).toBe(8);
  let untaken = 0;
  for (const id of due) {
    const row = await deliveryRow(id);
    if (row.status === "failed") {
      untaken += 1;
      expect(row.attempts).toBe(WEBHOOK_MAX_ATTEMPTS - 1);
      expect(row.lastResponseCode).toBeNull();
      expect(row.nextAttemptAt?.getTime()).toBeLessThanOrEqual(Date.now());
    } else {
      expect(row.status).toBe("exhausted");
    }
  }
  expect(untaken).toBe(4);
  // Due now, so the successor is armed at once and settles them for the disabled endpoint.
  expect(deps.rearmed).toHaveLength(1);
  expect(deps.rearmed[0]?.at.getTime()).toBeGreaterThanOrEqual(before - 1);
});

it("an open row older than a day is exhausted without a request", async () => {
  const endpointId = await insertEndpoint();
  const stale = await insertDelivery(endpointId, {
    createdAt: new Date(Date.now() - 25 * 3_600_000),
  });
  const fresh = await insertDelivery(endpointId);
  const deps = fakeDeps(async () => ({ status: 200, body: "ok" }));

  expect(await drainWebhookEndpoint(db, deps, { endpointId })).toEqual({
    posted: 1,
    exhausted: 1,
    rearmAt: null,
  });
  const expired = await deliveryRow(stale);
  expect(expired.status).toBe("exhausted");
  expect(expired.attempts).toBe(0);
  expect(expired.nextAttemptAt).toBeNull();
  expect((await deliveryRow(fresh)).status).toBe("success");
});

it("decrypts the signing secret once per pass however many rows it posts", async () => {
  const endpointId = await insertEndpoint();
  await Promise.all([1, 2, 3].map(() => insertDelivery(endpointId)));
  let unwraps = 0;
  const counting: Keyring = {
    wrapDek: (dek) => keyring.wrapDek(dek),
    unwrapDek: (wrapped, keyVersion) => {
      unwraps += 1;
      return keyring.unwrapDek(wrapped, keyVersion);
    },
  };
  const deps = { ...fakeDeps(async () => ({ status: 200, body: "ok" })), keyring: counting };

  expect((await drainWebhookEndpoint(db, deps, { endpointId })).posted).toBe(3);
  expect(unwraps).toBe(1);
});

it("an idle re-arm pass never touches KMS", async () => {
  const endpointId = await insertEndpoint();
  await insertDelivery(endpointId, { nextAttemptAt: new Date(Date.now() + 30_000) });
  let unwraps = 0;
  const counting: Keyring = {
    wrapDek: (dek) => keyring.wrapDek(dek),
    unwrapDek: (wrapped, keyVersion) => {
      unwraps += 1;
      return keyring.unwrapDek(wrapped, keyVersion);
    },
  };
  const deps = { ...fakeDeps(async () => ({ status: 200, body: "ok" })), keyring: counting };

  const outcome = await drainWebhookEndpoint(db, deps, { endpointId });
  expect(outcome.posted).toBe(0);
  expect(outcome.rearmAt).not.toBeNull();
  expect(unwraps).toBe(0);
});

it("rows expired by age never trip the breaker", async () => {
  const endpointId = await insertEndpoint();
  const ids = await Promise.all(
    Array.from({ length: WEBHOOK_AUTO_DISABLE_AFTER }, () =>
      insertDelivery(endpointId, { createdAt: new Date(Date.now() - 25 * 3_600_000) }),
    ),
  );
  const deps = fakeDeps(async () => ({ status: 200, body: "ok" }));

  const outcome = await drainWebhookEndpoint(db, deps, { endpointId });
  expect(outcome).toEqual({ posted: 0, exhausted: WEBHOOK_AUTO_DISABLE_AFTER, rearmAt: null });
  expect(deps.posts).toHaveLength(0);
  for (const id of ids) expect((await deliveryRow(id)).status).toBe("exhausted");
  expect(await endpointStatus(endpointId)).toBe("enabled");
});

it("rows the receiver throttled until they aged out do count against it", async () => {
  const endpointId = await insertEndpoint();
  for (let i = 0; i < WEBHOOK_AUTO_DISABLE_AFTER; i += 1) {
    await insertDelivery(endpointId, {
      status: "exhausted",
      attempts: 0,
      lastResponseCode: 429,
      nextAttemptAt: null,
    });
  }
  const id = await insertDelivery(endpointId, {
    status: "failed",
    attempts: WEBHOOK_MAX_ATTEMPTS - 1,
  });
  const deps = fakeDeps(async () => ({ status: 503, body: "down" }));

  await drainWebhookEndpoint(db, deps, { endpointId });
  expect((await deliveryRow(id)).status).toBe("exhausted");
  expect(await endpointStatus(endpointId)).toBe("auto_disabled");
});

it("an aborted signal ends the pass at the next row and releases the rest as due now", async () => {
  const endpointId = await insertEndpoint();
  const [first, second] = await Promise.all([
    insertDelivery(endpointId),
    insertDelivery(endpointId, { nextAttemptAt: new Date(Date.now() - 500) }),
  ]);
  const controller = new AbortController();
  const deps = {
    ...fakeDeps(async () => {
      controller.abort();
      return { status: 200, body: "ok" };
    }),
    signal: controller.signal,
  };

  const before = Date.now();
  const outcome = await drainWebhookEndpoint(db, deps, { endpointId });
  expect(outcome.posted).toBe(1);
  expect(deps.posts).toHaveLength(1);
  expect((await deliveryRow(first)).status).toBe("success");
  const released = await deliveryRow(second);
  expect(released.status).toBe("pending");
  expect(released.attempts).toBe(0);
  expect(released.nextAttemptAt?.getTime()).toBeLessThanOrEqual(Date.now());
  expect(deps.rearmed).toHaveLength(1);
  expect(deps.rearmed[0]?.at.getTime()).toBeGreaterThanOrEqual(before - 1);
});

it("rows exhausted by a disable do not count once the endpoint is enabled again", async () => {
  const endpointId = await insertEndpoint({ status: "disabled" });
  for (let i = 0; i < WEBHOOK_AUTO_DISABLE_AFTER; i += 1) await insertDelivery(endpointId);
  const deps = fakeDeps(async () => ({ status: 503, body: "down" }));
  expect((await drainWebhookEndpoint(db, deps, { endpointId })).exhausted).toBe(
    WEBHOOK_AUTO_DISABLE_AFTER,
  );

  await db
    .update(schema.webhookEndpoints)
    .set({ status: "enabled" })
    .where(eq(schema.webhookEndpoints.id, endpointId));
  const id = await insertDelivery(endpointId, {
    status: "failed",
    attempts: WEBHOOK_MAX_ATTEMPTS - 1,
  });
  expect((await drainWebhookEndpoint(db, deps, { endpointId })).exhausted).toBe(1);
  expect((await deliveryRow(id)).status).toBe("exhausted");
  expect(await endpointStatus(endpointId)).toBe("enabled");
});

it("an endpoint disabled mid-pass stops at the next page, which is handed back untouched", async () => {
  const endpointId = await insertEndpoint();
  // One more than a page: the second page is where the re-check bites.
  const ids = await Promise.all(Array.from({ length: 51 }, () => insertDelivery(endpointId)));
  const base = Date.now();
  const deps = fakeDeps(
    async () => {
      await db
        .update(schema.webhookEndpoints)
        .set({ status: "disabled" })
        .where(eq(schema.webhookEndpoints.id, endpointId));
      return { status: 200, body: "ok" };
    },
    () => new Date(base),
  );

  const outcome = await drainWebhookEndpoint(db, deps, { endpointId });
  expect(outcome.posted).toBe(50);
  const rows = await db
    .select()
    .from(schema.webhookDeliveries)
    .where(inArray(schema.webhookDeliveries.id, ids));
  expect(rows.filter((r) => r.status === "success")).toHaveLength(50);
  const [left] = rows.filter((r) => r.status === "pending");
  expect(left?.attempts).toBe(0);
  expect(left?.nextAttemptAt?.getTime()).toBe(base);
  // Released as due now, so the successor runs at once and settles it.
  expect(outcome.rearmAt?.getTime()).toBe(base);
});
