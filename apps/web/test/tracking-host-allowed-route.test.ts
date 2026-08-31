import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ db: undefined as unknown as Db, secret: "s3cr3t-ask-token" }));

vi.mock("@millionsend/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@millionsend/db")>();
  return { ...actual, getDb: () => h.db };
});

vi.mock("@millionsend/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@millionsend/config")>();
  return { ...actual, env: { ...actual.env, TRACKING_ASK_SECRET: h.secret } };
});

const { GET } = await import("@/app/internal/tracking-host-allowed/route");

const ask = (params: Record<string, string>) =>
  GET(
    new Request(
      `https://app.example.com/internal/tracking-host-allowed?${new URLSearchParams(params)}`,
    ),
  );

let close: () => Promise<void>;

beforeAll(async () => {
  ({ db: h.db, close } = await createTestDb());
  const teamId = await createTeam(h.db, "tracking-ask");
  await h.db.insert(schema.domains).values({
    teamId,
    name: "dinzo.com.br",
    region: "sa-east-1",
    status: "verified",
    trackingSubdomain: "links",
  });
});
afterAll(() => close());

describe("GET /internal/tracking-host-allowed", () => {
  it("authorizes a configured tracking host with the right secret", async () => {
    const res = await ask({ token: h.secret, domain: "links.dinzo.com.br" });
    expect(res.status).toBe(200);
  });

  it("is case-insensitive on the host", async () => {
    expect((await ask({ token: h.secret, domain: "LINKS.DINZO.COM.BR" })).status).toBe(200);
  });

  it("denies a hostname no team has configured", async () => {
    expect((await ask({ token: h.secret, domain: "links.evil.com" })).status).toBe(404);
  });

  it("denies a wrong or missing secret before touching the db", async () => {
    expect((await ask({ token: "wrong", domain: "links.dinzo.com.br" })).status).toBe(403);
    expect((await ask({ domain: "links.dinzo.com.br" })).status).toBe(403);
  });
});
