import { describe, expect, it } from "vitest";
import {
  defaultSafety,
  type InboxSafety,
  inboxSafetyPatchSchema,
  inboxSafetySchema,
  safetyProblem,
} from "../src/inboxes/safety.js";
import { SHARED_REFUSALS, SHARED_REPLY_ONLY_MESSAGE } from "../src/inboxes/send-policy.js";
import type { SharedSending } from "../src/inboxes/shared-mode.js";

const ctx = {
  kind: "agent" as const,
  shared: false,
  teamTierNew: false,
  memberEmails: ["Owner@Team.example"],
};

describe("defaultSafety", () => {
  it.each([
    ["agent", false, "verified", true, "reply_only", true, 200],
    ["agent", true, "verified", true, "reply_only", true, 50],
    ["human", false, "anyone", false, "open", false, null],
    ["human", true, "anyone", false, "reply_only", false, 50],
  ] as const)(
    "%s inbox, shared %s",
    (kind, shared, acceptFrom, screening, policy, privateCodes, cap) => {
      expect(defaultSafety(kind, shared)).toEqual({
        accept_from: acceptFrom,
        allowlist: [],
        owner_addresses: [],
        screening,
        extract_codes: true,
        send_policy: policy,
        require_approval: false,
        private_codes: privateCodes,
        send_cap: cap,
        forward_to: [],
      });
    },
  );

  it("is valid for the inbox it was made for", () => {
    for (const kind of ["agent", "human"] as const) {
      for (const shared of [false, true]) {
        expect(safetyProblem(defaultSafety(kind, shared), { ...ctx, kind, shared })).toBeNull();
      }
    }
  });
});

describe("inboxSafetySchema", () => {
  it("lowercases and dedupes entries, keeping plus tags as written", () => {
    const parsed = inboxSafetySchema.parse({
      ...defaultSafety("agent", false),
      allowlist: ["Maria+Billing@Gmail.com", "*@Stripe.COM", "maria+billing@gmail.com"],
      owner_addresses: [" Ops@Team.example "],
    });
    expect(parsed.allowlist).toEqual(["maria+billing@gmail.com", "*@stripe.com"]);
    expect(parsed.owner_addresses).toEqual(["ops@team.example"]);
  });

  it("refuses unknown keys, malformed entries and oversized lists", () => {
    const base = defaultSafety("agent", false);
    expect(inboxSafetySchema.safeParse({ ...base, retention: 1 }).success).toBe(false);
    for (const entry of ["*@", "*@localhost", "not an address", "a@b@c.com", "<a@b.com>"]) {
      expect(inboxSafetySchema.safeParse({ ...base, allowlist: [entry] }).success, entry).toBe(
        false,
      );
    }
    const many = Array.from({ length: 501 }, (_, i) => `s${i}@example.com`);
    expect(inboxSafetySchema.safeParse({ ...base, allowlist: many }).success).toBe(false);
    const six = Array.from({ length: 6 }, (_, i) => `f${i}@team.example`);
    expect(inboxSafetySchema.safeParse({ ...base, forward_to: six }).success).toBe(false);
  });

  it("takes any subset in a patch", () => {
    expect(inboxSafetyPatchSchema.parse({ send_cap: 10 })).toEqual({ send_cap: 10 });
    expect(inboxSafetyPatchSchema.safeParse({ send_policy: "everyone" }).success).toBe(false);
  });
});

describe("safetyProblem", () => {
  const agent: InboxSafety = defaultSafety("agent", false);

  it("keeps shared addresses replying inside threads, at most 50 a day", () => {
    const shared = { ...ctx, shared: true };
    expect(safetyProblem({ ...agent, send_cap: 50, send_policy: "open" }, shared)).toMatch(
      /only reply inside their threads/,
    );
    expect(safetyProblem({ ...agent, send_cap: 51 }, shared)).toMatch(/between 1 and 50/);
    expect(safetyProblem({ ...agent, send_cap: null }, shared)).toMatch(/between 1 and 50/);
    expect(safetyProblem({ ...agent, send_cap: 50 }, shared)).toBeNull();
  });

  it("never takes allowlist on the shared domain, and open only while the team's mode is open", () => {
    const shared = { ...ctx, shared: true };
    const base = defaultSafety("agent", true);
    expect(safetyProblem({ ...base, send_policy: "allowlist" }, shared)).toBe(
      'send_policy "allowlist" is not available on the shared domain: its allowlist never counts there',
    );
    const open = { ...base, send_policy: "open" as const };
    const mode = (sharedSending: SharedSending) =>
      safetyProblem(open, { ...shared, sharedSending });
    expect(mode({ mode: "open", cause: null })).toBeNull();
    expect(mode({ mode: "reply_only", cause: "plan" })).toBe(SHARED_REFUSALS.shared_plan.message);
    expect(mode({ mode: "reply_only", cause: "instance" })).toBe(SHARED_REPLY_ONLY_MESSAGE);
    expect(mode({ mode: "receive_only", cause: "instance" })).toBe(
      SHARED_REFUSALS.shared_paused.message,
    );
    expect(safetyProblem(open, shared)).toBe(SHARED_REPLY_ONLY_MESSAGE);
    // The allowlist advice a new team gets elsewhere would be refused here.
    expect(
      safetyProblem(open, {
        ...shared,
        teamTierNew: true,
        sharedSending: { mode: "open", cause: null },
      }),
    ).toBe('send_policy "open" is not available to a new team yet');
  });

  it("bounds send_cap and keeps open sending from new teams", () => {
    expect(safetyProblem({ ...agent, send_cap: 0 }, ctx)).toMatch(/between 1 and 100000/);
    expect(safetyProblem({ ...agent, send_cap: 100_001 }, ctx)).toMatch(/between 1 and 100000/);
    expect(safetyProblem({ ...agent, send_cap: null }, ctx)).toBeNull();
    const open = { ...agent, send_policy: "open" as const };
    expect(safetyProblem(open, { ...ctx, teamTierNew: true })).toMatch(/new team/);
    expect(safetyProblem(open, ctx)).toBeNull();
  });

  it("screens agent inboxes only", () => {
    const human = { ...ctx, kind: "human" as const };
    expect(safetyProblem({ ...defaultSafety("human", false), screening: true }, human)).toMatch(
      /agent inboxes only/,
    );
  });

  it("forwards only to member logins and owner addresses", () => {
    expect(safetyProblem({ ...agent, forward_to: ["owner@team.example"] }, ctx)).toBeNull();
    expect(
      safetyProblem(
        { ...agent, owner_addresses: ["boss@home.example"], forward_to: ["boss@home.example"] },
        ctx,
      ),
    ).toBeNull();
    expect(safetyProblem({ ...agent, forward_to: ["stranger@else.example"] }, ctx)).toMatch(
      /forward_to accepts/,
    );
    // The shared domain is every team's: an owner address there was never proven.
    const shared = { ...defaultSafety("agent", true), owner_addresses: ["boss@home.example"] };
    expect(
      safetyProblem({ ...shared, forward_to: ["boss@home.example"] }, { ...ctx, shared: true }),
    ).toMatch(/login addresses only on the shared domain/);
    expect(
      safetyProblem({ ...shared, forward_to: ["owner@team.example"] }, { ...ctx, shared: true }),
    ).toBeNull();
  });
});
