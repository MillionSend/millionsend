import { randomBytes } from "node:crypto";
import { EnvKeyring, generateApiKey } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/app.js";

const PLATFORM = "MillionSend <onboarding@ms.example>";

let db: Db;
let close: () => Promise<void>;
let teamId: string;
let token: string;

function api(onboardingEmailFrom?: string) {
  return createApi({
    db,
    keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
    isCloud: true,
    onboardingEmailFrom,
    enqueueEmailSend: async () => {},
  });
}

async function send(app: ReturnType<typeof createApi>, to: string[]) {
  return app.request("/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ from: PLATFORM, to, subject: "It works.", text: "hi" }),
  });
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "onboarding-team");
  await db.insert(schema.user).values({ id: "member-1", name: "Ada", email: "ada@example.com" });
  await db.insert(schema.teamMembers).values({ teamId, userId: "member-1", role: "owner" });
  const key = generateApiKey();
  await db.insert(schema.apiKeys).values({
    teamId,
    name: "k",
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
  });
  token = key.token;
});
afterAll(() => close());

describe("POST /emails from the shared onboarding sender", () => {
  it("accepts a send to the team's own member without a verified domain", async () => {
    const res = await send(api(PLATFORM), ["Ada <ADA@example.com>"]);
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    const [row] = await db.select().from(schema.emails).where(eq(schema.emails.id, id));
    expect(row).toMatchObject({ teamId, domainId: null, from: PLATFORM });
  });

  it("rejects a recipient outside the team", async () => {
    const res = await send(api(PLATFORM), ["ada@example.com", "stranger@example.com"]);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ name: "validation_error" });
  });

  it("is an ordinary unverified sender when the instance configures none", async () => {
    const res = await send(api(), ["ada@example.com"]);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { message: string }).message).toContain("not verified");
  });
});
