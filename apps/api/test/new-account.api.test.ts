import { randomBytes } from "node:crypto";
import { EnvKeyring, generateApiKey } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createApi } from "../src/app.js";

let db: Db;
let close: () => Promise<void>;
let app: ReturnType<typeof createApi>;

const NOW = new Date("2026-03-02T12:00:00Z");

async function newSender(slug: string): Promise<string> {
  const teamId = await createTeam(db, slug);
  await db
    .update(schema.teams)
    .set({ plan: "pro", planQuota: 100_000 })
    .where(eq(schema.teams.id, teamId));
  await db.insert(schema.domains).values({
    teamId,
    name: `${slug}.example`,
    region: "us-east-1",
    status: "verified",
    verifiedAt: NOW,
    warmupTrustedAt: NOW,
  });
  const key = generateApiKey();
  await db.insert(schema.apiKeys).values({
    teamId,
    name: "t",
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
  });
  return key.token;
}

const post = (token: string, path: string, payload: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

const email = (slug: string, to: string) => ({
  from: `Acme <hello@${slug}.example>`,
  to: [to],
  subject: "s",
  text: "t",
});

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await db.insert(schema.instanceSettings).values({ id: 1, newAccountFirstDay: 2 });
  app = createApi({
    db,
    keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
    isCloud: true,
    enqueueEmailSend: async () => {},
    enqueueBroadcastSend: async () => {},
    appBaseUrl: "https://app.example.test",
  });
});
afterAll(() => close());
beforeEach(() => {
  vi.stubEnv("IS_CLOUD", "true");
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it("a new team's batch sends what fits its first day and parks the rest, read back as the new-account limit", async () => {
  const token = await newSender("batch-new");
  const res = await post(
    token,
    "/emails/batch",
    [1, 2, 3].map((i) => email("batch-new", `r${i}@example.com`)),
  );
  expect(res.status).toBe(200);
  const { data } = (await res.json()) as { data: { id: string }[] };
  const ids = data.map((d) => d.id);
  const rows = await db
    .select({
      id: schema.emails.id,
      status: schema.emails.latestStatus,
      reason: schema.emails.parkReason,
    })
    .from(schema.emails)
    .where(inArray(schema.emails.id, ids));
  expect(ids.map((id) => rows.find((r) => r.id === id))).toMatchObject([
    { status: "queued", reason: null },
    { status: "queued", reason: null },
    { status: "queued_quota", reason: "new_account" },
  ]);
  const read = await app.request(`/emails/${ids[2]}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(await read.json()).toMatchObject({
    last_event: "queued",
    queued_reason: "new_account_limit",
    sends_after: "2026-03-03T12:00:00.000Z",
  });

  // A single send is accepted and waits too, never refused.
  const single = await post(token, "/emails", email("batch-new", "r4@example.com"));
  expect(single.status).toBe(200);
  const { id } = (await single.json()) as { id: string };
  const [parked] = await db
    .select({ reason: schema.emails.parkReason })
    .from(schema.emails)
    .where(eq(schema.emails.id, id));
  expect(parked?.reason).toBe("new_account");
  const readSingle = await app.request(`/emails/${id}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(await readSingle.json()).toMatchObject({ queued_reason: "new_account_limit" });
});
