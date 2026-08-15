import { describe, expect, it } from "vitest";
import { parseSingleSender } from "../src/sender-address.js";

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
    expect(parseSingleSender('"weird@name" <a@b.com>')).toEqual({
      address: "a@b.com",
      domain: "b.com",
    });
    expect(parseSingleSender('"a <b> c, d; e" <a@b.com>')).toEqual({
      address: "a@b.com",
      domain: "b.com",
    });
    expect(parseSingleSender('"esc \\" quote@x" <a@b.com>')).toEqual({
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
  ])("rejects %j", (from) => {
    expect(parseSingleSender(from)).toBeNull();
  });
});
