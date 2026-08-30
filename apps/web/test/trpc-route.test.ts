import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The handler's cross-origin and cache-control behaviour is what is under
// test; the context is faked so no auth/db is needed.
vi.mock("@/server/trpc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/trpc")>();
  return {
    ...actual,
    createContext: async () => ({ db: null as never, session: null, teamId: null, role: null }),
  };
});

const { GET, POST } = await import("@/app/api/trpc/[trpc]/route");

const APP = "https://app.example.com";

beforeEach(() => {
  vi.stubEnv("APP_BASE_URL", APP);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function post(headers: Record<string, string>) {
  return POST(
    new Request(`${APP}/api/trpc/apiKeys.revoke`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ json: { id: "x" } }),
    }),
  );
}

describe("/api/trpc", () => {
  it("marks every response private and uncacheable", async () => {
    const res = await GET(new Request(`${APP}/api/trpc/apiKeys.list`));
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("rejects cross-origin mutations before resolving anything", async () => {
    expect((await post({ origin: "https://evil.example" })).status).toBe(403);
    expect((await post({ "sec-fetch-site": "cross-site" })).status).toBe(403);
    // Same-origin reaches the router (and fails auth there, not CSRF).
    expect((await post({ origin: APP, "sec-fetch-site": "same-origin" })).status).toBe(401);
    expect((await post({})).status).toBe(401);
  });
});
