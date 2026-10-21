import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MONITOR_TIERS } from "../src/abuse-monitor.js";
import { en } from "../src/account-mail/en.js";
import { ptBR } from "../src/account-mail/pt-BR.js";
import {
  ACCOUNT_MAIL_KINDS,
  type AccountMailEntry,
  accountMailPhrase,
  buildAccountMail,
  formatMailDate,
  MAIL_LOCALES,
  mailCountList,
  planCapPhrase,
  planMove,
} from "../src/account-mail.js";
import { accountMailCard } from "../src/html.js";
import { mailPreferenceOf } from "../src/mail-preferences.js";
import { accountLocale, listTeamOwners } from "../src/notifications.js";
import type { SystemMailKind } from "../src/system-mail.js";

const VALUES: Record<string, string> = Object.fromEntries(
  [...Object.values(en), ...Object.values(ptBR)]
    .flatMap((e: AccountMailEntry) => [
      e.subject,
      e.heading ?? "",
      ...e.body,
      e.button,
      ...(e.muted ?? []),
      ...Object.values(e.extra ?? {}),
    ])
    .flatMap((s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string))
    .map((key) => [key, `[${key}]`]),
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

  it("has no mail for an operator's content access, in any language", () => {
    for (const kinds of [[...ACCOUNT_MAIL_KINDS], Object.keys(en), Object.keys(ptBR)]) {
      expect(kinds.filter((kind) => kind.startsWith("content."))).toEqual([]);
    }
  });

  it("carries the same slots in pt-BR as in en, entry by entry", () => {
    const slots = (s: string) => [...s.matchAll(/\{\w+\}/g)].map((m) => m[0]).sort();
    for (const kind of ACCOUNT_MAIL_KINDS) {
      const a: AccountMailEntry = en[kind];
      const b: AccountMailEntry = ptBR[kind];
      expect(slots(b.subject), `${kind} subject`).toEqual(slots(a.subject));
      expect(slots(b.heading ?? ""), `${kind} heading`).toEqual(slots(a.heading ?? ""));
      expect(slots(b.body.join(" ")), `${kind} body`).toEqual(slots(a.body.join(" ")));
      expect(Object.keys(b.extra ?? {}).sort(), `${kind} extra`).toEqual(
        Object.keys(a.extra ?? {}).sort(),
      );
      for (const key of Object.keys(a.extra ?? {})) {
        expect(slots(b.extra?.[key] ?? ""), `${kind} extra ${key}`).toEqual(
          slots(a.extra?.[key] ?? ""),
        );
      }
    }
  });

  it("billing mail promises no sending: it also reaches teams whose sending is suspended", () => {
    const promise =
      /keeps? sending|now sends|\[team\] sends|released within minutes|continuar? enviando|agora envia|\[team\] envia|liberado em minutos/i;
    for (const locale of MAIL_LOCALES) {
      for (const kind of ACCOUNT_MAIL_KINDS.filter((k) => k.startsWith("billing."))) {
        const mail = buildAccountMail({
          kind,
          locale,
          url: "https://app.example/x",
          values: VALUES,
        });
        expect(mail.text, `${locale} ${kind}`).not.toMatch(promise);
      }
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
    ).toBe("O Stripe tenta de novo em 1 de outubro.");
  });

  it("lists counts in either language, singular for one, zeros left out", () => {
    expect(mailCountList("en", "inbox.attention", { quarantined: 1, drafts: 0, refused: 2 })).toBe(
      "1 email in quarantine and 2 sends refused by your inbox rules",
    );
    expect(
      mailCountList("pt-BR", "inbox.attention", { quarantined: 1000, drafts: 1, refused: 1 }),
    ).toBe(
      "1.000 e-mails em quarentena, 1 rascunho aguardando aprovação e 1 envio barrado pelas regras das suas caixas",
    );
  });

  it("names every monitor tier in the operator's language, never by its key", () => {
    for (const locale of MAIL_LOCALES) {
      for (const tier of MONITOR_TIERS) {
        expect(accountMailPhrase({ locale, kind: "monitor.alert", key: tier }), tier).toBeTruthy();
      }
    }
    const alert = buildAccountMail({
      kind: "monitor.alert",
      locale: "pt-BR",
      url: "https://app.example/console/safety/t",
      values: {
        ...VALUES,
        tier: accountMailPhrase({ locale: "pt-BR", kind: "monitor.alert", key: "probation" }),
      },
    });
    expect(alert.text).toContain("(nível em observação,");
    expect(alert.text).not.toContain("probation");
  });
});

describe("new domain limit mail", () => {
  const verified = (values: Record<string, string>) =>
    buildAccountMail({
      kind: "domain.verified",
      locale: "en",
      url: "https://app.example/domains/d",
      values: { domain: "nova.example", limit: "", moving: "", ...values },
    });

  it("leaves a paragraph out when its slot is passed empty", () => {
    const mail = verified({});
    expect(mail.text.split("\n\n").slice(0, 2)).toEqual([
      "The DNS records for nova.\u200aexample check out. It can send from any address on it, through the API, SMTP and broadcasts.",
      "We keep re-checking the records and will tell you if one disappears.",
    ]);
    expect(mail.html).not.toMatch(/<p[^>]*><\/p>/);
  });

  it("tells a young domain's limit in the verified mail, with or without a date", () => {
    const phrase = (key: string, values: Record<string, string> = {}) =>
      accountMailPhrase({ locale: "en", kind: "domain.verified", key, values });
    const dated = verified({
      limit: phrase("limit", { perDay: "300", date: "November 16, 2026" }),
      moving: phrase("moving"),
    });
    expect(dated.text).toContain(
      "It was registered recently, so it starts with a daily limit: up to 300 emails today, more each day, and no limit from November 16, 2026. Mail over the day's limit waits and goes out the next day, on its own.\n\nMoving mail you already send elsewhere to this domain? Reply to this email before you switch and we'll take a look.",
    );
    expect(phrase("limitUnknownAge", { perDay: "300" })).toBe(
      "It starts with a daily limit of up to 300 emails for now, rising as it builds a sending history. Mail over the day's limit waits and goes out the next day, on its own.",
    );
  });

  it("leads the waiting mail with the count, in either language", () => {
    for (const [locale, n, heading] of [
      ["en", "1", "1 email waiting"],
      ["en", "214", "214 emails waiting"],
      ["pt-BR", "1.214", "1.214 e-mails esperando"],
    ] as const) {
      const mail = buildAccountMail({
        kind: "domain.waiting",
        locale,
        url: "https://app.example/emails",
        values: {
          ...VALUES,
          waiting: accountMailPhrase({
            locale,
            kind: "domain.waiting",
            key: n === "1" ? "waiting.one" : "waiting.other",
            values: { n },
          }),
        },
      });
      expect(mail.text.startsWith(`${heading}\n\n`), heading).toBe(true);
      expect(mail.html).toContain(`tabular-nums">${heading}</p>`);
    }
  });

  it("writes the new and reworded mail with no semicolons or em dashes", () => {
    const kinds = [
      "domain.verified",
      "domain.waiting",
      "domain.limit_lifted",
      "domain.limit_kept",
      "domain.limit_requested",
    ] as const;
    for (const catalog of [en, ptBR]) {
      const entries: AccountMailEntry[] = kinds.map((kind) => catalog[kind]);
      const copy = [
        ...entries.flatMap((e) => [
          e.subject,
          e.heading ?? "",
          ...e.body,
          e.button,
          ...(e.muted ?? []),
          ...Object.values(e.extra ?? {}),
        ]),
        catalog.welcome.body[1],
      ];
      for (const text of copy) expect(text).not.toMatch(/[;\u2014]/);
    }
    // No mechanics and no operator in what the team reads.
    for (const kind of kinds.filter((k) => k !== "domain.limit_requested")) {
      const mail = buildAccountMail({
        kind,
        locale: "en",
        url: "https://x.example",
        values: VALUES,
      });
      expect(mail.text, kind).not.toMatch(/tier|operator|trust/i);
    }
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

  it("leads with the heading and drops the button when there is no url", () => {
    const card = accountMailCard({ heading: "It works.", paragraphs: ["Hello"], muted: [] });
    expect(card.html).toContain(">It works.</p>");
    expect(card.html).not.toContain('class="ms-btn"');
    expect(card.text.startsWith("It works.\n\nHello")).toBe(true);
  });

  it("carries both wordmarks and the theme sheet", () => {
    const card = accountMailCard({
      paragraphs: ["Hello"],
      button: "Open",
      url: "https://x.y",
      muted: [],
    });
    expect(card.html).toContain("wordmark-ink.png");
    expect(card.html).toContain("wordmark-bone.png");
    expect(card.html).toContain("@media (prefers-color-scheme:dark)");
    expect(card.html).toContain("u + .body .ms-gmail");
  });
});

describe("listTeamOwners", () => {
  // The PGlite boot belongs in the hook: it has the long timeout, the test does not.
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(() => close());

  it("reads each owner's language off their contact in the account-mail team, English otherwise", async () => {
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
    expect((await listTeamOwners(db, teamId, "x@nobody.example.com")).map((o) => o.locale)).toEqual(
      ["en", "en"],
    );
  });

  it("prefers the account's stored language over its contact, with or without a sender team", async () => {
    const teamId = await createTeam(db, "stored");
    const home = await createTeam(db, "stored-home");
    await db.insert(schema.domains).values({
      teamId: home,
      name: "stored.example.com",
      region: "us-east-1",
      status: "verified",
    });
    await db.insert(schema.user).values([
      { id: "s1", name: "Sol", email: "sol@example.com", locale: "en" },
      { id: "s2", name: "Tia", email: "tia@example.com", locale: "pt-BR" },
    ]);
    await db.insert(schema.teamMembers).values([
      { teamId, userId: "s1", role: "owner" },
      { teamId, userId: "s2", role: "owner" },
    ]);
    await db
      .insert(schema.contacts)
      .values({ teamId: home, email: "sol@example.com", properties: { locale: "pt-BR" } });
    const sender = "MillionSend <account@stored.example.com>";
    const locales = async (from?: string) =>
      (await listTeamOwners(db, teamId, from)).map((o) => [o.email, o.locale]).sort();
    const expected = [
      ["sol@example.com", "en"],
      ["tia@example.com", "pt-BR"],
    ];
    expect(await locales(sender)).toEqual(expected);
    expect(await locales()).toEqual(expected);

    expect(await accountLocale(db, sender, "SOL@example.com")).toBe("en");
    expect(await accountLocale(db, undefined, "tia@example.com")).toBe("pt-BR");
    // Nothing stored anywhere: the caller's fallback, English by default.
    expect(await accountLocale(db, sender, "nobody@example.com", "pt-BR")).toBe("pt-BR");
    expect(await accountLocale(db, sender, "nobody@example.com")).toBe("en");
  });

  it("leaves out an owner who turned a notice off, never for mail that is always sent", async () => {
    const teamId = await createTeam(db, "quiet");
    await db.insert(schema.user).values({
      id: "q1",
      name: "Q",
      email: "q@example.com",
      mailOptOuts: ["broadcast.sent", "quota", "domain.lost"],
    });
    await db.insert(schema.teamMembers).values({ teamId, userId: "q1", role: "owner" });
    const emails = async (kind?: SystemMailKind) =>
      (await listTeamOwners(db, teamId, undefined, kind)).map((o) => o.email);
    expect(await emails()).toEqual(["q@example.com"]);
    expect(await emails("broadcast.sent")).toEqual([]);
    expect(await emails("quota.paused")).toEqual([]);
    expect(await emails("domain.lost.identity")).toEqual([]);
    expect(await emails("broadcast.held")).toEqual(["q@example.com"]);
    expect(await emails("api_key.created")).toEqual(["q@example.com"]);
  });
});

describe("billing phrases", () => {
  it("say a plan's cap as a clause and a date on its UTC day, each in the reader's language", () => {
    expect(planCapPhrase("en", "starter", null)).toBe("up to 1,500 emails a day");
    expect(planCapPhrase("pt-BR", "starter", null)).toBe("até 1.500 e-mails por dia");
    expect(planCapPhrase("en", "pro", 100_000)).toBe("up to 100,000 emails a month");
    expect(planCapPhrase("pt-BR", "pro", 100_000)).toBe("até 100.000 e-mails por mês");
    expect(planCapPhrase("en", "scale", 2_500_000)).toBe("up to 2,500,000 emails a month");
    expect(planCapPhrase("en", "system", null)).toBe("with no sending cap");
    expect(planCapPhrase("pt-BR", "system", null)).toBe("sem limite de envio");
    const lateUtc = new Date("2026-09-30T23:30:00Z");
    expect(formatMailDate("en", lateUtc)).toBe("September 30, 2026");
    expect(formatMailDate("pt-BR", lateUtc)).toBe("30 de setembro de 2026");
  });
});

describe("planMove", () => {
  const now = new Date("2026-09-08T12:00:00Z");
  const row = (
    plan: "free" | "pro" | "scale" | "system",
    periodEnd: string | null,
    cancelAt: string | null = null,
    planQuota: number | null = null,
  ) => ({
    plan,
    planQuota,
    currentPeriodEnd: periodEnd ? new Date(periodEnd) : null,
    cancelAt: cancelAt ? new Date(cancelAt) : null,
  });

  it("keys an activation and a change by the period the new plan starts, and a downgrade by the period that ended", () => {
    const up = planMove(row("free", null), row("pro", "2026-10-08T00:00:00Z", null, 100_000), now);
    expect(up?.kind).toBe("billing.plan_activated");
    expect(up?.periodKey).toBe("pro_100k:2026-10-08T00:00:00.000Z");
    expect(up?.values("en", "Acme")).toEqual({
      team: "Acme",
      plan: "Pro 100K",
      cap: "up to 100,000 emails a month",
    });
    const moved = planMove(
      row("pro", "2026-10-08T00:00:00Z", null, 100_000),
      row("scale", "2026-10-08T00:00:00Z", null, 500_000),
      now,
    );
    expect(moved?.kind).toBe("billing.plan_changed");
    expect(moved?.periodKey).toBe("pro_100k>scale_500k:2026-10-08T00:00:00.000Z");
    expect(moved?.values("pt-BR", "Acme")).toMatchObject({
      old: "Pro 100K",
      new: "Scale 500K",
      cap: "até 500.000 e-mails por mês",
    });
    // A step between rungs of one plan is a change like any other.
    const stepped = planMove(
      row("pro", "2026-10-08T00:00:00Z", null, 100_000),
      row("pro", "2026-10-08T00:00:00Z", null, 200_000),
      now,
    );
    expect(stepped?.kind).toBe("billing.plan_changed");
    expect(stepped?.periodKey).toBe("pro_100k>pro_200k:2026-10-08T00:00:00.000Z");
    expect(stepped?.values("en", "Acme")).toEqual({
      team: "Acme",
      old: "Pro 100K",
      new: "Pro 200K",
      cap: "up to 200,000 emails a month",
    });
    const down = planMove(row("pro", "2026-09-30T00:00:00Z"), row("free", null), now);
    expect(down?.kind).toBe("billing.downgraded");
    expect(down?.periodKey).toBe("2026-09-30T00:00:00.000Z");
    expect(planMove(row("pro", null), row("pro", null), now)).toBeNull();
  });

  it("says nothing about a move into or out of the system plan", () => {
    expect(
      planMove(row("scale", "2026-10-08T00:00:00Z", null, 500_000), row("system", null), now),
    ).toBeNull();
    expect(planMove(row("system", null), row("free", null), now)).toBeNull();
    expect(planMove(row("system", null), row("system", null), now)).toBeNull();
  });

  it("dates a downgrade at the earliest of the scheduled cancel, the period end and today", () => {
    const immediate = planMove(row("pro", "2026-09-30T00:00:00Z"), row("free", null), now);
    expect(immediate?.values("en", "Acme").date).toBe("September 8, 2026");
    const scheduled = planMove(
      row("pro", "2026-09-30T00:00:00Z", "2026-09-01T00:00:00Z"),
      row("free", null),
      now,
    );
    expect(scheduled?.values("en", "Acme").date).toBe("September 1, 2026");
    const lapsed = planMove(
      row("scale", "2026-08-30T00:00:00Z"),
      row("free", "2026-08-30T00:00:00Z"),
      now,
    );
    expect(lapsed?.values("pt-BR", "Acme")).toMatchObject({
      plan: "Scale 500K",
      date: "30 de agosto de 2026",
      freeCap: "100",
    });
  });
});

describe("mailPreferenceOf", () => {
  it("folds severity steps and the identity variant into one switch, and names none for mail that is always sent", () => {
    expect(mailPreferenceOf("quota.warning")).toBe("quota");
    expect(mailPreferenceOf("deliverability.paused")).toBe("deliverability");
    expect(mailPreferenceOf("domain.lost.identity")).toBe("domain.lost");
    expect(mailPreferenceOf("billing.downgraded")).toBe("billing.downgraded");
    expect(mailPreferenceOf("domain.waiting")).toBe("domain.waiting");
    const always = [
      "domain.limit_lifted",
      "domain.limit_kept",
      "welcome",
      "password_changed",
      "mcp.connected",
      "api_key.created",
      "webhook.secret_rotated",
      "password_reset",
      "region.paused",
    ] as const;
    for (const kind of always) expect(mailPreferenceOf(kind), kind).toBeNull();
  });
});
