import { describe, expect, it } from "vitest";
import type { InboxActor } from "../src/inboxes/activity.js";
import { type ReplyFromName, replyFromChoices, replyFromName } from "../src/inboxes/reply-from.js";

const user: InboxActor = { kind: "user", userId: "u1" };
const inbox = (over: Partial<Parameters<typeof replyFromName>[0]["inbox"]> = {}) => ({
  fromName: "Legal" as string | null,
  domainId: "d1" as string | null,
  replyFromName: "inbox" as ReplyFromName,
  ...over,
});
const resolve = (
  p: Partial<Parameters<typeof replyFromName>[0]> & { inbox?: ReturnType<typeof inbox> },
) => replyFromName({ inbox: inbox(), actor: user, userName: "Ada", ...p });

describe("replyFromName", () => {
  it("follows each mode for a person", () => {
    expect(resolve({ mode: "inbox" })).toBe("Legal");
    expect(resolve({ mode: "teammate_inbox" })).toBe("Ada (Legal)");
    expect(resolve({ mode: "teammate" })).toBe("Ada");
  });

  it("defaults to the inbox's setting", () => {
    expect(resolve({ inbox: inbox({ replyFromName: "teammate_inbox" }) })).toBe("Ada (Legal)");
    expect(resolve({ inbox: inbox({ replyFromName: "teammate" }), mode: null })).toBe("Ada");
  });

  it("drops the parentheses without a from_name", () => {
    const bare = inbox({ fromName: null });
    expect(resolve({ inbox: bare, mode: "teammate_inbox" })).toBe("Ada");
    expect(resolve({ inbox: bare, mode: "inbox" })).toBeNull();
  });

  it("falls back to the inbox name for an account name a From can't carry", () => {
    for (const userName of [
      "",
      "  ",
      "deb@example.com",
      "Deb <x>",
      "Deb: hi",
      null,
      "x".repeat(79),
    ]) {
      expect(resolve({ userName, mode: "teammate" }), String(userName)).toBe("Legal");
    }
  });

  it("uses the name alone when the pair is too long", () => {
    const name = "D".repeat(71);
    expect(resolve({ userName: name, mode: "teammate_inbox" })).toBe(name);
  });

  it("ignores the mode on the shared domain and for every other actor", () => {
    expect(resolve({ inbox: inbox({ domainId: null }), mode: "teammate" })).toBe("Legal");
    const others: InboxActor[] = [
      { kind: "api_key", apiKeyId: "k", inboxId: null },
      { kind: "oauth", userId: "u1", clientId: "c" },
      { kind: "system" },
    ];
    for (const actor of others) {
      expect(resolve({ actor, mode: "teammate" }), actor.kind).toBe("Legal");
      expect(resolve({ actor, inbox: inbox({ replyFromName: "teammate" }) }), actor.kind).toBe(
        "Legal",
      );
    }
  });
});

describe("replyFromChoices", () => {
  it("lists each distinct name once, keeping the default's entry", () => {
    expect(replyFromChoices(inbox({ replyFromName: "teammate_inbox" }), "Ada")).toEqual({
      default: "teammate_inbox",
      teammate: "Ada",
      options: [
        { value: "inbox", name: "Legal" },
        { value: "teammate_inbox", name: "Ada (Legal)" },
        { value: "teammate", name: "Ada" },
      ],
    });
    expect(replyFromChoices(inbox({ fromName: null, replyFromName: "teammate" }), "Ada")).toEqual({
      default: "teammate",
      teammate: "Ada",
      options: [
        { value: "inbox", name: null },
        { value: "teammate", name: "Ada" },
      ],
    });
  });

  it("offers nothing where only the inbox name applies", () => {
    expect(replyFromChoices(inbox({ domainId: null }), "Ada")).toBeNull();
    expect(replyFromChoices(inbox(), "deb@example.com")).toBeNull();
  });
});
