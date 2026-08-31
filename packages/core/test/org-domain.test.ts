import { describe, expect, it } from "vitest";
import { isRootDomainSend, registrableDomain } from "../src/org-domain.js";

describe("registrableDomain", () => {
  it("takes the last two labels on a plain TLD", () => {
    expect(registrableDomain("example.com")).toBe("example.com");
    expect(registrableDomain("send.example.com")).toBe("example.com");
    expect(registrableDomain("a.b.example.io")).toBe("example.io");
  });

  it("takes three labels on a multi-part public suffix", () => {
    expect(registrableDomain("example.com.br")).toBe("example.com.br");
    expect(registrableDomain("loja.example.com.br")).toBe("example.com.br");
    expect(registrableDomain("send.shop.co.uk")).toBe("shop.co.uk");
    expect(registrableDomain("mail.example.co.jp")).toBe("example.co.jp");
  });

  it("tolerates uppercase and a trailing dot", () => {
    expect(registrableDomain("Send.Example.COM")).toBe("example.com");
    expect(registrableDomain("example.com.")).toBe("example.com");
  });
});

describe("isRootDomainSend", () => {
  it("is true at the registrable apex", () => {
    expect(isRootDomainSend("acme.com")).toBe(true);
    expect(isRootDomainSend("acme.com.br")).toBe(true);
    expect(isRootDomainSend("Acme.COM")).toBe(true);
  });

  it("is false for a subdomain", () => {
    expect(isRootDomainSend("mail.acme.com")).toBe(false);
    expect(isRootDomainSend("news.acme.com.br")).toBe(false);
  });
});
