import { autoLinks, LURE_NAMES, mailLinks, readable } from "@millionsend/test-utils";
import { describe, expect, it } from "vitest";
import { en } from "../src/account-mail/en.js";
import { ptBR } from "../src/account-mail/pt-BR.js";
import {
  ACCOUNT_MAIL_KINDS,
  type AccountMailEntry,
  accountMailPhrase,
  buildAccountMail,
  MAIL_LOCALES,
} from "../src/account-mail.js";
import { CUSTOMER_SLOTS, CUSTOMER_TEXT_MAX, inertText, isPlainName } from "../src/customer-text.js";

const HIDDEN = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/u;
const slots = (template: string) => [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? "");

describe("inertText", () => {
  it("leaves no link, invisible character or line break in any lure, and caps its length", () => {
    for (const lure of LURE_NAMES) {
      const inert = inertText(lure);
      expect(autoLinks(inert), lure).toEqual([]);
      expect(inert, lure).not.toMatch(HIDDEN);
      expect([...new Intl.Segmenter().segment(readable(inert))].length, lure).toBeLessThanOrEqual(
        CUSTOMER_TEXT_MAX,
      );
    }
    // The lures carry live links before the helper runs.
    expect(LURE_NAMES.filter((lure) => autoLinks(lure).length > 0).length).toBeGreaterThan(8);
  });

  it("keeps a name that looks like a domain readable, as one line", () => {
    expect(readable(inertText("acme.dev"))).toBe("acme.dev");
    expect(autoLinks(inertText("acme.dev"))).toEqual([]);
    expect(inertText("Acme\n\nInc.")).toBe("Acme Inc.\u200a");
    expect(readable(inertText("ａｃｍｅ．dev"))).toBe("ａｃｍｅ.dev");
    expect(inertText("Café Ünïcode™")).toBe("Café Ünïcode™");
  });

  it("prints no phone number a mail app would dial, and keeps shorter numbers", () => {
    expect(inertText("Account locked? Call +1 (888) 555-0199")).toBe(
      "Account locked? Call +1 (888) •••-••••",
    );
    expect(inertText("Acme 2026 Q4, order 123456")).toBe("Acme 2026 Q4, order 123456");
  });

  it("cuts on a whole character and marks the cut", () => {
    const long = `${"🙂".repeat(CUSTOMER_TEXT_MAX)}x`;
    expect(inertText(long)).toBe(`${"🙂".repeat(CUSTOMER_TEXT_MAX - 1)}…`);
    expect(inertText("x".repeat(CUSTOMER_TEXT_MAX))).toBe("x".repeat(CUSTOMER_TEXT_MAX));
    // One letter under hundreds of combining marks is a single character.
    expect(inertText(`Z${"\u0336".repeat(500)}algo`)).toBe(`Z${"\u0336".repeat(4)}algo`);
  });
});

describe("isPlainName", () => {
  it("accepts ordinary names, a domain-like one included", () => {
    for (const name of [
      "Acme",
      "acme.dev",
      "Acme Data: Sales",
      "Café Ünïcode™",
      "O'Brien & Sons",
    ]) {
      expect(isPlainName(name), name).toBe(true);
    }
    expect(isPlainName("x".repeat(CUSTOMER_TEXT_MAX))).toBe(true);
  });

  it("refuses links, addresses, invisible characters, line breaks and overlong names", () => {
    for (const name of [
      "https://acme-support.com",
      "Visit http://x.co",
      "mailto:billing",
      "tel:+18005550100",
      "javascript:alert(1)",
      "ｈｔｔｐｓ：／／acme-support.com",
      "billing@acme-support.com",
      "Acme ＠ support",
      "Acme\nVisit us",
      "Acme\tInc",
      "acme-sup\u200bport",
      "\u202emoc.troppus\u202c",
      "Acme\u2066Inc",
      "x".repeat(CUSTOMER_TEXT_MAX + 1),
    ]) {
      expect(isPlainName(name), JSON.stringify(name)).toBe(false);
    }
  });
});

describe("system mail catalogs and customer text", () => {
  const entries: [string, AccountMailEntry][] = [
    ...Object.entries(en).map(([k, v]): [string, AccountMailEntry] => [`en ${k}`, v]),
    ...Object.entries(ptBR).map(([k, v]): [string, AccountMailEntry] => [`pt-BR ${k}`, v]),
  ];

  it("names no customer slot in any subject", () => {
    for (const [where, entry] of entries) {
      expect(
        slots(entry.subject).filter((slot) => CUSTOMER_SLOTS.has(slot)),
        where,
      ).toEqual([]);
    }
  });

  it("prints every lure in every slot of every kind with no link but the button's", () => {
    const allSlots = new Set(
      entries.flatMap(([, e]) =>
        [
          e.subject,
          ...e.body,
          e.button,
          ...(e.muted ?? []),
          ...Object.values(e.extra ?? {}),
        ].flatMap(slots),
      ),
    );
    const url = "https://app.example/x";
    for (const lure of LURE_NAMES) {
      const values = Object.fromEntries(
        [...allSlots].map((slot) => [slot, CUSTOMER_SLOTS.has(slot) ? lure : `[${slot}]`]),
      );
      for (const locale of MAIL_LOCALES) {
        for (const kind of ACCOUNT_MAIL_KINDS) {
          const mail = buildAccountMail({ kind, locale, url, values });
          const where = `${locale} ${kind} ${JSON.stringify(lure)}`;
          expect(
            mailLinks(mail).filter((link) => link !== url && link !== "https://millionsend.com"),
            where,
          ).toEqual([]);
          expect(`${mail.subject}${mail.html}${mail.text}`, where).not.toMatch(
            /mailto:\S|[\u202a-\u202e\u2066-\u2069\u200b]/i,
          );
        }
      }
    }
  });

  it("fills the customer slots of every phrase a caller passes back in inert", () => {
    for (const lure of LURE_NAMES) {
      const values = Object.fromEntries([...CUSTOMER_SLOTS].map((slot) => [slot, lure]));
      for (const locale of MAIL_LOCALES) {
        for (const kind of ACCOUNT_MAIL_KINDS) {
          const entry: AccountMailEntry = (locale === "en" ? en : ptBR)[kind];
          for (const key of Object.keys(entry.extra ?? {})) {
            const phrase = accountMailPhrase({ locale, kind, key, values });
            expect(autoLinks(phrase), `${locale} ${kind} ${key} ${JSON.stringify(lure)}`).toEqual(
              [],
            );
          }
        }
      }
    }
  });

  it("reads a domain-like team name as written", () => {
    const mail = buildAccountMail({
      kind: "member.joined",
      locale: "en",
      url: "https://app.example/settings",
      values: { team: "acme.dev", name: "Ana", email: "ana@acme.dev", role: "a member" },
    });
    expect(mail.subject).toBe("A new member joined your team");
    expect(readable(mail.text)).toContain("Ana (ana@acme.dev) accepted the invitation");
    expect(readable(mail.text)).toContain("a member of acme.dev.");
    expect(readable(mail.html)).toContain("a member of acme.dev.");
    expect(mailLinks(mail).sort()).toEqual(
      ["https://app.example/settings", "https://millionsend.com"].sort(),
    );
  });
});
