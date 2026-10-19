import { describe, expect, it } from "vitest";
import type { InboxActor } from "../src/inboxes/activity.js";
import { defaultSafety, type InboxSafety } from "../src/inboxes/safety.js";
import {
  type AgentSendInput,
  decideAgentSend,
  isSharedInboxSender,
  type RecipientClass,
  rampLimit,
  SHARED_REFUSALS,
  secondsToNextUtcDay,
} from "../src/inboxes/send-policy.js";
import type { SharedSending } from "../src/inboxes/shared-mode.js";
import { allowlisted } from "../src/receiving/trust.js";

const NOW = new Date("2026-10-12T10:00:00Z");
const DAY = 86_400_000;
const AGENT_KEY: InboxActor = { kind: "api_key", apiKeyId: "k1", inboxId: null };

const to = (cls: RecipientClass, address = `${cls}@example.com`, viaUntrustedReplyTo = false) => ({
  address,
  cls,
  viaUntrustedReplyTo,
});

function input(over: {
  kind?: "agent" | "human";
  shared?: boolean;
  safety?: Partial<InboxSafety>;
  firstSentAt?: Date | null;
  teamTierNew?: boolean;
  sharedMode?: SharedSending;
  sharedNamesOk?: boolean;
  sharedTeamCap?: number;
  sharedRecipientsToday?: number;
  actor?: InboxActor;
  approved?: boolean;
  requiresApproval?: boolean;
  isReply?: boolean;
  recipients?: AgentSendInput["recipients"];
  automated?: string | null;
  burstExceeded?: boolean;
  privateHit?: boolean;
  recipientsToday?: number;
  newRecipientsToday?: number;
}): AgentSendInput {
  const kind = over.kind ?? "agent";
  const shared = over.shared ?? false;
  return {
    inbox: {
      id: "inbox-1",
      kind,
      shared,
      safety: { ...defaultSafety(kind, shared), ...over.safety },
      firstSentAt: over.firstSentAt ?? null,
    },
    teamTierNew: over.teamTierNew ?? false,
    sharedMode: over.sharedMode ?? { mode: "reply_only", cause: "instance" },
    sharedNamesOk: over.sharedNamesOk ?? true,
    sharedTeamCap: over.sharedTeamCap ?? 1000,
    actor: over.actor ?? AGENT_KEY,
    approved: over.approved ?? false,
    requiresApproval: over.requiresApproval ?? false,
    isReply: over.isReply ?? true,
    recipients: over.recipients ?? [to("thread")],
    replyTarget: over.automated === undefined ? null : { automated: over.automated },
    burstExceeded: over.burstExceeded ?? false,
    privateHit: over.privateHit ?? false,
    usage: {
      recipientsToday: over.recipientsToday ?? 0,
      newRecipientsToday: over.newRecipientsToday ?? 0,
      sharedRecipientsToday: over.sharedRecipientsToday ?? 0,
    },
    now: NOW,
  };
}

const reasons = (i: AgentSendInput) => {
  const d = decideAgentSend(i);
  return d.result === "draft" ? d.reasons : d.result;
};

describe("decideAgentSend", () => {
  it("refuses an inbox-scoped key sending from another inbox (403 restricted_api_key)", () => {
    const d = decideAgentSend(
      input({ actor: { kind: "api_key", apiKeyId: "k", inboxId: "another-inbox" } }),
    );
    expect(d).toMatchObject({ result: "refuse", status: 403, name: "restricted_api_key" });
    const own = decideAgentSend(
      input({ actor: { kind: "api_key", apiKeyId: "k", inboxId: "inbox-1" } }),
    );
    expect(own.result).toBe("send");
  });

  it("reply_only: a shared address never starts a conversation or writes outside its thread, approved or not", () => {
    for (const approved of [false, true]) {
      expect(decideAgentSend(input({ shared: true, isReply: false, approved }))).toMatchObject({
        result: "refuse",
        status: 403,
        name: "inbox_send_policy",
        message: "Addresses on the shared domain only reply inside their threads",
      });
      expect(
        decideAgentSend(input({ shared: true, approved, recipients: [to("thread"), to("known")] })),
      ).toMatchObject({ result: "refuse", name: "inbox_send_policy" });
    }
    expect(
      decideAgentSend(input({ shared: true, recipients: [to("thread"), to("owner")] })).result,
    ).toBe("send");
  });

  it("refuses past the daily cap with retry-after at the next UTC midnight; approved sends count but pass", () => {
    const over = decideAgentSend(input({ recipientsToday: 200 }));
    expect(over).toMatchObject({ result: "refuse", status: 429, name: "inbox_send_cap_reached" });
    expect(over.result === "refuse" && over.retryAfterSec).toBe(14 * 3600);
    expect(secondsToNextUtcDay(NOW)).toBe(14 * 3600);
    expect(decideAgentSend(input({ recipientsToday: 199 })).result).toBe("send");
    const approved = decideAgentSend(input({ recipientsToday: 5000, approved: true }));
    expect(approved).toMatchObject({ result: "send", countTowardCap: false });
    expect(decideAgentSend(input({ kind: "human", recipientsToday: 9999 })).result).toBe("send");
  });

  it("reply_only: a thread reply sends, a new address or a new conversation waits for a person", () => {
    expect(decideAgentSend(input({}))).toEqual({
      result: "send",
      firstContact: false,
      newRecipients: [],
      countTowardCap: true,
    });
    expect(reasons(input({ recipients: [to("new")] }))).toEqual(["send_policy"]);
    expect(reasons(input({ isReply: false, recipients: [to("owner")] }))).toEqual(["send_policy"]);
  });

  it("reply_only: a reply to a Reply-To on a foreign domain is held as reply_to_redirect", () => {
    expect(reasons(input({ recipients: [to("new", "victim@elsewhere.example", true)] }))).toEqual([
      "reply_to_redirect",
      "send_policy",
    ]);
  });

  it("allowlist: new conversations reach the allowlist and owners only", () => {
    const safety = { send_policy: "allowlist" as const };
    expect(
      decideAgentSend(
        input({ safety, isReply: false, recipients: [to("allowlisted", "ana@stripe.com")] }),
      ).result,
    ).toBe("send");
    expect(reasons(input({ safety, isReply: false, recipients: [to("known")] }))).toEqual([
      "send_policy",
    ]);
  });

  it("open: anyone, for an established team; a new team reads it as reply_only", () => {
    const safety = { send_policy: "open" as const };
    const d = decideAgentSend(
      input({ safety, isReply: false, recipients: [to("new", "x@y.example")] }),
    );
    expect(d).toEqual({
      result: "send",
      firstContact: true,
      newRecipients: ["x@y.example"],
      countTowardCap: true,
    });
    expect(
      reasons(input({ safety, teamTierNew: true, isReply: false, recipients: [to("new")] })),
    ).toEqual(["send_policy"]);
  });

  it("ramps new recipients 10, 20, 40… a day from the first send, under the cap", () => {
    const safety = { send_policy: "open" as const };
    const eleven = Array.from({ length: 11 }, (_, i) => to("new", `n${i}@example.com`));
    expect(reasons(input({ safety, isReply: false, recipients: eleven }))).toEqual(["ramp"]);
    expect(
      decideAgentSend(input({ safety, isReply: false, recipients: eleven.slice(0, 10) })).result,
    ).toBe("send");
    expect(
      decideAgentSend(
        input({
          safety,
          isReply: false,
          recipients: eleven,
          firstSentAt: new Date(NOW.getTime() - DAY),
        }),
      ).result,
    ).toBe("send");
    expect(rampLimit(null, NOW)).toBe(10);
    expect(rampLimit(new Date(NOW.getTime() - 3 * DAY), NOW)).toBe(80);
    expect(
      reasons(
        input({
          safety: { ...safety, send_cap: 15 },
          isReply: false,
          recipients: eleven,
          newRecipientsToday: 5,
          firstSentAt: new Date(NOW.getTime() - 10 * DAY),
        }),
      ),
    ).toEqual(["ramp"]);
  });

  it("holds a reply to automated mail and a burst to one address (RFC 3834 loop guard)", () => {
    for (const reason of [
      "null_sender",
      "auto_submitted",
      "precedence",
      "mailing_list",
      "suppress_requested",
      "auto_reply",
      "report",
      "no_reply_address",
      "auto_reply_subject",
    ]) {
      expect(reasons(input({ automated: reason }))).toEqual([`loop_guard:${reason}`]);
    }
    expect(decideAgentSend(input({ automated: null })).result).toBe("send");
    expect(reasons(input({ burstExceeded: true }))).toEqual(["loop_burst"]);
  });

  it("keeps received codes and sign-in links with owners and the allowlist", () => {
    expect(reasons(input({ privateHit: true, recipients: [to("thread")] }))).toEqual([
      "private_code",
    ]);
    expect(
      decideAgentSend(input({ privateHit: true, recipients: [to("owner"), to("allowlisted")] }))
        .result,
    ).toBe("send");
    expect(
      decideAgentSend(
        input({ privateHit: true, safety: { private_codes: false }, recipients: [to("thread")] }),
      ).result,
    ).toBe("send");
  });

  it("asks for approval when the inbox requires it or the request does", () => {
    expect(reasons(input({ safety: { require_approval: true } }))).toEqual(["require_approval"]);
    expect(reasons(input({ requiresApproval: true }))).toEqual(["approval_required"]);
  });

  it("accumulates every reason a mixed send fails", () => {
    expect(
      reasons(
        input({
          automated: "auto_submitted",
          burstExceeded: true,
          privateHit: true,
          requiresApproval: true,
          recipients: [to("new", "victim@elsewhere.example", true)],
        }),
      ),
    ).toEqual([
      "loop_guard:auto_submitted",
      "loop_burst",
      "reply_to_redirect",
      "send_policy",
      "private_code",
      "approval_required",
    ]);
  });

  it("skips the rails for an approval and for a people inbox, never the identity, shared or cap rules", () => {
    const risky = {
      automated: "auto_submitted",
      privateHit: true,
      requiresApproval: true,
      isReply: false,
      recipients: [to("new")],
    };
    expect(decideAgentSend(input({ ...risky, approved: true })).result).toBe("send");
    expect(
      decideAgentSend(input({ ...risky, kind: "human", safety: { send_policy: "reply_only" } }))
        .result,
    ).toBe("send");
    expect(decideAgentSend(input({ ...risky, kind: "human", shared: true })).result).toBe("refuse");
  });

  it("counts bcc and every class in the cap, and names the new recipients of a first contact", () => {
    const d = decideAgentSend(
      input({
        safety: { send_policy: "open", send_cap: 3 },
        isReply: false,
        recipients: [to("owner"), to("known"), to("new", "fresh@example.com")],
        recipientsToday: 0,
      }),
    );
    expect(d).toEqual({
      result: "send",
      firstContact: true,
      newRecipients: ["fresh@example.com"],
      countTowardCap: true,
    });
    expect(
      decideAgentSend(
        input({
          safety: { send_policy: "open", send_cap: 3 },
          isReply: false,
          recipients: [to("owner"), to("known"), to("new")],
          recipientsToday: 1,
        }),
      ).result,
    ).toBe("refuse");
  });
});

describe("decideAgentSend on the shared domain", () => {
  const OPEN: SharedSending = { mode: "open", cause: null };
  const PAUSED: SharedSending = { mode: "receive_only", cause: "instance" };
  const FREE: SharedSending = { mode: "reply_only", cause: "plan" };
  const shared = (over: Parameters<typeof input>[0]) => input({ shared: true, ...over });
  const cold = { isReply: false, recipients: [to("new", "x@y.example")] };

  it("receive_only refuses every send, a person's or an approved thread reply too", () => {
    for (const kind of ["agent", "human"] as const) {
      for (const approved of [false, true]) {
        expect(decideAgentSend(shared({ kind, approved, sharedMode: PAUSED }))).toEqual({
          result: "refuse",
          ...SHARED_REFUSALS.shared_paused,
          reason: "shared_paused",
        });
      }
    }
  });

  it("reply_only answers with its cause, the plan or the instance, and still lets a thread reply out", () => {
    expect(decideAgentSend(shared({ ...cold, approved: true, sharedMode: FREE }))).toEqual({
      result: "refuse",
      ...SHARED_REFUSALS.shared_plan,
      reason: "shared_plan",
    });
    expect(decideAgentSend(shared({ ...cold, approved: true }))).toEqual({
      result: "refuse",
      ...SHARED_REFUSALS.shared_domain,
      reason: "shared_domain",
    });
    expect(decideAgentSend(shared({ sharedMode: FREE })).result).toBe("send");
  });

  it("open lifts the reply-only rule: people and approvals send, an agent follows send_policy and the new tier", () => {
    expect(decideAgentSend(shared({ ...cold, kind: "human", sharedMode: OPEN }))).toEqual({
      result: "send",
      firstContact: true,
      newRecipients: ["x@y.example"],
      countTowardCap: true,
    });
    expect(decideAgentSend(shared({ ...cold, approved: true, sharedMode: OPEN })).result).toBe(
      "send",
    );
    expect(reasons(shared({ ...cold, sharedMode: OPEN }))).toEqual(["send_policy"]);
    const open = { send_policy: "open" as const };
    expect(decideAgentSend(shared({ ...cold, safety: open, sharedMode: OPEN })).result).toBe(
      "send",
    );
    expect(reasons(shared({ ...cold, safety: open, teamTierNew: true, sharedMode: OPEN }))).toEqual(
      ["send_policy"],
    );
  });

  it("open still reads as reply_only while the inbox's names fail the brand guard", () => {
    expect(
      decideAgentSend(shared({ ...cold, approved: true, sharedMode: OPEN, sharedNamesOk: false })),
    ).toMatchObject({ result: "refuse", reason: "shared_domain" });
    expect(decideAgentSend(shared({ sharedMode: OPEN, sharedNamesOk: false })).result).toBe("send");
  });

  it("caps the team's recipients from the shared domain per UTC day, approved sends included", () => {
    const two = {
      kind: "human" as const,
      isReply: false,
      recipients: [to("new"), to("known")],
      sharedMode: OPEN,
      sharedTeamCap: 5,
    };
    expect(decideAgentSend(shared({ ...two, sharedRecipientsToday: 3 })).result).toBe("send");
    expect(decideAgentSend(shared({ ...two, sharedRecipientsToday: 4, approved: true }))).toEqual({
      result: "refuse",
      ...SHARED_REFUSALS.shared_team_cap,
      reason: "shared_team_cap",
      retryAfterSec: 14 * 3600,
    });
    expect(decideAgentSend(input({ ...two, sharedRecipientsToday: 4 })).result).toBe("send");
  });
});

describe("allowlisted", () => {
  it("matches exact addresses as written and a *@domain with its subdomains", () => {
    const list = ["ana@acme.com", "*@stripe.com"];
    expect(allowlisted("ANA@acme.com", list)).toBe(true);
    expect(allowlisted("ana+x@acme.com", list)).toBe(false);
    expect(allowlisted("billing@stripe.com", list)).toBe(true);
    expect(allowlisted("x@mail.stripe.com", list)).toBe(true);
    expect(allowlisted("x@notstripe.com", list)).toBe(false);
  });
});

describe("isSharedInboxSender", () => {
  it("reads the shared domain and its team subdomains, and nothing when it is unset", () => {
    expect(isSharedInboxSender("Bot <a@acme.agents.example>", "agents.example")).toBe(true);
    expect(isSharedInboxSender("a@agents.example", "agents.example")).toBe(true);
    expect(isSharedInboxSender("a@evilagents.example", "agents.example")).toBe(false);
    expect(isSharedInboxSender("a@acme.agents.example", null)).toBe(false);
    expect(isSharedInboxSender("not an address", "agents.example")).toBe(false);
  });
});
