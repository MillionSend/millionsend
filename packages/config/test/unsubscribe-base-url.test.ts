import { expect, it } from "vitest";
import { type Env, unsubscribeBaseUrl } from "../src/env.js";

function fakeEnv(overrides: Record<string, string | undefined>): Env {
  return { APP_BASE_URL: "https://app.example.com", ...overrides } as unknown as Env;
}

it("puts the unsubscribe pages on their own host when one is configured, else on the dashboard", () => {
  expect(unsubscribeBaseUrl(fakeEnv({}))).toBe("https://app.example.com");
  expect(
    unsubscribeBaseUrl(fakeEnv({ UNSUBSCRIBE_BASE_URL: "https://unsubscribe.example.com" })),
  ).toBe("https://unsubscribe.example.com");
  expect(unsubscribeBaseUrl(fakeEnv({ APP_BASE_URL: undefined }))).toBeUndefined();
});
