import { describe, expect, it } from "vitest";
import { endpointSubscribes } from "../src/webhooks.js";

describe("endpointSubscribes", () => {
  it("delivers ordinary events to an all-events endpoint and named ones to a list", () => {
    expect(endpointSubscribes(null, "email.opened")).toBe(true);
    expect(endpointSubscribes(["email.clicked"], "email.opened")).toBe(false);
    expect(endpointSubscribes(["email.opened"], "email.opened")).toBe(true);
  });

  it("hands opt-in events only to endpoints that name them", () => {
    expect(endpointSubscribes(null, "email.prefetched")).toBe(false);
    expect(endpointSubscribes(["email.prefetched"], "email.prefetched")).toBe(true);
  });
});
