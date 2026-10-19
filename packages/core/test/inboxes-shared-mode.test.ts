import { describe, expect, it } from "vitest";
import { sharedSendMode } from "../src/inboxes/shared-mode.js";
import type { Plan } from "../src/plans.js";

function mode(p: {
  send?: boolean;
  open?: boolean;
  judge?: boolean;
  autoHold?: boolean;
  plan?: Plan;
  cloud?: boolean;
}) {
  return sharedSendMode({
    settings: {
      sharedInboxSend: p.send ?? true,
      sharedInboxOpen: p.open ?? true,
      autoHold: p.autoHold ?? true,
    },
    plan: p.plan ?? "pro",
    isCloud: p.cloud ?? true,
    judgeConfigured: p.judge ?? true,
  });
}

describe("sharedSendMode", () => {
  it("opens only with both switches on, a judge with the auto-hold and a paid plan", () => {
    expect(mode({})).toEqual({ mode: "open", cause: null });
    expect(mode({ plan: "starter" })).toEqual({ mode: "open", cause: null });
    expect(mode({ plan: "free" })).toEqual({ mode: "reply_only", cause: "plan" });
  });

  it("names the instance before the plan whenever the instance holds a team back", () => {
    for (const plan of ["pro", "free"] as const) {
      expect(mode({ plan, send: false })).toEqual({ mode: "receive_only", cause: "instance" });
      expect(mode({ plan, open: false })).toEqual({ mode: "reply_only", cause: "instance" });
      expect(mode({ plan, judge: false })).toEqual({ mode: "reply_only", cause: "instance" });
      // Pre-SES screening runs only with the auto-hold on.
      expect(mode({ plan, autoHold: false })).toEqual({ mode: "reply_only", cause: "instance" });
    }
  });

  it("counts every self-hosted team as paid", () => {
    expect(mode({ plan: "free", cloud: false })).toEqual({ mode: "open", cause: null });
  });
});
