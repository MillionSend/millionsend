import { describe, expect, it } from "vitest";
import { zoneRelativeName } from "@/lib/zone";

describe("zoneRelativeName", () => {
  it("strips the registrable domain on a plain TLD", () => {
    expect(zoneRelativeName("send.example.com", "example.com")).toBe("send");
    expect(zoneRelativeName("_dmarc.example.com", "example.com")).toBe("_dmarc");
    expect(zoneRelativeName("s1._domainkey.example.com", "example.com")).toBe("s1._domainkey");
  });

  it("keeps subdomain labels when the account domain is itself a subdomain", () => {
    expect(zoneRelativeName("send.teste.postomize.ai", "teste.postomize.ai")).toBe("send.teste");
    expect(zoneRelativeName("_dmarc.teste.postomize.ai", "teste.postomize.ai")).toBe(
      "_dmarc.teste",
    );
    expect(zoneRelativeName("send.mail.teste.postomize.ai", "teste.postomize.ai")).toBe(
      "send.mail.teste",
    );
    // The account domain itself is a subdomain of the zone, not the apex.
    expect(zoneRelativeName("teste.postomize.ai", "teste.postomize.ai")).toBe("teste");
  });

  it("recognizes multi-part public suffixes", () => {
    expect(zoneRelativeName("send.example.com.br", "example.com.br")).toBe("send");
    expect(zoneRelativeName("_dmarc.loja.example.com.br", "loja.example.com.br")).toBe(
      "_dmarc.loja",
    );
    expect(zoneRelativeName("send.shop.co.uk", "shop.co.uk")).toBe("send");
  });

  it("renders the zone apex as @", () => {
    expect(zoneRelativeName("example.com", "example.com")).toBe("@");
    expect(zoneRelativeName("example.com.br", "example.com.br")).toBe("@");
  });

  it("passes names outside the zone through unchanged", () => {
    expect(zoneRelativeName("feedback-smtp.us-east-1.amazonses.com", "example.com")).toBe(
      "feedback-smtp.us-east-1.amazonses.com",
    );
  });
});
