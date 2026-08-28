import { describe, expect, it } from "vitest";
import { sesEventsProxyHint, withComposeProfile } from "../src/setup-flow.js";

describe("withComposeProfile", () => {
  it("adds the first profile, appends to existing ones, and never duplicates", () => {
    expect(withComposeProfile("A=1\n", "backup")).toBe("A=1\nCOMPOSE_PROFILES=backup\n");
    expect(withComposeProfile("COMPOSE_PROFILES=docs\n", "backup")).toBe(
      "COMPOSE_PROFILES=docs,backup\n",
    );
    expect(withComposeProfile("COMPOSE_PROFILES=docs, backup\n", "backup")).toBe(
      "COMPOSE_PROFILES=docs, backup\n",
    );
  });

  // The template ships the line commented out as documentation; enabling a
  // profile must produce an active line, not edit the comment.
  it("leaves a commented-out template line alone and writes an active one", () => {
    const out = withComposeProfile("# COMPOSE_PROFILES=docs,backup\n", "smtp");
    expect(out).toContain("# COMPOSE_PROFILES=docs,backup");
    expect(out).toContain("\nCOMPOSE_PROFILES=smtp\n");
  });
});

describe("sesEventsProxyHint", () => {
  it("names the endpoint and the exact nginx location for the configured api port", () => {
    const hint = sesEventsProxyHint("https://mail.example.com", 4001);
    expect(hint).toContain("https://mail.example.com/ses/events");
    expect(hint).toContain("location = /ses/events { proxy_pass http://127.0.0.1:4001; }");
  });
});
