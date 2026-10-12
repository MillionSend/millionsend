import { describe, expect, it } from "vitest";
import { attachmentDisposition } from "../src/http-headers.js";

describe("attachmentDisposition", () => {
  it("names a plain file both ways", () => {
    expect(attachmentDisposition("report.pdf")).toBe(
      `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
    );
  });

  it("never lets a quote, backslash, control character or non-ASCII through unencoded", () => {
    const value = attachmentDisposition('a"b\\c\r\nSet-Cookie: x;ção (1)*.txt');
    expect(value).not.toMatch(/[\r\n]/);
    expect(value).toBe(
      `attachment; filename="a_b_c__Set-Cookie: x;__o (1)*.txt"; filename*=UTF-8''a%22b%5Cc%0D%0ASet-Cookie%3A%20x%3B%C3%A7%C3%A3o%20%281%29%2A.txt`,
    );
  });

  it("survives a lone surrogate", () => {
    expect(attachmentDisposition("x\ud800.png")).toBe(
      `attachment; filename="x_.png"; filename*=UTF-8''x%EF%BF%BD.png`,
    );
  });
});
