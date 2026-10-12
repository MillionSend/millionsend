import { describe, expect, it } from "vitest";
import {
  deriveInboxKeys,
  secretMac,
  threadTokenId,
  verifyThreadTokenRef,
} from "../src/inboxes/keys.js";

const keys = deriveInboxKeys(Buffer.alloc(32, 7));
const team = "11111111-1111-4111-8111-111111111111";
const inbox = "22222222-2222-4222-8222-222222222222";
const thread = "33333333-3333-4333-8333-333333333333";
const token = threadTokenId(keys, {
  teamId: team,
  inboxId: inbox,
  threadId: thread,
  domain: "mail.example.com",
});

describe("thread tokens", () => {
  it("are atext-only msg-ids that prove their thread for the team and inbox", () => {
    expect(token).toMatch(/^<ms1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}@mail\.example\.com>$/);
    expect(verifyThreadTokenRef(keys, { teamId: team, inboxId: inbox, ref: token })).toBe(thread);
    // Some clients write References without the angle brackets.
    expect(
      verifyThreadTokenRef(keys, { teamId: team, inboxId: inbox, ref: token.slice(1, -1) }),
    ).toBe(thread);
  });

  it("prove nothing for another inbox, another team or another key", () => {
    const other = "44444444-4444-4444-8444-444444444444";
    expect(verifyThreadTokenRef(keys, { teamId: team, inboxId: other, ref: token })).toBeNull();
    expect(verifyThreadTokenRef(keys, { teamId: other, inboxId: inbox, ref: token })).toBeNull();
    const rotated = deriveInboxKeys(Buffer.alloc(32, 8));
    expect(verifyThreadTokenRef(rotated, { teamId: team, inboxId: inbox, ref: token })).toBeNull();
  });

  it("fail on any changed character of the thread or the mac", () => {
    const start = token.indexOf("ms1.") + 4;
    const end = token.indexOf("@");
    for (let i = start; i < end; i++) {
      if (token[i] === ".") continue;
      const flipped = `${token.slice(0, i)}${token[i] === "A" ? "B" : "A"}${token.slice(i + 1)}`;
      expect(
        verifyThreadTokenRef(keys, { teamId: team, inboxId: inbox, ref: flipped }),
        `position ${i}`,
      ).toBeNull();
    }
  });

  it("ignore anything that is not a token", () => {
    for (const ref of ["<abc@mail.gmail.com>", "<ms1.short.mac@x>", "", "<>", `${token}>`]) {
      expect(verifyThreadTokenRef(keys, { teamId: team, inboxId: inbox, ref }), ref).toBeNull();
    }
  });
});

describe("secretMac", () => {
  it("binds the value to the team, under a key apart from the thread key", () => {
    const a = secretMac(keys, team, "482913");
    expect(a).toHaveLength(32);
    expect(secretMac(keys, team, "482913")).toEqual(a);
    expect(secretMac(keys, "55555555-5555-4555-8555-555555555555", "482913")).not.toEqual(a);
    expect(secretMac(keys, team, "482914")).not.toEqual(a);
    expect(keys.receivedSecret.equals(keys.threadToken)).toBe(false);
  });

  it("refuses a master key too short to derive from", () => {
    expect(() => deriveInboxKeys(Buffer.alloc(8))).toThrow(/too short/);
  });
});
