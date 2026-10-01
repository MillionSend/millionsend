import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureError, initErrorTracking } from "../src/error-tracking-node.js";

const sdk = vi.hoisted(() => ({ loaded: false, init: vi.fn(), captureException: vi.fn() }));

// The factory runs only when the module under test imports the SDK.
vi.mock("@sentry/node", () => {
  sdk.loaded = true;
  const integration = (name: string) => (options?: object) => ({ name, options });
  return {
    init: sdk.init,
    captureException: sdk.captureException,
    dedupeIntegration: integration("Dedupe"),
    linkedErrorsIntegration: integration("LinkedErrors"),
    contextLinesIntegration: integration("ContextLines"),
    nodeContextIntegration: integration("Context"),
    onUncaughtExceptionIntegration: integration("OnUncaughtException"),
    onUnhandledRejectionIntegration: integration("OnUnhandledRejection"),
    httpIntegration: integration("Http"),
  };
});

const config = {
  dsn: "https://public@errors.example.com/7",
  environment: "production",
  release: "c8ce832",
  tracesSampleRate: 0,
};

beforeEach(() => {
  sdk.loaded = false;
  sdk.init.mockClear();
  sdk.captureException.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("without a DSN", () => {
  it("never loads the SDK, to start it or to report", async () => {
    vi.stubEnv("SENTRY_DSN", "");
    await initErrorTracking("api");
    await captureError(new Error("boom"), { teamId: "t1" });
    expect(sdk.loaded).toBe(false);
    expect(sdk.init).not.toHaveBeenCalled();
    expect(sdk.captureException).not.toHaveBeenCalled();
  });
});

describe("with a DSN", () => {
  type Integration = { name: string; options?: object };
  const integrations = () =>
    (sdk.init.mock.lastCall?.[0] as { integrations: Integration[] } | undefined)?.integrations ??
    [];

  it("starts errors-only, scrubbed, tagged with the process", async () => {
    await initErrorTracking("worker", config);
    expect(sdk.init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: config.dsn,
        release: "c8ce832",
        defaultIntegrations: false,
        sendClientReports: false,
        initialScope: { tags: { process: "worker" } },
      }),
    );
    expect(integrations().map((i) => i.name)).not.toContain("Http");
    expect(integrations().find((i) => i.name === "OnUnhandledRejection")?.options).toEqual({
      mode: "strict",
    });
  });

  it("leaves Next.js serving after an unhandled rejection, and traces only with a rate", async () => {
    await initErrorTracking("web", { ...config, tracesSampleRate: 0.1 });
    expect(integrations().find((i) => i.name === "OnUnhandledRejection")?.options).toEqual({
      mode: "none",
    });
    expect(integrations().find((i) => i.name === "Http")?.options).toEqual({
      sessions: false,
      breadcrumbs: false,
    });
  });

  it("reports a handled error with the team and the caller's tags", async () => {
    vi.stubEnv("SENTRY_DSN", config.dsn);
    const error = new Error("boom");
    await captureError(error, { teamId: "t1", tags: { job: "email.send" } });
    await captureError(error, { teamId: null });
    expect(sdk.captureException).toHaveBeenNthCalledWith(1, error, {
      tags: { job: "email.send", team_id: "t1" },
    });
    expect(sdk.captureException).toHaveBeenNthCalledWith(2, error, { tags: {} });
  });
});
