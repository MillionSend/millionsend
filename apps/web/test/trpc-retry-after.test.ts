import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withStandardRetryAfter } from "@/server/retry-after";

// The route's headers are what is under test; the context is faked and the
// router holds only procedures that refuse, so no auth or db is needed.
vi.mock("@/server/trpc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/trpc")>();
  return {
    ...actual,
    createContext: async () => ({ db: null as never, session: null, teamId: null, role: null }),
  };
});
vi.mock("@/server/routers", async () => {
  const { publicProcedure, router } = await import("@/server/trpc");
  const { tooManyRequests } = await import("@/server/retry-after");
  return {
    appRouter: router({
      soon: publicProcedure.query(() => {
        throw tooManyRequests(42, "slow down");
      }),
      later: publicProcedure.query(() => {
        throw tooManyRequests(600);
      }),
      fine: publicProcedure.query(() => "ok"),
    }),
  };
});

const { GET } = await import("@/app/api/trpc/[trpc]/route");

const APP = "https://app.example.com";

beforeEach(() => {
  vi.stubEnv("APP_BASE_URL", APP);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/api/trpc retry-after", () => {
  it("sends a refusal's wait as retry-after and in the error's data", async () => {
    const res = await GET(new Request(`${APP}/api/trpc/soon`));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = (await res.json()) as { error: { json: { data: { retryAfterSec?: number } } } };
    expect(body.error.json.data.retryAfterSec).toBe(42);
  });

  it("answers a batch with the longest wait among its refusals", async () => {
    const res = await GET(new Request(`${APP}/api/trpc/soon,later,fine?batch=1&input={}`));
    expect(res.headers.get("retry-after")).toBe("600");
  });

  it("sends none when nothing asked for a wait", async () => {
    const res = await GET(new Request(`${APP}/api/trpc/fine`));
    expect(res.status).toBe(200);
    expect(res.headers.get("retry-after")).toBeNull();
  });
});

describe("withStandardRetryAfter", () => {
  it("copies Better Auth's X-Retry-After onto a 429", () => {
    const res = new Response(null, { status: 429, headers: { "X-Retry-After": "12" } });
    expect(withStandardRetryAfter(res).headers.get("retry-after")).toBe("12");
  });

  it("leaves other answers and a 429's own retry-after alone", () => {
    const ok = new Response(null, { status: 200, headers: { "X-Retry-After": "12" } });
    expect(withStandardRetryAfter(ok).headers.get("retry-after")).toBeNull();
    const own = new Response(null, {
      status: 429,
      headers: { "retry-after": "5", "X-Retry-After": "12" },
    });
    expect(withStandardRetryAfter(own).headers.get("retry-after")).toBe("5");
  });
});
