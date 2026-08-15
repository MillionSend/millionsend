import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
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
  const key = generateApiKey("live");
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
