import { randomBytes, randomUUID } from "node:crypto";
import * as core from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../src/app.js";

/**
 * The /inboxes routes that run the receiving pipeline's functions: release
 * from quarantine and the latest verification code. Those functions are
 * faked here; their own tests cover what they do.
 */

vi.mock("@millionsend/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@millionsend/core")>();
  return {
    ...actual,
    releaseQuarantined: vi.fn(),
    latestVerificationCode: vi.fn(),
    acquireWaitSlot: vi.fn(),
    waitForReceived: vi.fn(),
  };
});

const released = vi.mocked(core.releaseQuarantined);
const latest = vi.mocked(core.latestVerificationCode);
const slot = vi.mocked(core.acquireWaitSlot);
const wait = vi.mocked(core.waitForReceived);

let db: Db;
let close: () => Promise<void>;
let app: ReturnType<typeof createApi>;
let teamId: string;
let teamKey: string;
let inboxKey: string;
let inboxId: string;

const NONE: core.VerificationCodeWire = {
  object: "verification_code",
  status: "none",
  kind: null,
  code: null,
  url: null,
  link_domain_matches_sender: null,
  email_id: null,
  from: null,
  received_at: null,
  sender_trust: null,
};

async function key(extra: Partial<typeof schema.apiKeys.$inferInsert> = {}) {
  const k = core.generateApiKey();
  await db.insert(schema.apiKeys).values({
    teamId,
    name: "test",
    tokenPrefix: k.tokenPrefix,
    keyHash: k.keyHash,
    last4: k.last4,
    ...extra,
  });
  return k.token;
}

const call = (token: string, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "held-routes");
  const [domain] = await db
    .insert(schema.domains)
    .values({ teamId, name: "held.test", region: "us-east-1", status: "verified" })
    .returning({ id: schema.domains.id });
  const [inbox] = await db
    .insert(schema.inboxes)
    .values({
      teamId,
      kind: "agent",
      emailAddress: "bot@held.test",
      localPart: "bot",
      domainId: domain?.id as string,
      name: "bot",
      safety: core.defaultSafety("agent", false),
    })
    .returning({ id: schema.inboxes.id });
  inboxId = inbox?.id as string;
  teamKey = await key();
  inboxKey = await key({ inboxId });
  app = createApi({
    db,
    keyring: core.EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
    isCloud: true,
    enqueueEmailSend: async () => {},
    receiving: { mxHost: "mx.millionsend.test", ingestSecret: "s".repeat(40) },
  });
});
afterAll(() => close());
beforeEach(() => vi.clearAllMocks());

describe("POST /inboxes/{id}/quarantine/{email_id}/release", () => {
  it("releases for a team key and answers the release object", async () => {
    const emailId = randomUUID();
    const at = new Date("2026-10-12T10:00:00Z");
    released.mockResolvedValue({ ok: true, releasedAt: at, trustedSender: "ana@sender.test" });
    const res = await call(teamKey, "POST", `/inboxes/${inboxId}/quarantine/${emailId}/release`, {
      trust_sender: true,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      object: "inbox_release",
      inbox_id: inboxId,
      email_id: emailId,
      released_at: at.toISOString(),
      trusted_sender: "ana@sender.test",
    });
    expect(released).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        teamId,
        receivedEmailId: emailId,
        inboxId,
        trustSender: true,
        actor: expect.objectContaining({ kind: "api_key", inboxId: null }),
      }),
    );
  });

  it("takes no body, maps refusals, and never reaches the function for an inbox key", async () => {
    released.mockResolvedValue({ ok: false, reason: "not_quarantined" });
    const bare = await app.request(`/inboxes/${inboxId}/quarantine/${randomUUID()}/release`, {
      method: "POST",
      headers: { authorization: `Bearer ${teamKey}` },
    });
    expect(bare.status).toBe(404);
    expect(released).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ trustSender: false }),
    );
    released.mockResolvedValue({ ok: false, reason: "allowlist_full" });
    const full = await call(
      teamKey,
      "POST",
      `/inboxes/${inboxId}/quarantine/${randomUUID()}/release`,
      {
        trust_sender: true,
      },
    );
    expect(full.status).toBe(422);
    released.mockClear();
    const agent = await call(
      inboxKey,
      "POST",
      `/inboxes/${inboxId}/quarantine/${randomUUID()}/release`,
      {},
    );
    expect(agent.status).toBe(403);
    const other = await call(
      teamKey,
      "POST",
      `/inboxes/${randomUUID()}/quarantine/${randomUUID()}/release`,
      {},
    );
    expect(other.status).toBe(404);
    expect(released).not.toHaveBeenCalled();
  });
});

describe("GET /inboxes/{id}/codes/latest", () => {
  it("answers the latest code at once, for the inbox's own key too", async () => {
    const found: core.VerificationCodeWire = {
      ...NONE,
      status: "found",
      kind: "otp",
      code: "482913",
      email_id: randomUUID(),
      from: "hello@acme.test",
      received_at: new Date().toISOString(),
      sender_trust: "external",
    };
    latest.mockResolvedValue(found);
    const res = await call(
      inboxKey,
      "GET",
      `/inboxes/${inboxId}/codes/latest?from=acme.test&max_age=120`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(found);
    expect(latest).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ teamId, inboxId, from: "acme.test", maxAgeMs: 120_000 }),
    );
    expect(slot).not.toHaveBeenCalled();
    for (const query of ["wait=51", "max_age=59", "wait=x"]) {
      expect(
        (await call(teamKey, "GET", `/inboxes/${inboxId}/codes/latest?${query}`)).status,
        query,
      ).toBe(422);
    }
  });

  it("long-polls in a wait slot, answering timeout when nothing came, 429 without a slot", async () => {
    const release = vi.fn();
    slot.mockReturnValue(release);
    wait.mockResolvedValue([]);
    latest.mockResolvedValue(NONE);
    const res = await call(teamKey, "GET", `/inboxes/${inboxId}/codes/latest?wait=5`);
    expect(await res.json()).toEqual({ ...NONE, status: "timeout" });
    expect(release).toHaveBeenCalledTimes(1);
    const [args] = wait.mock.calls[0] ?? [];
    expect(args?.deadlineMs).toBeGreaterThan(Date.now() + 3_000);
    expect(await args?.poll()).toEqual([]);

    slot.mockReturnValue(null);
    const busy = await call(teamKey, "GET", `/inboxes/${inboxId}/codes/latest?wait=5`);
    expect(busy.status).toBe(429);
    expect(busy.headers.get("retry-after")).toBe("1");
    expect(await busy.json()).toMatchObject({ name: "too_many_waits" });
  });
});
