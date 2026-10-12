import { describe, expect, it } from "vitest";
import {
  extractCode,
  extractLink,
  outgoingSecretValues,
  receivedSecretValues,
} from "../src/receiving/codes.js";

const code = (subject: string, text: string) => {
  const found = extractCode({ subject, text }).code;
  return found && "value" in found ? found.value : null;
};

describe("extractCode", () => {
  it("finds the code a person would type", () => {
    expect(
      code("Verify your email", "Your verification code is 482913. It expires in 10 minutes."),
    ).toBe("482913");
    expect(code("G-482913 is your Google verification code", "")).toBe("482913");
    expect(
      code(
        "482913 is your Instagram code",
        "Someone tried to log in to your account. Use this code to confirm your identity: 482913",
      ),
    ).toBe("482913");
    expect(code("Código de verificação", "Seu código de verificação é: 482 913")).toBe("482913");
    expect(code("Tu código", "Tu código de seguridad es 4821")).toBe("4821");
    expect(code("Sign-in", "Your login code: XK7-92F")).toBe("XK792F");
    expect(
      code(
        "Sign in to Acme",
        "Use the code below to sign in:\n\n739201\n\nIt expires in 10 minutes. © 2026 Acme",
      ),
    ).toBe("739201");
  });

  it("takes nothing that is not a code: orders, amounts, promos, phones, dates, invoices", () => {
    expect(code("Order #482913 confirmed", "Thanks for your order 482913.")).toBeNull();
    expect(code("Seu pedido", "Pedido 48291301, total R$ 4821,00")).toBeNull();
    expect(
      code("Weekend sale", "Use promo code SAVE20 for 20% off. Sign in to redeem."),
    ).toBeNull();
    expect(code("Verify your account", "Call us at 4002-8922 to verify your account.")).toBeNull();
    expect(code("Verify", "Valid until 10/12/2026")).toBeNull();
    expect(code("Your invoice", "Invoice 2026-0042, due 2026-11-10")).toBeNull();
    // Spaced pairs are no code shape: precision over recall.
    expect(
      code("Acesse sua conta", "Para entrar, use o código\n\n58 21 77\n\nVálido por 5 min."),
    ).toBeNull();
  });

  it("answers ambiguous when two different codes tie, and keeps both for the secret MACs", () => {
    const r = extractCode({
      subject: "Your codes",
      text: "Verification code: 111222\nBackup verification code: 333444",
    });
    expect(r.code).toEqual({ ambiguous: true });
    expect(r.values.sort()).toEqual(["111222", "333444"]);
  });
});

const link = (anchors: { href: string; text: string }[], senderDomain: string | null = null) => {
  const found = extractLink({ subject: "", text: "", anchors, senderDomain }).link;
  return found && "url" in found ? found.url : null;
};

describe("extractLink", () => {
  it("finds the sign-in or verification link, as written", () => {
    expect(
      link([
        {
          href: "https://slack.com/z-app-1-2?magic=AbCdEf1234567890123456",
          text: "Sign in to Slack",
        },
        { href: "https://slack.com/unsubscribe?u=1", text: "Unsubscribe" },
      ]),
    ).toBe("https://slack.com/z-app-1-2?magic=AbCdEf1234567890123456");
    expect(
      link([
        {
          href: "https://app.exemplo.com.br/confirm?token=9f8e7d6c5b4a3f2e1d0c9b8a",
          text: "Confirmar e-mail",
        },
      ]),
    ).toBe("https://app.exemplo.com.br/confirm?token=9f8e7d6c5b4a3f2e1d0c9b8a");
    // A tracking wrapper is not unwrapped.
    expect(
      link([
        {
          href: "https://click.mailer.example/ls/click?upn=AbC123dEf456GhI789jKl0",
          text: "Verify email address",
        },
      ]),
    ).toBe("https://click.mailer.example/ls/click?upn=AbC123dEf456GhI789jKl0");
  });

  it("takes no shop, policy or script link, and a tie is ambiguous", () => {
    expect(link([{ href: "https://shop.example/sale", text: "Shop now" }])).toBeNull();
    expect(link([{ href: "https://x.example/privacy", text: "Privacy policy" }])).toBeNull();
    expect(link([{ href: "javascript:alert(1)", text: "Sign in" }])).toBeNull();
    expect(
      extractLink({
        subject: "",
        text: "",
        senderDomain: null,
        anchors: [
          { href: "https://a.example/verify?t=AAAAAAAAAAAAAAAAAAAA1", text: "Verify" },
          { href: "https://b.example/verify?t=BBBBBBBBBBBBBBBBBBBB2", text: "Verify" },
        ],
      }).link,
    ).toEqual({ ambiguous: true });
  });

  it("says whether the link sits on the sender's organization", () => {
    const at = (senderDomain: string) =>
      extractLink({
        subject: "Sign in",
        text: "",
        senderDomain,
        anchors: [{ href: "https://login.acme.example/auth?x=1", text: "Sign in" }],
      }).link;
    expect(at("mail.acme.example")).toMatchObject({ linkDomainMatchesSender: true });
    expect(at("evil.example")).toMatchObject({ linkDomainMatchesSender: false });
  });
});

describe("received secrets", () => {
  it("keys codes, links without their fragment and the tokens inside them", () => {
    const c = extractCode({
      subject: "Your code",
      text: "Your verification code is 48-29-13 or 482913",
    });
    const l = extractLink({
      subject: "Sign in",
      text: "",
      senderDomain: null,
      anchors: [{ href: "https://x.example/login?t=Zz9Zz9Zz9Zz9Zz9Zz9Zz9#top", text: "Sign in" }],
    });
    expect(receivedSecretValues(c, l)).toEqual([
      { kind: "code", value: "482913" },
      { kind: "link", value: "https://x.example/login?t=Zz9Zz9Zz9Zz9Zz9Zz9Zz9" },
      { kind: "token", value: "Zz9Zz9Zz9Zz9Zz9Zz9Zz9" },
    ]);
  });

  it("finds the same values in outgoing text and HTML, normalized the same way", () => {
    const out = outgoingSecretValues(
      "Subject: here is 482-913",
      '<p>Use <a href="https://x.example/login?t=Zz9Zz9Zz9Zz9Zz9Zz9Zz9&amp;a=1#x">this</a></p>',
    );
    expect(out).toContain("482913");
    expect(out).toContain("https://x.example/login?t=Zz9Zz9Zz9Zz9Zz9Zz9Zz9&a=1");
    expect(out).toContain("Zz9Zz9Zz9Zz9Zz9Zz9Zz9");
  });

  it("finds a code spread out to slip past the shapes: separators, tags, invisible and fullwidth characters, a longer number", () => {
    for (const written of [
      "your code: 4 8 2 9 1 3",
      "48 · 29 · 13",
      "<p>48<b></b>2913</p>",
      "4\u200b8\u200b2\u200b9\u200b1\u200b3",
      "４８２９１３",
      "ref 1 4 8 2 9 1 3 7",
    ]) {
      expect(outgoingSecretValues(written), written).toContain("482913");
    }
    expect(outgoingSecretValues("C O D E: A B 1 2 C D")).toContain("AB12CD");
    expect(outgoingSecretValues("Meet at 5 pm on the 3rd")).not.toContain("53");
  });
});
