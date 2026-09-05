import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  AuthError,
  createHttp,
  cursorGuard,
  PaginationError,
  retryAfterMs,
} from "../src/http.js";
import { createLogger } from "../src/log.js";

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function logTo(lines: string[]) {
  return createLogger({
    level: "debug",
    stream: {
      write: (chunk: string) => {
        lines.push(String(chunk).trimEnd());
        return true;
      },
    } as never,
  });
}

function http(fetchMock: ReturnType<typeof vi.fn>, lines: string[] = [], extra = {}) {
  return createHttp({
    baseUrl: "https://api.resend.com/",
    token: "re_secret_123456789",
    userAgent: "millionsend-cli/test",
    rps: 1000,
    name: "Resend",
    log: logTo(lines),
    fetch: fetchMock as unknown as typeof fetch,
    ...extra,
  });
}

describe("createHttp", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends auth + UA headers, serializes the query, returns status and parsed body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { data: [1] }));
    const lines: string[] = [];
    const pending = http(fetchMock, lines).get<{ data: number[] }>("/contacts", {
      query: { limit: 100, after: undefined, segment_id: "s1" },
    });
    await vi.runAllTimersAsync();
    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: [1] });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://api.resend.com/contacts?limit=100&segment_id=s1");
    expect(init.headers).toMatchObject({
      authorization: "Bearer re_secret_123456789",
      "user-agent": "millionsend-cli/test",
    });
    expect(lines).toEqual([
      expect.stringMatching(/^GET \/contacts\?limit=100&segment_id=s1 → 200 \(\d+ ms\)$/),
    ]);
  });

  it("posts a JSON body with extra headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(201, { id: "x" }));
    const pending = http(fetchMock).post("/contacts/batch", [{ email: "a@b.c" }], {
      headers: { "x-batch-validation": "permissive" },
    });
    await vi.runAllTimersAsync();
    expect((await pending).status).toBe(201);
    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(init.method).toBe("POST");
    expect(init.body).toBe('[{"email":"a@b.c"}]');
    expect(init.headers).toMatchObject({
      "content-type": "application/json",
      "x-batch-validation": "permissive",
    });
  });

  it("401 is an AuthError naming the side, with no retry", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(401, { message: "nope" }));
    const pending = http(fetchMock).get("/domains");
    pending.catch(() => {});
    await vi.runAllTimersAsync();
    await expect(pending).rejects.toThrow(AuthError);
    await expect(pending).rejects.toThrow("Resend rejected the API key (401)");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("403 plan_limit_reached is an ApiError, not an auth stop", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        json(403, { name: "plan_limit_reached", message: "Your plan allows up to 3 domains" }),
      );
    const pending = http(fetchMock).post("/domains", {});
    pending.catch(() => {});
    await vi.runAllTimersAsync();
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).not.toBeInstanceOf(AuthError);
    expect(error).toMatchObject({ status: 403, name: "plan_limit_reached" });
  });

  it("422 is an ApiError with the body's name and message, no retry", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(json(422, { name: "validation_error", message: "email is invalid" }));
    const pending = http(fetchMock).post("/contacts", {});
    pending.catch(() => {});
    await vi.runAllTimersAsync();
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 422, name: "validation_error" });
    expect((error as Error).message).toContain("email is invalid");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("429 waits retry-after seconds and logs the retry", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(429, {}, { "retry-after": "3" }))
      .mockResolvedValueOnce(json(200, { ok: true }));
    const lines: string[] = [];
    const pending = http(fetchMock, lines).get("/emails");
    await vi.advanceTimersByTimeAsync(10);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2900);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await pending).body).toEqual({ ok: true });
    expect(lines.some((l) => l.startsWith("warning: retry 2/8 in 3s — Resend 429"))).toBe(true);
  });

  it("429 gives up after rateLimitAttempts", async () => {
    const fetchMock = vi.fn().mockImplementation(() => json(429, {}, { "ratelimit-reset": "1" }));
    const pending = http(fetchMock, [], { rateLimitAttempts: 3 }).get("/emails");
    pending.catch(() => {});
    await vi.runAllTimersAsync();
    await expect(pending).rejects.toMatchObject({ status: 429, name: "rate_limit_exceeded" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("5xx backs off 1s, 2s, 4s, 8s and then throws", async () => {
    const fetchMock = vi.fn().mockImplementation(() => json(503, { message: "down" }));
    const lines: string[] = [];
    const pending = http(fetchMock, lines).get("/domains");
    pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(10);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(4000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(8000);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    await vi.runAllTimersAsync();
    await expect(pending).rejects.toMatchObject({ status: 503, name: "server_error" });
    expect(lines.filter((l) => l.startsWith("warning: retry"))).toEqual([
      "warning: retry 2/5 in 1s — Resend 503",
      "warning: retry 3/5 in 2s — Resend 503",
      "warning: retry 4/5 in 4s — Resend 503",
      "warning: retry 5/5 in 8s — Resend 503",
    ]);
  });

  it("network failures retry like 5xx and succeed when the network comes back", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(json(200, { data: [] }));
    const lines: string[] = [];
    const pending = http(fetchMock, lines).get("/domains");
    await vi.runAllTimersAsync();
    expect((await pending).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(lines).toContain("warning: retry 2/5 in 1s — Resend fetch failed");
  });

  it("network failures name the cause and the side's next step", async () => {
    const refused = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:3000"), {
        code: "ECONNREFUSED",
        address: "10.0.0.5",
        port: 3000,
      }),
    });
    const fetchMock = vi.fn().mockRejectedValue(refused);
    const lines: string[] = [];
    const pending = http(fetchMock, lines, { maxAttempts: 2 }).get("/domains");
    pending.catch(() => {});
    await vi.runAllTimersAsync();
    await expect(pending).rejects.toThrow(
      "Resend: GET /domains failed 2 times — fetch failed (ECONNREFUSED 10.0.0.5:3000); check your network to api.resend.com",
    );
    expect(lines).toContain(
      "warning: retry 2/2 in 1s — Resend fetch failed (ECONNREFUSED 10.0.0.5:3000)",
    );

    const target = http(fetchMock, [], {
      maxAttempts: 1,
      name: "MillionSend",
      baseUrl: "https://mail.example.com",
    }).get("/usage");
    target.catch(() => {});
    await vi.runAllTimersAsync();
    await expect(target).rejects.toThrow(
      "MillionSend: GET /usage failed 1 times — fetch failed (ECONNREFUSED 10.0.0.5:3000); check --to-url / MILLIONSEND_BASE_URL",
    );
  });

  it("readOnly refuses every non-GET before touching the network", async () => {
    const fetchMock = vi.fn();
    const client = http(fetchMock, [], { readOnly: true });
    await expect(client.post("/contacts", {})).rejects.toThrow("Resend is read-only");
    await expect(client.patch("/contacts/1", {})).rejects.toThrow("Resend is read-only");
    await expect(client.delete("/contacts/1")).rejects.toThrow("Resend is read-only");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("paces requests at rps", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(json(200, {})));
    const client = http(fetchMock, [], { rps: 2 });
    const all = Promise.all([client.get("/a"), client.get("/b"), client.get("/c")]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await all;
  });

  it("exposes the team limit header and holds the next request while the window is nearly spent", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json(
          200,
          {},
          { "ratelimit-limit": "10", "ratelimit-remaining": "2", "ratelimit-reset": "2" },
        ),
      )
      .mockResolvedValue(json(200, {}));
    const client = http(fetchMock);
    expect(client.rateLimit).toBeNull();
    await client.get("/a");
    expect(client.rateLimit).toBe(10);
    const second = client.get("/b");
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await second;
  });

  it("halves the pace after a 429 and says so", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(429, { name: "rate_limit_exceeded" }, { "retry-after": "1" }))
      .mockResolvedValue(json(200, {}));
    const lines: string[] = [];
    const pending = http(fetchMock, lines, { rps: 8 }).get("/a");
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(lines.some((l) => l.includes("slowing to 4 req/s"))).toBe(true);
  });

  it("setRps re-paces the client", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(json(200, {})));
    const client = http(fetchMock);
    client.setRps(2);
    const all = Promise.all([client.get("/a"), client.get("/b")]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await all;
  });

  it("never logs the token", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("bad Bearer re_secret_123456789"));
    const lines: string[] = [];
    const pending = http(fetchMock, lines, { maxAttempts: 2 }).get("/x");
    pending.catch(() => {});
    await vi.runAllTimersAsync();
    await expect(pending).rejects.toThrow();
    expect(lines.join("\n")).not.toContain("re_secret");
  });
});

describe("retryAfterMs", () => {
  it("reads seconds, an HTTP date, or ratelimit-reset", () => {
    const now = Date.parse("2026-09-01T00:00:00Z");
    expect(retryAfterMs(new Headers({ "retry-after": "2" }))).toBe(2000);
    expect(retryAfterMs(new Headers({ "retry-after": "Tue, 01 Sep 2026 00:00:05 GMT" }), now)).toBe(
      5000,
    );
    expect(retryAfterMs(new Headers({ "ratelimit-reset": "1" }))).toBe(1000);
    expect(retryAfterMs(new Headers())).toBeNull();
    expect(retryAfterMs(new Headers({ "retry-after": "9999" }))).toBe(120_000);
  });
});

describe("cursorGuard", () => {
  const rows = (...ids: string[]) => ids.map((id) => ({ id }));

  it("lets a moving walk through", () => {
    const guard = cursorGuard("/contacts");
    guard(rows("a", "b"), undefined);
    guard(rows("c", "d"), "b");
    guard([], "d");
  });

  it("throws when the page ends at the cursor it was asked to start after", () => {
    const guard = cursorGuard("/contacts");
    guard(rows("a", "b"), undefined);
    expect(() => guard(rows("a", "b"), "b")).toThrow(PaginationError);
    expect(() => guard(rows("a", "b"), "b")).toThrow("/contacts");
  });

  it("throws when a page brings only ids already listed", () => {
    const guard = cursorGuard("/segments/s1/contacts");
    guard(rows("a", "b"), undefined);
    expect(() => guard(rows("b", "a"), "x")).toThrow("already listed");
  });

  it("caps the number of pages instead of walking forever", () => {
    const guard = cursorGuard("/emails", 2);
    guard(rows("a"), undefined);
    guard(rows("b"), "a");
    expect(() => guard(rows("c"), "b")).toThrow("more than 2 pages");
  });
});
