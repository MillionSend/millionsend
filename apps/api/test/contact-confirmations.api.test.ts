import { randomBytes, randomUUID } from "node:crypto";
import { decryptEmailBody, EnvKeyring, generateApiKey, hashRecipient } from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb, createWebhookEndpoint } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/app.js";

const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
let db: Db,
  close: () => Promise<void>,
  app: ReturnType<typeof createApi>,
  teamId: string,
  token: string;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "confirmations");
  const key = generateApiKey();
  token = key.token;
  await db.insert(schema.apiKeys).values({
    teamId,
    name: "full",
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
  });
  app = createApi({ db, keyring, isCloud: false, enqueueEmailSend: async () => {} });
});
afterAll(() => close());
const call = (method: string, path: string, body?: unknown, key = token) =>
  app.request(path, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
async function prepare() {
  const body = {
    email: `${randomUUID()}@example.com`,
    request_id: randomUUID(),
    expires_at: new Date(Date.now() + 3600000).toISOString(),
  };
  const res = await call("POST", "/contacts/confirmation-requests", body);
  expect(res.status).toBe(200);
  const value = (await res.json()) as { id: string; requested_at: string };
  return { ...body, ...value } as typeof body & { id: string; requested_at: string };
}
const confirm = (p: Awaited<ReturnType<typeof prepare>>, extra: object = {}) =>
  call("POST", `/contacts/${p.id}/confirm`, {
    email: p.email,
    request_id: p.request_id,
    confirmed_at: new Date().toISOString(),
    ...extra,
  });
const row = async (id: string) =>
  (await db.select().from(schema.contacts).where(eq(schema.contacts.id, id)))[0];
describe("guarded mailbox confirmations", () => {
  it("stages inactive, authenticates, binds the address and confirms idempotently without changing profile", async () => {
    const p = await prepare(),
      before = await row(p.id);
    expect(before?.unsubscribed).toBe(true);
    expect((await call("GET", `/contacts/${p.id}/confirmation`, undefined, "bad")).status).toBe(
      401,
    );
    expect((await confirm(p, { email: "other@example.com" })).status).toBe(409);
    expect((await confirm(p, { request_id: randomUUID() })).status).toBe(409);
    await db
      .update(schema.contacts)
      .set({ firstName: "Ada", properties: { existing: "kept" } })
      .where(eq(schema.contacts.id, p.id));
    const at = new Date().toISOString();
    expect((await confirm(p, { confirmed_at: at })).status).toBe(200);
    expect((await confirm(p, { confirmed_at: at })).status).toBe(200);
    const after = await row(p.id);
    expect(after).toMatchObject({
      unsubscribed: false,
      firstName: "Ada",
      properties: { existing: "kept" },
      confirmation: { state: "confirmed", confirmedAt: at },
    });
    expect(after?.createdAt).toEqual(before?.createdAt);
    const activity = await db
      .select()
      .from(schema.contactActivities)
      .where(eq(schema.contactActivities.contactId, p.id));
    expect(activity.filter((x) => x.type === "resubscribed")).toHaveLength(1);
  });
  it.each(["PATCH", "batch"])(
    "a %s withdrawal while already inactive revokes the old link",
    async (path) => {
      const p = await prepare();
      const res =
        path === "PATCH"
          ? await call("PATCH", `/contacts/${p.id}`, { unsubscribed: true })
          : await call("POST", "/contacts/batch?on_conflict=upsert", [
              { email: p.email, unsubscribed: true },
            ]);
      expect(res.status).toBe(200);
      expect((await row(p.id))?.confirmation?.state).toBe("revoked");
      expect((await confirm(p)).status).toBe(409);
      expect((await row(p.id))?.unsubscribed).toBe(true);
      expect(
        (
          await call("POST", "/contacts/confirmation-requests", {
            email: p.email,
            request_id: randomUUID(),
            expires_at: p.expires_at,
          })
        ).status,
      ).toBe(409);
    },
  );
  it.each(["one_click_unsubscribe", "hard_bounce", "complaint", "manual"] as const)(
    "never removes a %s suppression",
    async (reason) => {
      const p = await prepare();
      await db
        .insert(schema.suppressions)
        .values({ teamId, email: p.email, emailHash: hashRecipient(p.email), reason });
      expect((await confirm(p)).status).toBe(409);
      expect((await row(p.id))?.unsubscribed).toBe(true);
      expect(
        await db
          .select()
          .from(schema.suppressions)
          .where(eq(schema.suppressions.emailHash, hashRecipient(p.email))),
      ).toHaveLength(1);
    },
  );
  it.each([true, false])(
    "preserves historical unsubscribed=%s contacts without manufacturing proof",
    async (unsubscribed) => {
      const email = `${randomUUID()}@example.com`;
      await db
        .insert(schema.contacts)
        .values({ teamId, email, unsubscribed, properties: { legacy: "kept" } });
      expect(
        (
          await call("POST", "/contacts/confirmation-requests", {
            email,
            request_id: randomUUID(),
            expires_at: new Date(Date.now() + 3600000).toISOString(),
          })
        ).status,
      ).toBe(409);
    },
  );
  it("replaces only a pending request; an old or expired request cannot activate", async () => {
    const p = await prepare(),
      request_id = randomUUID();
    expect(
      (
        await call("POST", "/contacts/confirmation-requests", {
          email: p.email,
          request_id,
          expires_at: p.expires_at,
        })
      ).status,
    ).toBe(200);
    expect((await confirm(p)).status).toBe(409);
    const contact = await row(p.id);
    if (!contact?.confirmation) throw new Error("Missing confirmation fixture");
    await db
      .update(schema.contacts)
      .set({
        confirmation: {
          ...contact.confirmation,
          expiresAt: new Date(Date.now() - 1).toISOString(),
        },
      })
      .where(eq(schema.contacts.id, p.id));
    expect((await confirm({ ...p, request_id })).status).toBe(409);
  });
  it("scopes proof and activation to the authenticated team", async () => {
    const p = await prepare(),
      other = await createTeam(db, "other"),
      key = generateApiKey();
    await db.insert(schema.apiKeys).values({
      teamId: other,
      name: "other",
      tokenPrefix: key.tokenPrefix,
      keyHash: key.keyHash,
      last4: key.last4,
    });
    expect((await call("GET", `/contacts/${p.id}/confirmation`, undefined, key.token)).status).toBe(
      404,
    );
    expect(
      (
        await call(
          "POST",
          `/contacts/${p.id}/confirm`,
          { email: p.email, request_id: p.request_id, confirmed_at: new Date().toISOString() },
          key.token,
        )
      ).status,
    ).toBe(404);
  });
});

it("persists disable-only tracking in the encrypted body and idempotency identity", async () => {
  await db
    .insert(schema.domains)
    .values({ teamId, name: "example.com", region: "us-east-1", status: "verified" });
  const body = {
    from: "test@example.com",
    to: ["person@example.com"],
    subject: "Confirm",
    text: "Confirm",
    tracking: { open: false, click: false },
  };
  const send = (payload: unknown) =>
    app.request("/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "untracked-test",
      },
      body: JSON.stringify(payload),
    });
  const res = await send(body);
  expect(res.status).toBe(200);
  const { id } = (await res.json()) as { id: string };
  const [email] = await db.select().from(schema.emails).where(eq(schema.emails.id, id));
  if (!email?.bodyCiphertext || !email.bodyIv || !email.bodyWrappedDek || !email.bodyKeyVersion)
    throw new Error("Missing email fixture");
  const decoded = await decryptEmailBody(
    {
      ciphertext: email.bodyCiphertext,
      iv: email.bodyIv,
      wrappedDek: email.bodyWrappedDek,
      keyVersion: email.bodyKeyVersion,
    },
    keyring,
    { teamId, rowId: id },
  );
  expect(decoded.tracking).toEqual({ open: false, click: false });
  expect((await send({ ...body, tracking: { open: true } })).status).toBe(422);
  expect((await send({ ...body, tracking: undefined })).status).toBe(409);
});

it("suppression removal cannot restore an old pending confirmation", async () => {
  const p = await prepare();
  const added = await call("POST", "/suppressions", { email: p.email, origin: "unsubscribe" });
  expect(added.status).toBe(200);
  const suppression = (await added.json()) as { id: string };
  expect((await row(p.id))?.confirmation?.state).toBe("revoked");
  expect((await call("DELETE", `/suppressions/${suppression.id}`)).status).toBe(200);
  expect((await confirm(p)).status).toBe(409);
});
it("rejects confirmation timestamps before the request or in the future", async () => {
  const p = await prepare();
  expect(
    (await confirm(p, { confirmed_at: new Date(Date.parse(p.requested_at) - 1).toISOString() }))
      .status,
  ).toBe(422);
  expect(
    (await confirm(p, { confirmed_at: new Date(Date.now() + 60000).toISOString() })).status,
  ).toBe(422);
  expect((await row(p.id))?.unsubscribed).toBe(true);
});
it("commits timeline and webhook outbox with confirmation even if queue wakeup fails", async () => {
  const endpointId = await createWebhookEndpoint(db, teamId, [
    "contact.created",
    "contact.resubscribed",
    "contact.updated",
  ]);
  const original = app;
  app = createApi({
    db,
    keyring,
    isCloud: false,
    enqueueEmailSend: async () => {},
    enqueueWebhookDeliveries: async () => {
      throw new Error("fixture queue unavailable");
    },
  });
  try {
    const p = await prepare();
    expect((await confirm(p)).status).toBe(200);
    const deliveries = await db
      .select()
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.endpointId, endpointId));
    expect(deliveries).toHaveLength(3);
    expect(deliveries.map((d) => d.eventType)).toContain("contact.resubscribed");
    expect((await row(p.id))?.confirmation?.state).toBe("confirmed");
  } finally {
    app = original;
  }
});

it("retention clears only an expired or revoked matching inactive proof, preserving profile and suppressions", async () => {
  const p = await prepare();
  const path = `/contacts/${p.id}/confirmation?request_id=${p.request_id}`;
  expect((await call("DELETE", path)).status).toBe(409);
  await call("PATCH", `/contacts/${p.id}`, { unsubscribed: true, first_name: "Kept" });
  expect((await call("DELETE", path.replace(p.request_id, randomUUID()))).status).toBe(409);
  expect((await call("DELETE", path)).status).toBe(200);
  expect((await call("DELETE", path)).status).toBe(200);
  expect(await row(p.id)).toMatchObject({
    unsubscribed: true,
    firstName: "Kept",
    confirmation: null,
  });
  expect((await confirm(p)).status).toBe(409);
});

it("abandoned-contact erasure is guarded under the same row lock and refuses active, profiled or suppressed contacts", async () => {
  const p = await prepare(),
    path = `/contacts/${p.id}/confirmation?request_id=${p.request_id}&erase_contact=true`;
  expect((await call("DELETE", path)).status).toBe(409);
  const before = await row(p.id);
  if (!before?.confirmation) throw new Error("Missing fixture");
  await db
    .update(schema.contacts)
    .set({
      confirmation: { ...before.confirmation, expiresAt: new Date(Date.now() - 1).toISOString() },
      firstName: "Keep",
    })
    .where(eq(schema.contacts.id, p.id));
  expect((await call("DELETE", path)).status).toBe(409);
  await db
    .update(schema.contacts)
    .set({ firstName: null, unsubscribed: false })
    .where(eq(schema.contacts.id, p.id));
  expect((await call("DELETE", path)).status).toBe(409);
  await db.update(schema.contacts).set({ unsubscribed: true }).where(eq(schema.contacts.id, p.id));
  expect((await call("DELETE", path)).status).toBe(200);
  expect(await row(p.id)).toBeUndefined();
});

it("only fresh explicit resubscription can lift the captured newsletter unsubscribe after confirmation", async () => {
  const email = `${randomUUID()}@example.com`;
  const [contact] = await db
    .insert(schema.contacts)
    .values({
      teamId,
      email,
      unsubscribed: true,
      firstName: "Original",
      properties: { source: "historic" },
    })
    .returning();
  const [block] = await db
    .insert(schema.suppressions)
    .values({ teamId, email, emailHash: hashRecipient(email), reason: "one_click_unsubscribe" })
    .returning();
  if (!contact || !block) throw new Error("Missing fixture");
  const request = {
    email,
    request_id: randomUUID(),
    expires_at: new Date(Date.now() + 3600000).toISOString(),
    allow_resubscribe: true,
  };
  expect(
    (
      await call("POST", "/contacts/confirmation-requests", {
        ...request,
        allow_resubscribe: false,
      })
    ).status,
  ).toBe(409);
  const pending = await call("POST", "/contacts/confirmation-requests", request);
  expect(pending.status).toBe(200);
  const proof = (await pending.json()) as Awaited<ReturnType<typeof prepare>> & {
    resubscription: boolean;
    created_contact: boolean;
  };
  expect(proof.resubscription).toBe(true);
  expect(proof.created_contact).toBe(false);
  expect((await row(contact.id))?.unsubscribed).toBe(true);
  expect(
    await db.select().from(schema.suppressions).where(eq(schema.suppressions.id, block.id)),
  ).toHaveLength(1);
  expect(
    (
      await call("POST", `/contacts/${contact.id}/confirm`, {
        email,
        request_id: randomUUID(),
        confirmed_at: new Date().toISOString(),
      })
    ).status,
  ).toBe(409);
  expect((await confirm({ ...request, ...proof })).status).toBe(200);
  expect(
    await db.select().from(schema.suppressions).where(eq(schema.suppressions.id, block.id)),
  ).toHaveLength(0);
  expect(await row(contact.id)).toMatchObject({
    unsubscribed: false,
    firstName: "Original",
    properties: { source: "historic" },
    createdAt: contact.createdAt,
  });
});

it.each(["hard_bounce", "complaint", "manual"] as const)(
  "fresh requests never lift %s blocks",
  async (reason) => {
    const email = `${randomUUID()}@example.com`;
    await db.insert(schema.contacts).values({ teamId, email, unsubscribed: true });
    await db
      .insert(schema.suppressions)
      .values({ teamId, email, emailHash: hashRecipient(email), reason });
    expect(
      (
        await call("POST", "/contacts/confirmation-requests", {
          email,
          request_id: randomUUID(),
          expires_at: new Date(Date.now() + 3600000).toISOString(),
          allow_resubscribe: true,
        })
      ).status,
    ).toBe(409);
  },
);

it("another withdrawal revokes resubscription; a later hard block is not disguised by an older unsubscribe", async () => {
  const p = await prepare();
  await call("PATCH", `/contacts/${p.id}`, { unsubscribed: true });
  await call("POST", "/suppressions", { email: p.email, origin: "unsubscribe" });
  const fresh = {
    email: p.email,
    request_id: randomUUID(),
    expires_at: p.expires_at,
    allow_resubscribe: true,
  };
  const pending = await call("POST", "/contacts/confirmation-requests", fresh);
  expect(pending.status).toBe(200);
  await call("POST", "/suppressions", { email: p.email, origin: "manual" });
  const current = await row(p.id);
  expect(current?.confirmation?.state).toBe("revoked");
  expect((await confirm({ ...p, ...fresh })).status).toBe(409);
  expect(
    (await call("POST", "/contacts/confirmation-requests", { ...fresh, request_id: randomUUID() }))
      .status,
  ).toBe(409);
  const [block] = await db
    .select()
    .from(schema.suppressions)
    .where(eq(schema.suppressions.emailHash, hashRecipient(p.email)));
  expect(block?.reason).toBe("manual");
});
