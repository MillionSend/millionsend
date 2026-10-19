import { describe, expect, it } from "vitest";
import { RECEIVED_STATE_TONE, type ReceivedVerdicts, receivedState } from "./received-state";

const clean: ReceivedVerdicts = {
  spamVerdict: "pass",
  virusVerdict: "pass",
  pending: false,
  quarantined: false,
  suspicious: false,
};

describe("receivedState", () => {
  it("leads with the most urgent state, first match wins", () => {
    const everything: ReceivedVerdicts = {
      spamVerdict: "fail",
      virusVerdict: "fail",
      pending: true,
      quarantined: true,
      suspicious: true,
    };
    expect(receivedState(everything)).toBe("virus");
    expect(receivedState({ ...everything, virusVerdict: "pass" })).toBe("quarantined");
    expect(receivedState({ ...everything, virusVerdict: "pass", quarantined: false })).toBe(
      "screening",
    );
    expect(receivedState({ ...clean, spamVerdict: "fail", suspicious: true })).toBe("spam");
    expect(receivedState({ ...clean, suspicious: true, virusVerdict: "processing_failed" })).toBe(
      "suspicious",
    );
    expect(receivedState({ ...clean, virusVerdict: "processing_failed" })).toBe("unscanned");
    expect(receivedState(clean)).toBe("clean");
  });

  it("never calls mail still being screened quarantined", () => {
    expect(receivedState({ ...clean, pending: true })).toBe("screening");
  });

  it("reads no scanner at all as clean, and a gray spam verdict as no verdict against it", () => {
    expect(receivedState({ ...clean, virusVerdict: null, spamVerdict: null })).toBe("clean");
    expect(receivedState({ ...clean, spamVerdict: "gray" })).toBe("clean");
  });

  it("warns on spam and suspicious mail, alarms on what is held or harmful", () => {
    expect(RECEIVED_STATE_TONE).toEqual({
      virus: "danger",
      quarantined: "danger",
      screening: "neutral",
      spam: "warn",
      suspicious: "warn",
      unscanned: "neutral",
      clean: "neutral",
    });
  });
});
