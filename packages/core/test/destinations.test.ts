import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyJudgedSample, recordMonitorSample } from "../src/abuse-monitor.js";
import type { DomainAge, DomainAgeResolver } from "../src/domain-age.js";
import { MONITOR_SETTING_DEFAULTS } from "../src/monitor-settings.js";
import {
  anyYoungLinkDomain,
  clearDestinations,
  destinationVerdictParks,
  isShortener,
  messageDestinations,
  teamNovelDestinations,
  unclearedDestinations,
} from "../src/screening.js";
import { DAY_MS } from "../src/utc-day.js";

const S = MONITOR_SETTING_DEFAULTS;
const NOW = new Date("2026-10-11T12:00:00Z");

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

describe("a message's destinations", () => {
  it("are the owner domains of its links and Reply-To, less the team's own and the platform's", () => {
    expect(
      messageDestinations({
        html: [
          '<a href="https://www.acme.com.br/conta">own site</a>',
          '<a href="https://login.evil-pay.com/x?y=1">pay</a>',
          '<a href="https://shop.pages.dev/">free host</a>',
          '<a href="https://other.pages.dev/">another on it</a>',
          '<a href="mailto:help@acme.com.br">mail</a>',
          '<a href="https://app.millionsend.com/unsubscribe/t">unsubscribe</a>',
          '<a href="/relative">relative</a>',
        ].join(""),
        text: "Or open https://bit.ly/abc today.",
        replyTo: ["Support <help@reply-desk.io>"],
        verifiedDomains: ["mail.acme.com.br"],
        ignore: new Set(["millionsend.com"]),
      }),
    ).toEqual(["bit.ly", "evil-pay.com", "other.pages.dev", "reply-desk.io", "shop.pages.dev"]);
  });

  it("are none for mail that links only to the team's verified domains", () => {
    expect(
      messageDestinations({
        html: '<a href="https://acme.dev/login">Log in</a> <a href="https://help.acme.dev">Help</a>',
        text: "https://acme.dev/reset",
        replyTo: ["Acme <support@acme.dev>"],
        verifiedDomains: ["acme.dev"],
      }),
    ).toEqual([]);
  });
});

describe("a message's destinations, read as the judge reads its links", () => {
  it("follow a known redirect wrapper to where it leads", () => {
    expect(
      messageDestinations({
        html: [
          '<a href="https://www.google.com/url?q=https://evil-pay.com/login&amp;sa=D">a</a>',
          '<a href="https://eur01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fsecure-update.net%2Fx&data=1">b</a>',
          '<a href="https://www.google.com/maps">a plain Google link</a>',
        ].join(""),
        text: "Also https://l.facebook.com/l.php?u=https%3A%2F%2Fpix-promo.com%2Fy",
        replyTo: null,
        verifiedDomains: ["acme.dev"],
      }),
    ).toEqual(["evil-pay.com", "google.com", "pix-promo.com", "secure-update.net"]);
  });

  it("are none for a team on tx.acme.com.br linking and replying to acme.com.br", () => {
    expect(
      messageDestinations({
        html: [
          '<a href="https://acme.com.br/pagar">pay</a>',
          '<a href="https://www.acme.com.br/conta">account</a>',
          '<a href="https://app.acme.com.br/">app</a>',
        ].join(""),
        text: "https://acme.com.br/ajuda",
        replyTo: ["Acme <contato@acme.com.br>", "suporte@tx.acme.com.br"],
        verifiedDomains: ["tx.acme.com.br"],
      }),
    ).toEqual([]);
    // One owner holds a free host's name only: its neighbours stay new.
    expect(
      messageDestinations({
        html: '<a href="https://foo.github.io/a">own</a><a href="https://bar.github.io/b">other</a>',
        text: null,
        replyTo: null,
        verifiedDomains: ["foo.github.io"],
      }),
    ).toEqual(["bar.github.io"]);
  });
});

describe("the destination registry", () => {
  it("clears a destination for good, never a shortener", async () => {
    const teamId = await createTeam(db, "registry");
    await clearDestinations(db, teamId, ["evil-pay.com", "bit.ly", "t.co"], NOW);
    expect(
      await unclearedDestinations(db, teamId, ["evil-pay.com", "bit.ly", "new.example"]),
    ).toEqual(["bit.ly", "new.example"]);
    expect(isShortener("go.bit.ly")).toBe(true);
    // Per team: another team has cleared nothing.
    const other = await createTeam(db, "registry-other");
    expect(await unclearedDestinations(db, other, ["evil-pay.com"])).toEqual(["evil-pay.com"]);
    const rows = await db
      .select()
      .from(schema.teamDestinations)
      .where(eq(schema.teamDestinations.teamId, teamId));
    expect(rows.map((r) => r.domain)).toEqual(["evil-pay.com"]);
  });

  it("reads the team's verified domains as its own", async () => {
    const teamId = await createTeam(db, "registry-own");
    await db
      .insert(schema.domains)
      .values({ teamId, name: "acme.dev", region: "us-east-1", status: "verified" });
    expect(
      await teamNovelDestinations(db, {
        teamId,
        html: '<a href="https://acme.dev">a</a><a href="https://new.example">b</a>',
        text: null,
        replyTo: null,
      }),
    ).toEqual(["new.example"]);
  });
});

describe("what a verdict on a new destination does", () => {
  const verdict = (score: number, linkYoung: boolean | null) => ({
    score,
    verdict: "abuse",
    categories: ["phishing_credentials"],
    reasons: [],
    linkYoung,
  });

  it("parks a team past new's mail on 90, or on 80 with a link domain under 7 days old or of an age not known", () => {
    expect(destinationVerdictParks(verdict(91, null), S)).toBe(true);
    expect(destinationVerdictParks(verdict(84, true), S)).toBe(true);
    expect(destinationVerdictParks(verdict(84, false), S)).toBe(false);
    expect(destinationVerdictParks(verdict(84, null), S)).toBe(true);
    expect(destinationVerdictParks(verdict(79, null), S)).toBe(false);
    expect(destinationVerdictParks({ ...verdict(95, true), categories: ["spam"] }, S)).toBe(false);
  });

  it("holds a new team on one phishing verdict from 80 linking to a young domain", async () => {
    const teamId = await createTeam(db, "young-link");
    await db.insert(schema.teamMonitor).values({ teamId, sentTotal: 1, firstSendAt: NOW });
    expect(
      await applyJudgedSample(db, S, {
        teamId,
        score: 82,
        verdict: { verdict: "abuse", categories: ["phishing_credentials"], reasons: [] },
        youngLinkDomain: true,
        now: NOW,
      }),
    ).toMatchObject({ held: { rule: "young_link" } });
  });

  it("never caps a screening sample, and counts only after-send draws toward the caps", async () => {
    const teamId = await createTeam(db, "capped");
    const capped = { ...S, teamDailyCap: 1, instanceDailyCap: 1_000 };
    const deps = {
      samplingKey: Buffer.alloc(32),
      settings: async () => capped,
      enqueueJudge: async () => {},
    };
    const draw = (kind: "tier" | "destination" | "first_sends", flags = {}) =>
      recordMonitorSample(db, deps, capped, {
        teamId,
        emailId: null,
        broadcastId: null,
        kind,
        now: NOW,
        ...flags,
      });
    // Screening samples, however many, leave the team's cap untouched.
    for (const kind of ["first_sends", "destination"] as const) {
      expect(await draw(kind, { screening: true })).not.toBeNull();
    }
    expect(await draw("tier")).not.toBeNull();
    expect(await draw("tier")).toBeNull();
    // Past it, mail waiting on a verdict is still judged; so is a probation draw.
    expect(await draw("first_sends", { screening: true })).not.toBeNull();
    expect(await draw("destination", { novelty: true })).not.toBeNull();
  });
});

describe("link domain ages", () => {
  function resolver(ages: Record<string, Date | null>, delayMs = 0) {
    const asked: string[] = [];
    const r: DomainAgeResolver = {
      async lookup(hostname): Promise<DomainAge> {
        asked.push(hostname);
        if (delayMs) await new Promise((done) => setTimeout(done, delayMs));
        const registeredAt = ages[hostname] ?? null;
        return { domain: hostname, registeredAt, source: registeredAt ? "rdap" : "unknown" };
      },
    };
    return { r, asked };
  }

  it("reads a link domain under 7 days old as young, through a cache every team shares", async () => {
    const { r, asked } = resolver({
      "fresh-lure.com": new Date(NOW.getTime() - 2 * DAY_MS),
      "old-shop.com": new Date(NOW.getTime() - 900 * DAY_MS),
    });
    expect(await anyYoungLinkDomain(db, r, ["old-shop.com"], NOW, { budgetMs: 1000 })).toBe(false);
    expect(
      await anyYoungLinkDomain(db, r, ["old-shop.com", "fresh-lure.com"], NOW, { budgetMs: 1000 }),
    ).toBe(true);
    // Both are cached now: asked once each, whoever asks next.
    expect(await anyYoungLinkDomain(db, r, ["fresh-lure.com"], NOW, { budgetMs: 1000 })).toBe(true);
    expect(asked).toEqual(["old-shop.com", "fresh-lure.com"]);
  });

  it("never dates a free host's names or a shortener, and counts an unknown age as not young", async () => {
    const { r, asked } = resolver({});
    expect(
      await anyYoungLinkDomain(db, r, ["shop.pages.dev", "bit.ly", "no-date.de"], NOW, {
        budgetMs: 1000,
      }),
    ).toBe(false);
    expect(asked).toEqual(["no-date.de"]);
  });

  it("stops waiting at its budget with the age not known, and the lookup still fills the cache", async () => {
    const { r } = resolver({ "slow-lure.com": new Date(NOW.getTime() - DAY_MS) }, 200);
    expect(await anyYoungLinkDomain(db, r, ["slow-lure.com"], NOW, { budgetMs: 20 })).toBeNull();
    await new Promise((done) => setTimeout(done, 300));
    const [cached] = await db
      .select()
      .from(schema.linkDomainAges)
      .where(eq(schema.linkDomainAges.domain, "slow-lure.com"));
    expect(cached?.registeredAt).toEqual(new Date(NOW.getTime() - DAY_MS));
  });
});
