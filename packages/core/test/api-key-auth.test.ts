import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authenticateApiKey } from "../src/api-key-auth.js";
import { generateApiKey } from "../src/api-keys.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;
let domainId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "auth-team");
  const [domain] = await db
    .insert(schema.domains)
    .values({ teamId, name: "acme.dev", region: "us-east-1", status: "verified" })
    .returning({ id: schema.domains.id });
  if (!domain) throw new Error("domain insert failed");
  domainId = domain.id;
});
afterAll(() => close());

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

describe("authenticateApiKey scope", () => {
  it("defaults to full_access with no domain restriction", async () => {
    const token = await insertKey();
    const auth = await authenticateApiKey(db, token);
    expect(auth).toMatchObject({ teamId, permission: "full_access", domainId: null });
  });

  it("returns a sending_access key's permission", async () => {
    const token = await insertKey({ permission: "sending_access" });
    const auth = await authenticateApiKey(db, token);
    expect(auth?.permission).toBe("sending_access");
    expect(auth?.domainId).toBeNull();
  });

  it("returns the domain a key is scoped to", async () => {
    const token = await insertKey({ domainId });
    const auth = await authenticateApiKey(db, token);
    expect(auth?.domainId).toBe(domainId);
  });
});

describe("authenticateApiKey billing", () => {
  it("carries the team's billing columns as written, and the effective plan beside them", async () => {
    const token = await insertKey();
    expect((await authenticateApiKey(db, token))?.billing).toEqual({
      plan: "free",
      planQuota: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      overageEnabled: true,
    });
    const currentPeriodStart = new Date("2026-09-01T00:00:00Z");
    const currentPeriodEnd = new Date("2026-10-01T00:00:00Z");
    await db
      .update(schema.teams)
      .set({
        plan: "pro",
        planQuota: 200_000,
        currentPeriodStart,
        currentPeriodEnd,
        overageEnabled: true,
      })
      .where(eq(schema.teams.id, teamId));
    const auth = await authenticateApiKey(db, token);
    expect(auth?.billing).toEqual({
      plan: "pro",
      planQuota: 200_000,
      currentPeriodStart,
      currentPeriodEnd,
      overageEnabled: true,
    });
    expect(auth?.plan).toBe("pro");
  });
});
