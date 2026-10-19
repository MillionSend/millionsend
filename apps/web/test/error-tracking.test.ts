import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  captureError: vi.fn(async () => {}),
  sdk: { start: vi.fn(), captureException: vi.fn() },
  contextError: undefined as Error | undefined,
  queryError: undefined as Error | undefined,
}));

vi.mock("@millionsend/core/error-tracking-node", () => ({
  captureError: h.captureError,
  initErrorTracking: vi.fn(async () => {}),
}));
vi.mock("@/lib/client-errors-sdk", () => h.sdk);
vi.mock("@/server/trpc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/trpc")>();
  return {
    ...actual,
    createContext: async () => {
      if (h.contextError) throw h.contextError;
      const { queryError } = h;
      if (!queryError) return { db: null as never, session: null, teamId: null, role: null };
      // A signed-in owner whose every query fails with queryError.
      return {
        db: {
          select: () => {
            throw queryError;
          },
        } as never,
        session: { user: { id: "user-1", email: "owner@example.com", name: "Owner" } },
        teamId: "team-1",
        role: "owner" as const,
      };
    },
  };
});
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("next-intl/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next-intl/server")>()),
  getLocale: async () => "en",
  getTranslations: async () => (key: string) => key,
}));

const { onRequestError } = await import("@/instrumentation");
const { GET: trpcGet } = await import("@/app/api/trpc/[trpc]/route");
const { POST: tunnel } = await import("@/app/api/client-errors/route");
const { default: RootLayout } = await import("@/app/layout");
const { ErrorTracking } = await import("@/components/error-tracking");
const { reportClientError, startClientErrorTracking } = await import("@/lib/client-errors");
const { FAULT_MESSAGE } = await import("@/server/trpc");
const { unstorableValueMessage } = await import("@millionsend/core");

const DSN = "https://public@errors.example.com/7";

beforeEach(() => {
  h.captureError.mockClear();
  h.contextError = undefined;
  h.queryError = undefined;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("server errors", () => {
  it("reports a request error under its route pattern, never the path, headers or cookies", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    const error = Object.assign(new Error("render failed"), { digest: "1234567" });
    await onRequestError(
      error,
      { path: "/invite/abc.def?next=/x", method: "GET", headers: { cookie: "session=s" } },
      {
        routerKind: "App Router",
        routePath: "/invite/[token]",
        routeType: "render",
        renderSource: "react-server-components",
        revalidateReason: undefined,
      },
    );
    expect(h.captureError).toHaveBeenCalledExactlyOnceWith(error, {
      tags: { route: "/invite/[token]", route_type: "render", digest: "1234567" },
    });
  });

  it("reports a tRPC fault with its procedure and team, but no answer a procedure chose", async () => {
    vi.stubEnv("APP_BASE_URL", "https://app.example.com");
    const call = () => trpcGet(new Request("https://app.example.com/api/trpc/apiKeys.list"));
    expect((await call()).status).toBe(401);
    expect(h.captureError).not.toHaveBeenCalled();

    vi.spyOn(console, "error").mockImplementation(() => {});
    h.contextError = new Error("connection refused");
    expect((await call()).status).toBe(500);
    expect(h.captureError).toHaveBeenCalledExactlyOnceWith(h.contextError, {
      teamId: undefined,
      tags: { procedure: "apiKeys.list" },
    });
  });

  it("answers a procedure's fault in general words, logging and reporting the error itself", async () => {
    vi.stubEnv("APP_BASE_URL", "https://app.example.com");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    h.queryError = new Error('Failed query: select "secret" from "keys" where "team_id" = $1');
    const res = await trpcGet(new Request("https://app.example.com/api/trpc/apiKeys.list"));
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toContain("Failed query");
    expect(body).not.toContain("secret");
    expect(JSON.parse(body)).toMatchObject({
      error: { json: { message: FAULT_MESSAGE, data: { code: "INTERNAL_SERVER_ERROR" } } },
    });
    expect(h.captureError).toHaveBeenCalledExactlyOnceWith(h.queryError, {
      teamId: "team-1",
      tags: { procedure: "apiKeys.list" },
    });
    expect(log.mock.calls.flat()).toContain(h.queryError);
  });

  it("passes a refusal's own message on, unreported", async () => {
    vi.stubEnv("APP_BASE_URL", "https://app.example.com");
    h.queryError = Object.assign(new Error("invalid byte sequence"), { code: "22021" });
    const res = await trpcGet(new Request("https://app.example.com/api/trpc/apiKeys.list"));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: {
        json: { message: unstorableValueMessage(h.queryError), data: { code: "BAD_REQUEST" } },
      },
    });
    expect(h.captureError).not.toHaveBeenCalled();
  });
});

describe("the browser", () => {
  const trackerIn = async (): Promise<ReactElement | undefined> => {
    const html = (await RootLayout({ children: null })) as ReactElement<{ children: ReactNode }>;
    const body = html.props.children as ReactElement<{ children: ReactNode[] }>;
    return body.props.children.find(
      (child): child is ReactElement => isValidElement(child) && child.type === ErrorTracking,
    );
  };

  it("gets no tracker, and so no SDK, without SENTRY_BROWSER_DSN", async () => {
    vi.stubEnv("SENTRY_DSN", DSN);
    vi.stubEnv("SENTRY_BROWSER_DSN", "");
    expect(await trackerIn()).toBeUndefined();
  });

  it("gets its DSN and the image's revision at runtime from the root layout", async () => {
    vi.stubEnv("SENTRY_BROWSER_DSN", DSN);
    vi.stubEnv("MILLIONSEND_REVISION", "c8ce832");
    expect((await trackerIn())?.props).toEqual({
      config: { dsn: DSN, environment: "production", release: "c8ce832", tracesSampleRate: 0 },
    });
  });

  it("loads the SDK on start only, and hands it what an error boundary caught", async () => {
    const error = new Error("render failed");
    reportClientError(error);
    expect(h.sdk.start).not.toHaveBeenCalled();
    const config = { dsn: DSN, environment: "production", release: undefined, tracesSampleRate: 0 };
    startClientErrorTracking(config);
    reportClientError(error);
    await vi.waitFor(() => expect(h.sdk.captureException).toHaveBeenCalledWith(error));
    expect(h.sdk.start).toHaveBeenCalledExactlyOnceWith(config);
  });
});

describe("the browser's tunnel", () => {
  const envelope = `${JSON.stringify({ dsn: "https://other@evil.example.com/1" })}\n{"type":"event"}\n{}`;
  const post = (body: string, headers: Record<string, string> = {}) =>
    tunnel(
      new Request("https://app.example.com/api/client-errors", {
        method: "POST",
        body,
        headers: {
          "content-length": String(Buffer.byteLength(body)),
          cookie: "session=s",
          "x-forwarded-for": "203.0.113.9",
          ...headers,
        },
      }),
    );

  it("is not there without SENTRY_BROWSER_DSN", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    vi.stubEnv("SENTRY_BROWSER_DSN", "");
    expect((await post(envelope)).status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("forwards only the body, to the configured project, and passes its back-off on", async () => {
    vi.stubEnv("SENTRY_BROWSER_DSN", DSN);
    const upstream = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response('{"id":"x"}', {
          status: 429,
          headers: { "x-sentry-rate-limits": "60::key", "set-cookie": "a=b" },
        }),
    );
    vi.stubGlobal("fetch", upstream);
    const res = await post(envelope);
    expect(res.status).toBe(429);
    expect(res.headers.get("x-sentry-rate-limits")).toBe("60::key");
    expect(res.headers.get("set-cookie")).toBeNull();
    const [url, init] = upstream.mock.calls[0] ?? [];
    expect(url).toBe(
      "https://errors.example.com/api/7/envelope/?sentry_version=7&sentry_key=public",
    );
    expect(init?.headers).toEqual({ "content-type": "application/x-sentry-envelope" });
    expect(new TextDecoder().decode(init?.body as ArrayBuffer)).toBe(envelope);
  });

  it("refuses an envelope past the size cap or of unknown size, and survives the tracker being down", async () => {
    vi.stubEnv("SENTRY_BROWSER_DSN", DSN);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    expect((await post(envelope, { "content-length": String(2 * 1024 * 1024) })).status).toBe(413);
    expect((await post(envelope, { "content-length": "" })).status).toBe(413);
    expect((await post(envelope)).status).toBe(502);
  });
});
