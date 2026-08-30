import { describe, expect, it } from "vitest";
import { formatMailbox, parseMailbox, parseSingleSender } from "../src/sender-address.js";

describe("parseSingleSender", () => {
  it("accepts a bare addr-spec", () => {
    expect(parseSingleSender("ok@mine.com")).toEqual({
      address: "ok@mine.com",
      domain: "mine.com",
    });
    expect(parseSingleSender("  ok@Mine.COM  ")).toEqual({
      address: "ok@Mine.COM",
      domain: "mine.com",
    });
    expect(parseSingleSender("first.last+tag@sub.mine.com")).toEqual({
      address: "first.last+tag@sub.mine.com",
      domain: "sub.mine.com",
    });
  });

  it("accepts display-name angle-addr forms", () => {
    expect(parseSingleSender("Acme <ok@mine.com>")).toEqual({
      address: "ok@mine.com",
      domain: "mine.com",
    });
    expect(parseSingleSender("<ok@mine.com>")).toEqual({
      address: "ok@mine.com",
      domain: "mine.com",
    });
    expect(parseSingleSender("Acme Sales Team <ok@mine.com>  ")).toEqual({
      address: "ok@mine.com",
      domain: "mine.com",
    });
  });

  it("treats quoted display names containing symbols as one mailbox", () => {
    expect(parseSingleSender('"Doe, John" <a@b.com>')).toEqual({
      address: "a@b.com",
      domain: "b.com",
    });
    expect(parseSingleSender('"a <b> c, d; e" <a@b.com>')).toEqual({
      address: "a@b.com",
      domain: "b.com",
    });
    expect(parseSingleSender('"esc \\" quote" <a@b.com>')).toEqual({
      address: "a@b.com",
      domain: "b.com",
    });
    expect(parseSingleSender('"a b"@mine.com')).toEqual({
      address: '"a b"@mine.com',
      domain: "mine.com",
    });
  });

  it("rejects the multi-angle-addr spoof (first/last parser divergence)", () => {
    // A lenient last-<addr> extractor authorizes mine.com while a first-addr
    // MIME builder emits evil@other.com — must never parse.
    expect(parseSingleSender("Acme <evil@other.com> <ok@mine.com>")).toBeNull();
    expect(parseSingleSender("<ok@mine.com> <evil@other.com>")).toBeNull();
    expect(parseSingleSender("evil@other.com <ok@mine.com>")).toBeNull();
    expect(parseSingleSender("Acme <ok@mine.com> evil@other.com")).toBeNull();
    expect(parseSingleSender("<evil@other.com>ok@mine.com")).toBeNull();
  });

  it("rejects address lists and group syntax", () => {
    expect(parseSingleSender("ok@mine.com, evil@other.com")).toBeNull();
    expect(parseSingleSender("Acme <ok@mine.com>, Evil <evil@other.com>")).toBeNull();
    expect(parseSingleSender("team: ok@mine.com;")).toBeNull();
  });

  it.each([
    [""],
    ["   "],
    ["Acme"],
    ["Acme <>"],
    ["Acme <ok@mine.com"], // unclosed angle-addr
    ["Acme ok@mine.com>"], // '>' without '<'
    ["Acme <ok@mine.com> extra"],
    ["a@b@mine.com"], // second '@' in unquoted local
    ["<a@b@mine.com>"],
    ["@mine.com"],
    ["ok@"],
    ["ok@-mine.com"], // label starts with hyphen
    ["ok@mine..com"], // empty label
    ["ok@mine.com."], // trailing dot
    ["ok@mi ne.com"],
    ['"unterminated <a@b.com>'],
    ['"a@b.com"'], // quoted local with no @domain
    ["ok@mine.com\r\nBcc: evil@other.com"], // header injection
    ["Acme\n <ok@mine.com>"],
    ["Acme <ok@[10.0.0.1]>"], // domain literal never matches a verified domain
    ["(comment) ok@mine.com <x@y.com>"],
    // A display name carrying an address reads as mail from that address on
    // clients that hide the addr-spec — quoted or not.
    ['"ceo@victim.com" <a@team.com>'],
    ['"CEO ceo@victim.com" <a@team.com>'],
    ['"weird@name" <a@b.com>'],
  ])("rejects %j", (from) => {
    expect(parseSingleSender(from)).toBeNull();
  });
});

describe("parseMailbox / formatMailbox", () => {
  it("returns the decoded display name and addr-spec", () => {
    expect(parseMailbox("ok@mine.com")).toEqual({ address: "ok@mine.com" });
    expect(parseMailbox("<ok@mine.com>")).toEqual({ address: "ok@mine.com" });
    expect(parseMailbox("Acme Sales <ok@mine.com>")).toEqual({
      name: "Acme Sales",
      address: "ok@mine.com",
    });
    expect(parseMailbox('"Doe, John" <a@b.com>')).toEqual({
      name: "Doe, John",
      address: "a@b.com",
    });
    expect(parseMailbox('"say \\"hi\\"" <a@b.com>')).toEqual({
      name: 'say "hi"',
      address: "a@b.com",
    });
  });

  it("rejects the recipient-smuggling forms an address list parser would expand", () => {
    expect(parseMailbox("suppressed@victim.com, other@victim.com <ok@example.com>")).toBeNull();
    expect(parseMailbox("x <evil@victim.com> <ok@example.com>")).toBeNull();
    expect(parseMailbox('"a@x, b@y" <ok@example.com>')).toBeNull();
    expect(parseMailbox("group: a@x.com, b@y.com;")).toBeNull();
    expect(parseMailbox("Acme <ok@mine.com>\r\nBcc: evil@other.com")).toBeNull();
  });

  it("formats with RFC 5322 quoting and round-trips through parseMailbox", () => {
    const cases: { name?: string; address: string }[] = [
      { address: "a@b.com" },
      { name: "Acme Sales", address: "a@b.com" },
      { name: "Doe, John", address: "a@b.com" },
      { name: 'say "hi" <now>', address: "a@b.com" },
      { name: "back\\slash", address: "a@b.com" },
      { name: "J. Doe", address: "a@b.com" },
    ];
    for (const m of cases) expect(parseMailbox(formatMailbox(m))).toEqual(m);
    expect(formatMailbox({ name: "Acme Sales", address: "a@b.com" })).toBe("Acme Sales <a@b.com>");
    expect(formatMailbox({ name: "Doe, John", address: "a@b.com" })).toBe('"Doe, John" <a@b.com>');
    expect(formatMailbox({ name: "  ", address: "a@b.com" })).toBe("a@b.com");
  });
});
