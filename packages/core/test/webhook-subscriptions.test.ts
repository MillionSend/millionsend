import { describe, expect, it } from "vitest";
import { endpointSubscribes, WEBHOOK_EVENT_TYPES } from "../src/webhooks.js";

describe("endpointSubscribes", () => {
  it("delivers ordinary events to an all-events endpoint and named ones to a list", () => {
    expect(endpointSubscribes(null, "email.opened")).toBe(true);
    expect(endpointSubscribes(["email.clicked"], "email.opened")).toBe(false);
    expect(endpointSubscribes(["email.opened"], "email.opened")).toBe(true);
  });

  it("delivers email.scheduled, email.failed and email.suppressed to all-events endpoints", () => {
    for (const type of ["email.scheduled", "email.failed", "email.suppressed"] as const) {
      expect(endpointSubscribes(null, type), type).toBe(true);
      expect(endpointSubscribes(["email.bounced"], type), type).toBe(false);
    }
  });

  it("hands opt-in events only to endpoints that name them", () => {
    expect(endpointSubscribes(null, "email.prefetched")).toBe(false);
    expect(endpointSubscribes(["email.prefetched"], "email.prefetched")).toBe(true);
  });

  it("registers Resend's inbox events plus MillionSend's two, every one opt-in", () => {
    const inbox = WEBHOOK_EVENT_TYPES.filter((type) => type.startsWith("inbox."));
    expect(inbox).toEqual([
      "inbox.created",
      "inbox.updated",
      "inbox.deleted",
      "inbox.expired",
      "inbox.thread.created",
      "inbox.thread.folder.updated",
      "inbox.thread.labels.updated",
      "inbox.email.received",
      "inbox.email.sent",
      "inbox.email.quarantined",
      "inbox.draft.created",
      "inbox.draft.updated",
      "inbox.draft.sent",
      "inbox.draft.deleted",
    ]);
    for (const type of inbox) {
      expect(endpointSubscribes(null, type), type).toBe(false);
      expect(endpointSubscribes([type], type), type).toBe(true);
    }
    // Assignment is not built, so its events are never offered.
    expect(WEBHOOK_EVENT_TYPES as readonly string[]).not.toContain("inbox.thread.assigned");
    // email.received still reaches every all-events endpoint.
    expect(endpointSubscribes(null, "email.received")).toBe(true);
  });
});
