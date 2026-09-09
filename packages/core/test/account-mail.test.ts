import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { describe, expect, it } from "vitest";
import { en } from "../src/account-mail/en.js";
import { ptBR } from "../src/account-mail/pt-BR.js";
import {
  ACCOUNT_MAIL_KINDS,
  type AccountMailEntry,
  accountMailPhrase,
  buildAccountMail,
  formatMailDate,
  MAIL_LOCALES,
  planCapPhrase,
} from "../src/account-mail.js";
import { accountMailCard } from "../src/html.js";
import { listTeamOwners } from "../src/notifications.js";

const VALUES: Record<string, string> = Object.fromEntries(
  [
    "name",
    "email",
    "app",
    "team",
    "scopes",
    "actor",
    "prefix",
    "last4",
    "permission",
    "scope",
    "url",
    "host",
    "until",
    "role",
    "domain",
    "subject",
    "count",
    "parked",
    "sent",
    "limit",
    "resetsAt",
    "region",
    "plan",
    "retry",
    "cap",
    "freeCap",
    "billingUrl",
    "old",
    "new",
    "date",
    "docsUrl",
  ].map((key) => [key, `[${key}]`]),
);

describe("account mail catalogs", () => {
  it("render every kind in every language with no placeholder left", () => {
    for (const locale of MAIL_LOCALES) {
      for (const kind of ACCOUNT_MAIL_KINDS) {
        const mail = buildAccountMail({
          kind,
          locale,
          url: "https://app.example/x",
          values: VALUES,
        });
        expect(mail.subject, `${locale} ${kind}`).not.toMatch(/\{\w+\}/);
        expect(mail.text, `${locale} ${kind}`).not.toMatch(/\{\w+\}/);
        expect(mail.html, `${locale} ${kind}`).toContain("https://app.example/x");
      }
    }
  });

  it("carries the same slots in pt-BR as in en, entry by entry", () => {
    const slots = (s: string) => [...s.matchAll(/\{\w+\}/g)].map((m) => m[0]).sort();
    for (const kind of ACCOUNT_MAIL_KINDS) {
      const a: AccountMailEntry = en[kind];
      const b: AccountMailEntry = ptBR[kind];
      expect(slots(b.subject), `${kind} subject`).toEqual(slots(a.subject));
      expect(slots(b.body.join(" ")), `${kind} body`).toEqual(slots(a.body.join(" ")));
      expect(Object.keys(b.extra ?? {}).sort(), `${kind} extra`).toEqual(
        Object.keys(a.extra ?? {}).sort(),
      );
    }
  });

  it("escapes what the values carry", () => {
    const mail = buildAccountMail({
      kind: "member.joined",
      locale: "en",
      url: "https://app.example/settings",
      values: { ...VALUES, team: "<b>Acme</b>" },
    });
    expect(mail.html).toContain("&lt;b&gt;Acme&lt;/b&gt;");
    expect(mail.html).not.toContain("<b>Acme</b>");
    expect(mail.text).toContain("<b>Acme</b>");
  });

  it("fills a phrase from an entry's extras", () => {
    expect(
      accountMailPhrase({
        locale: "pt-BR",
        kind: "billing.payment_failed",
        key: "retryOn",
        values: { date: "1 de outubro" },
      }),
    ).toBe("A Stripe tenta de novo em 1 de outubro.");
  });
});

describe("accountMailCard", () => {
  it("names the button in the text version when there is no link fallback", () => {
    const card = accountMailCard({
      paragraphs: ["Hello"],
      button: "Open",
      url: "https://app.example/x",
      muted: ["Bye"],
    });
    expect(card.text).toBe("Hello\n\nOpen: https://app.example/x\n\nBye\n");
    expect(card.html).not.toContain("word-break:break-all");
  });

  it("prints the bare link when a fallback line is given", () => {
    const card = accountMailCard({
      paragraphs: ["Hello"],
      button: "Open",
      url: "https://app.example/x",
      linkFallback: "Or paste this:",
      muted: [],
    });
    expect(card.text).toBe("Hello\n\nhttps://app.example/x\n\n\n");
    expect(card.html).toContain("Or paste this:<br>");
  });
});

describe("listTeamOwners", () => {
  it("reads each owner's language off their contact in the account-mail team, English otherwise", async () => {
    const { db, close } = await createTestDb();
    try {
      const teamId = await createTeam(db, "acme");
      const home = await createTeam(db, "home");
      await db.insert(schema.domains).values({
        teamId: home,
        name: "mail.example.com",
        region: "us-east-1",
        status: "verified",
      });
      await db.insert(schema.user).values([
        { id: "u1", name: "Ana", email: "Ana@example.com" },
        { id: "u2", name: "Bob", email: "bob@example.com" },
        { id: "u3", name: "Cid", email: "cid@example.com" },
      ]);
      await db.insert(schema.teamMembers).values([
        { teamId, userId: "u1", role: "owner" },
        { teamId, userId: "u2", role: "owner" },
        { teamId, userId: "u3", role: "member" },
      ]);
      await db.insert(schema.contacts).values([
        { teamId: home, email: "ana@example.com", properties: { locale: "pt-BR" } },
        { teamId: home, email: "bob@example.com", properties: { locale: "xx" } },
      ]);
      const owners = await listTeamOwners(db, teamId, "MillionSend <account@mail.example.com>");
      expect(owners.map((o) => [o.email, o.locale]).sort()).toEqual([
        ["Ana@example.com", "pt-BR"],
        ["bob@example.com", "en"],
      ]);
      // No sender, or a sender no team holds: nothing to read, English.
      expect((await listTeamOwners(db, teamId)).map((o) => o.locale)).toEqual(["en", "en"]);
      expect(
        (await listTeamOwners(db, teamId, "x@nobody.example.com")).map((o) => o.locale),
      ).toEqual(["en", "en"]);
    } finally {
      await close();
    }
  });
});

describe("billing phrases", () => {
  it("say a plan's cap as a clause and a date on its UTC day, each in the reader's language", () => {
    expect(planCapPhrase("en", "pro")).toBe("up to 3,000 emails a day");
    expect(planCapPhrase("pt-BR", "pro")).toBe("até 3.000 e-mails por dia");
    expect(planCapPhrase("en", "scale")).toBe("with no daily cap");
    expect(planCapPhrase("pt-BR", "scale")).toBe("sem limite diário");
    const lateUtc = new Date("2026-09-30T23:30:00Z");
    expect(formatMailDate("en", lateUtc)).toBe("September 30, 2026");
    expect(formatMailDate("pt-BR", lateUtc)).toBe("30 de setembro de 2026");
  });
});
