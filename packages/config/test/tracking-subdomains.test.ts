import { expect, it } from "vitest";
import { type Env, trackingCnameTarget, trackingSubdomainsSupported } from "../src/env.js";

// Only the two fields the policy reads; the zod schema is not under test.
function fakeEnv(overrides: Record<string, boolean>): Env {
  return { IS_CLOUD: false, ALLOW_TRACKING_SUBDOMAINS: false, ...overrides } as unknown as Env;
}

// The operator owns the reverse proxy and its certificates, so pointing a
// hostname at the app is theirs to arrange — the flag is cloud-only.
it("always supports branded subdomains on self-host, flag or no flag", () => {
  expect(trackingSubdomainsSupported(fakeEnv({}))).toBe(true);
  expect(trackingSubdomainsSupported(fakeEnv({ ALLOW_TRACKING_SUBDOMAINS: true }))).toBe(true);
});

it("withholds them on cloud until the operator declares per-hostname certificates", () => {
  expect(trackingSubdomainsSupported(fakeEnv({ IS_CLOUD: true }))).toBe(false);
  expect(
    trackingSubdomainsSupported(fakeEnv({ IS_CLOUD: true, ALLOW_TRACKING_SUBDOMAINS: true })),
  ).toBe(true);
});

it("targets the tracking edge when one is set, else the app's own host", () => {
  const app = "https://app.example.com";
  expect(trackingCnameTarget(app, { TRACKING_EDGE_HOST: undefined } as unknown as Env)).toBe(
    "app.example.com",
  );
  expect(
    trackingCnameTarget(app, { TRACKING_EDGE_HOST: "track.example-dns.com" } as unknown as Env),
  ).toBe("track.example-dns.com");
});
