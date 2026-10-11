import { describe, expect, it } from "vitest";
import {
  displayNamesMatch,
  domainsMatch,
  type Fingerprint,
  fingerprintsMatch,
  mailboxIdentity,
  messageFingerprints,
  phoneKeys,
  subjectsMatch,
  visibleTextHash,
} from "../src/campaign-fingerprints.js";

const sending = (value: string): Fingerprint => ({ kind: "sending_domain", value });
const linked = (value: string): Fingerprint => ({ kind: "link_domain", value });

describe("domain names, on a returning campaign's look-alikes", () => {
  const returns = ["vexto-cadeaux.example", "vextos-cadeaux.example", "cadeaux-vexto.example"];

  it("ties every return to every other, as sending or link domains", () => {
    for (const a of returns) {
      for (const b of returns) {
        expect(domainsMatch(sending(a), sending(b)), `${a} ~ ${b}`).toBe(true);
        expect(domainsMatch(sending(a), linked(b)), `${a} ~ link ${b}`).toBe(true);
      }
    }
    expect(domainsMatch(sending("mail.vextocadeaux.test"), sending(returns[0] ?? ""))).toBe(true);
  });

  it("keeps apart names that share only a word, platform words or a short name", () => {
    const pairs: [string, string][] = [
      ["vexto-video.example", "vexto-cadeaux.example"],
      ["cadeaux.test", "cadeaux-vexto.example"],
      ["help-billing.io", "netflix-billing-help.com"],
      ["secure-login.com", "login-secure.net"],
      ["mail-online.com", "online-mail.org"],
      ["acme.com", "acme.io"],
      ["acmeshop.dev", "acme-shop-online.com"],
    ];
    for (const [a, b] of pairs) {
      expect(domainsMatch(sending(a), sending(b)), `${a} ~ ${b}`).toBe(false);
      expect(domainsMatch(sending(b), sending(a)), `${b} ~ ${a}`).toBe(false);
    }
  });

  it("matches one longer sending name under another suffix, never a link domain that way", () => {
    expect(domainsMatch(sending("facturevexto.example"), sending("facturevexto.test"))).toBe(true);
    expect(domainsMatch(sending("facturevexto.example"), linked("facturevexto.test"))).toBe(false);
  });
});

describe("display names", () => {
  it("meet on a sender name and its close variants", () => {
    expect(displayNamesMatch("Facture Vexto", "Facture Vexto")).toBe(true);
    expect(displayNamesMatch("Factures Vexto", "facture VEXTO")).toBe(true);
    expect(displayNamesMatch("Service Facture Vexto", "Facture Vexto")).toBe(true);
    expect(displayNamesMatch("Vexto Facture", "Facture Vexto")).toBe(true);
  });

  it("stay apart on one shared word, role names and lone words", () => {
    expect(displayNamesMatch("Vexto Video", "Facture Vexto")).toBe(false);
    expect(displayNamesMatch("Facture", "Facture")).toBe(false);
    expect(displayNamesMatch("Service Client", "Service Client")).toBe(false);
    expect(displayNamesMatch("Equipe Suporte", "Equipe Suporte")).toBe(false);
    expect(displayNamesMatch("Acme Facture Vexto Mensal", "Facture Vexto")).toBe(false);
  });
});

describe("subjects", () => {
  const lure = "Votre facture Vexto du 02/10 est disponible";

  it("meet when near-identical, whatever the date or amount", () => {
    expect(subjectsMatch(lure, "Votre facture Vexto du 04/10 est disponible")).toBe(true);
    expect(subjectsMatch(lure, "Votre facture Vexto est disponible")).toBe(true);
  });

  it("stay apart when generic, short or about something else", () => {
    expect(subjectsMatch(lure, "Votre facture est disponible")).toBe(false);
    expect(subjectsMatch(lure, "Votre colis est disponible")).toBe(false);
    expect(subjectsMatch("Facture Vexto", "Facture Vexto")).toBe(false);
    expect(subjectsMatch("Your order has been shipped", "Your order has been delivered")).toBe(
      false,
    );
  });
});

describe("mailboxIdentity", () => {
  it("drops Gmail's dots and any +tag, and lowercases", () => {
    expect(mailboxIdentity("a.b+x@gmail.com")).toBe("ab@gmail.com");
    expect(mailboxIdentity("A.B@GoogleMail.com")).toBe("ab@gmail.com");
    expect(mailboxIdentity("John+work@Acme.dev")).toBe("john@acme.dev");
    expect(mailboxIdentity("first.last@acme.dev")).toBe("first.last@acme.dev");
  });
});

describe("phoneKeys", () => {
  it("reads one line alike with or without its country code", () => {
    expect(phoneKeys("Appelez le +33 1 23 45 67 89")).toEqual(["123456789"]);
    expect(phoneKeys("Appelez le 01 23 45 67 89")).toEqual(["123456789"]);
    expect(phoneKeys("Ligue (11) 98765-4321")).toEqual(phoneKeys("+55 11 98765-4321"));
  });

  it("leaves dates, amounts and short codes out", () => {
    expect(phoneKeys("Le 04/10/2026, 1.234,56 EUR, code 482913")).toEqual([]);
  });
});

describe("visibleTextHash", () => {
  const body =
    "Bonjour, votre facture Vexto est disponible. Réglez-la avant le 05/10 pour éviter la suspension de votre abonnement.";

  it("hashes one template alike across dates, case, spacing and links", () => {
    const other = body
      .replace("05/10", "07/10")
      .toUpperCase()
      .replace(" ", "   ")
      .concat(" https://vexto-cadeaux.example/x?id=9");
    expect(visibleTextHash(other)).toBe(visibleTextHash(body));
    expect(visibleTextHash(body)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("has none for text too short to be a template", () => {
    expect(visibleTextHash("Test")).toBeNull();
  });
});

describe("messageFingerprints", () => {
  it("reads the sender, subject, links, phone numbers and text an email shows", () => {
    const prints = messageFingerprints({
      from: "Facture Vexto <factures@mail.vexto-cadeaux.example>",
      subject: "Votre facture Vexto du 02/10 est disponible",
      html: '<p>Bonjour, votre facture Vexto est disponible. Payez maintenant pour garder votre abonnement actif.</p><a href="https://pay.vextos-cadeaux.example/p">Payer</a><p>Questions : +33 1 23 45 67 89</p><div style="display:none">0800 555 0199 caché</div>',
      text: null,
    });
    expect(prints.filter((p) => p.kind !== "text_hash")).toEqual([
      { kind: "display_name", value: "Facture Vexto" },
      { kind: "sending_domain", value: "mail.vexto-cadeaux.example" },
      { kind: "subject", value: "Votre facture Vexto du 02/10 est disponible" },
      { kind: "link_domain", value: "vextos-cadeaux.example" },
      { kind: "phone", value: "123456789" },
    ]);
    expect(prints.some((p) => p.kind === "text_hash")).toBe(true);
  });

  it("matches like with like only", () => {
    expect(
      fingerprintsMatch(
        { kind: "display_name", value: "Facture Vexto" },
        { kind: "subject", value: "Facture Vexto" },
      ),
    ).toBe(false);
    expect(
      fingerprintsMatch({ kind: "ip", value: "203.0.113.9" }, { kind: "ip", value: "203.0.113.9" }),
    ).toBe(true);
  });
});
