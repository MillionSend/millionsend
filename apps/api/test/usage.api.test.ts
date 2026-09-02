import { randomBytes } from "node:crypto";
import { EnvKeyring, generateApiKey } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/app.js";

let db: Db;
let close: () => Promise<void>;
let cloud: ReturnType<typeof createApi>;
let selfHost: ReturnType<typeof createApi>;
let teamId: string;
let token: string;
let sendOnlyToken: string;

const get = (app: ReturnType<typeof createApi>, tok = token) =>
  app.request("/usage", { headers: { authorization: `Bearer ${tok}` } });

async function insertKey(overrides: Partial<typeof schema.apiKeys.$inferInsert> = {}) {
  const key = generateApiKey();
  await db.insert(schema.apiKeys).values({
    teamId,
    name: "k",
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
    ...overrides,
  });
  return key.token;
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "usage-team");
  await db.insert(schema.domains).values({
    teamId,
    name: "acme.dev",
    region: "us-east-1",
    status: "verified",
    verifiedAt: new Date(),
  });
  token = await insertKey();
  sendOnlyToken = await insertKey({ permission: "sending_access" });
  const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
  const enqueueEmailSend = async () => {};
  cloud = createApi({
    db,
    keyring,
    isCloud: true,
    enqueueEmailSend,
    appBaseUrl: "https://app.example.test",
  });
  selfHost = createApi({ db, keyring, isCloud: false, enqueueEmailSend });
});
afterAll(() => close());

describe("GET /usage", () => {
  it("reports the free plan's limits, an empty day and the dashboard origin on Cloud", async () => {
    const res = await get(cloud);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { today: { resets_at: string } };
    expect(body).toEqual({
      object: "usage",
      cloud: true,
      plan: "free",
      limits: { emails_per_day: 100, domains: 3 },
      today: { emails_sent: 0, resets_at: expect.any(String) },
      team: { id: teamId, name: "usage-team" },
      app_url: "https://app.example.test",
    });
    const resetsAt = new Date(body.today.resets_at);
    expect(resetsAt.toISOString().endsWith("T00:00:00.000Z")).toBe(true);
    expect(resetsAt.getTime()).toBeGreaterThan(Date.now());
    expect(resetsAt.getTime() - Date.now()).toBeLessThanOrEqual(86_400_000);
  });

  it("counts an accepted send against today", async () => {
    const sent = await cloud.request("/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ from: "a@acme.dev", to: ["r@example.com"], subject: "s", text: "t" }),
    });
    expect(sent.status).toBe(200);
    const body = (await (await get(cloud)).json()) as { today: { emails_sent: number } };
    expect(body.today.emails_sent).toBe(1);
  });

  it("follows the team's effective plan", async () => {
    await db.update(schema.teams).set({ plan: "pro" }).where(eq(schema.teams.id, teamId));
    expect(await (await get(cloud)).json()).toMatchObject({
      plan: "pro",
      limits: { emails_per_day: 3000, domains: 20 },
    });
    await db.update(schema.teams).set({ plan: "free" }).where(eq(schema.teams.id, teamId));
  });

  it("reports no plan and no limits self-hosted, keeping the counter", async () => {
    expect(await (await get(selfHost)).json()).toMatchObject({
      cloud: false,
      plan: null,
      limits: { emails_per_day: null, domains: null },
      today: { emails_sent: 1 },
      app_url: null,
    });
  });

  it("403s a sending_access key and 401s without one", async () => {
    const res = await get(cloud, sendOnlyToken);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ statusCode: 403, name: "restricted_api_key" });
    expect((await cloud.request("/usage")).status).toBe(401);
  });
});
