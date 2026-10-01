import { afterEach, describe, expect, it, vi } from "vitest";
import { type Env, errorTrackingConfig } from "../src/env.js";

function fakeEnv(overrides: Record<string, string | number>): Env {
  return { MILLIONSEND_REVISION: "unknown", ...overrides } as unknown as Env;
}

const DSN = "https://public@errors.example.com/7";

describe("errorTrackingConfig", () => {
  it("is off on both sides without a DSN", () => {
    expect(errorTrackingConfig("server", fakeEnv({}))).toBeNull();
    expect(errorTrackingConfig("browser", fakeEnv({}))).toBeNull();
    expect(errorTrackingConfig("browser", fakeEnv({ SENTRY_DSN: DSN }))).toBeNull();
  });

  it("reads each side's own DSN, errors only by default", () => {
    expect(errorTrackingConfig("server", fakeEnv({ SENTRY_DSN: DSN }))).toEqual({
      dsn: DSN,
      environment: "production",
      release: undefined,
      tracesSampleRate: 0,
    });
    expect(
      errorTrackingConfig("browser", fakeEnv({ SENTRY_DSN: DSN, SENTRY_BROWSER_DSN: `${DSN}8` })),
    ).toMatchObject({ dsn: `${DSN}8` });
  });

  it("names the image's revision as the release and keeps the operator's environment", () => {
    expect(
      errorTrackingConfig(
        "server",
        fakeEnv({
          SENTRY_DSN: DSN,
          MILLIONSEND_REVISION: "c8ce832",
          SENTRY_ENVIRONMENT: "staging",
        }),
      ),
    ).toMatchObject({ release: "c8ce832", environment: "staging" });
  });

  it("reads the trace rate raw or validated, anything else as 0", () => {
    const rate = (value: string | number) =>
      errorTrackingConfig("server", fakeEnv({ SENTRY_DSN: DSN, SENTRY_TRACES_SAMPLE_RATE: value }))
        ?.tracesSampleRate;
    expect(rate("0.25")).toBe(0.25);
    expect(rate(0.5)).toBe(0.5);
    expect(rate("abc")).toBe(0);
    expect(rate("-1")).toBe(0);
  });
});

describe("the SENTRY_* schema", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function parse(vars: Record<string, string>) {
    vi.resetModules();
    vi.stubEnv("SKIP_ENV_VALIDATION", "0");
    vi.stubEnv("DATABASE_URL", "postgres://localhost:5432/millionsend");
    vi.stubEnv("MASTER_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
    for (const name of [
      "SENTRY_DSN",
      "SENTRY_BROWSER_DSN",
      "SENTRY_ENVIRONMENT",
      "SENTRY_TRACES_SAMPLE_RATE",
    ]) {
      vi.stubEnv(name, vars[name] ?? "");
    }
    return (await import("../src/env.js")).env;
  }

  it("defaults to production and no tracing, and coerces the rate", async () => {
    const env = await parse({ SENTRY_DSN: DSN, SENTRY_TRACES_SAMPLE_RATE: "0.1" });
    expect(env.SENTRY_DSN).toBe(DSN);
    expect(env.SENTRY_BROWSER_DSN).toBeUndefined();
    expect(env.SENTRY_ENVIRONMENT).toBe("production");
    expect(env.SENTRY_TRACES_SAMPLE_RATE).toBe(0.1);
    expect((await parse({})).SENTRY_TRACES_SAMPLE_RATE).toBe(0);
  });

  it("refuses a DSN that is not a URL and a rate outside 0..1", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(parse({ SENTRY_DSN: "errors.example.com/7" })).rejects.toThrow();
    await expect(parse({ SENTRY_TRACES_SAMPLE_RATE: "2" })).rejects.toThrow();
  });
});
