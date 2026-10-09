import { describe, expect, it } from "vitest";
import {
  isRootDomainSend,
  registrableDomain,
  vouchedRegistrableDomain,
} from "../src/org-domain.js";

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
    expect(registrableDomain("mail.acme.co.il")).toBe("acme.co.il");
    expect(registrableDomain("news.acme.com.ph")).toBe("acme.com.ph");
    expect(registrableDomain("send.acme.co.th")).toBe("acme.co.th");
  });

  it("follows the Public Suffix List past the old curated families", () => {
    expect(registrableDomain("cartas.vinco.app.br")).toBe("vinco.app.br");
    expect(registrableDomain("mail.kriter.ia.br")).toBe("kriter.ia.br");
    expect(registrableDomain("pay.shop.com.ua")).toBe("shop.com.ua");
    // ICANN section only: a private suffix is not a name a registry sold.
    expect(registrableDomain("x.github.io")).toBe("github.io");
  });

  it("returns a name with no registrable part as is", () => {
    expect(registrableDomain("com.br")).toBe("com.br");
    expect(registrableDomain("10.0.0.1")).toBe("10.0.0.1");
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
    expect(isRootDomainSend("acme.co.il")).toBe(true);
    expect(isRootDomainSend("Acme.COM")).toBe(true);
  });

  it("is false for a subdomain", () => {
    expect(isRootDomainSend("mail.acme.com")).toBe(false);
    expect(isRootDomainSend("news.acme.com.br")).toBe(false);
    expect(isRootDomainSend("mail.acme.co.il")).toBe(false);
  });
});

describe("vouchedRegistrableDomain", () => {
  it("vouches under a listed multi-part suffix or a generic TLD", () => {
    expect(vouchedRegistrableDomain("news.dinzo.com.br")).toBe("dinzo.com.br");
    expect(vouchedRegistrableDomain("mail.acme.co.uk")).toBe("acme.co.uk");
    expect(vouchedRegistrableDomain("tx.acme.com")).toBe("acme.com");
  });

  it("vouches the exact name the suffix list gives, never a public suffix", () => {
    expect(vouchedRegistrableDomain("x.sp.gov.br")).toBe("x.sp.gov.br");
    expect(vouchedRegistrableDomain("loja.app.br")).toBe("loja.app.br");
    expect(vouchedRegistrableDomain("pay.shop.com.ua")).toBe("shop.com.ua");
    expect(vouchedRegistrableDomain("com.br")).toBeNull();
  });

  it("does not vouch where strangers share the ICANN name", () => {
    expect(vouchedRegistrableDomain("mail.foo.eu.org")).toBeNull();
    expect(vouchedRegistrableDomain("x.github.io")).toBeNull();
  });
});
