import { randomBytes } from "node:crypto";
import { EnvKeyring, generateApiKey, PLAN_CONTACT_LIMIT } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/app.js";

/**
 * The Free plan's contact cap: new contacts stop at the limit with
 * plan_limit_reached, existing ones still update, paid plans are uncapped.
 */

let db: Db;
let close: () => Promise<void>;
let app: ReturnType<typeof createApi>;
let teamId: string;
let token: string;
const limit = PLAN_CONTACT_LIMIT.free ?? 0;
const seeded = (i: number) => `seed-${i}@example.com`;

const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.request(path, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "capped");
  const key = generateApiKey();
  token = key.token;
  await db.insert(schema.apiKeys).values({
    teamId,
    name: "k",
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
  });
  await db
    .insert(schema.contacts)
    .values(Array.from({ length: limit }, (_, i) => ({ teamId, email: seeded(i) })));
  app = createApi({
    db,
    keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
    isCloud: true,
    enqueueEmailSend: async () => {},
  });
});
afterAll(() => close());

describe("contact cap on the Free plan", () => {
  it("refuses a new contact at the limit and still updates an existing one", async () => {
    const res = await call("POST", "/contacts", { email: "new@example.com" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      statusCode: 403,
      name: "plan_limit_reached",
      message: `Your plan allows up to ${limit} contacts`,
    });
    const patched = await call("PATCH", `/contacts/${seeded(0)}`, { first_name: "Ana" });
    expect(patched.status).toBe(200);
  });

  it("fails only the new contacts of a batch that exceeds the room", async () => {
    await db
      .delete(schema.contacts)
      .where(
        and(
          eq(schema.contacts.teamId, teamId),
          inArray(schema.contacts.email, [seeded(0), seeded(1)]),
        ),
      );
    const items = [
      { email: "n1@example.com" },
      { email: seeded(2), first_name: "B" },
      { email: "n2@example.com" },
      { email: seeded(3) },
      { email: "n3@example.com" },
    ];
    const strict = await call("POST", "/contacts/batch?on_conflict=upsert", items);
    expect(strict.status).toBe(403);
    expect(await strict.json()).toMatchObject({
      name: "plan_limit_reached",
      message: `contacts.0: Your plan allows up to ${limit} contacts`,
    });

    const permissive = await call("POST", "/contacts/batch?on_conflict=upsert", items, {
      "x-batch-validation": "permissive",
    });
    expect(permissive.status).toBe(200);
    expect(await permissive.json()).toMatchObject({
      counts: { created: 0, updated: 2, skipped: 0, failed: 3 },
      errors: [{ index: 0 }, { index: 2 }, { index: 4 }],
    });

    const fits = await call("POST", "/contacts/batch", [
      { email: "n1@example.com" },
      { email: "n2@example.com" },
    ]);
    expect(fits.status).toBe(200);
    expect(await fits.json()).toMatchObject({ counts: { created: 2, failed: 0 } });
  });

  it("a paid plan is uncapped", async () => {
    await db.update(schema.teams).set({ plan: "starter" }).where(eq(schema.teams.id, teamId));
    expect((await call("POST", "/contacts", { email: "paid@example.com" })).status).toBe(200);
  });
});
