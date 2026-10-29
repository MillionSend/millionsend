import { randomBytes, randomUUID } from "node:crypto";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordSignup } from "../src/account-signups.js";
import {
  forgetAbuseRecords,
  linkTeam,
  purgeCampaignFingerprints,
  recordMissingFingerprints,
  recordPhishingFingerprints,
} from "../src/campaign-linkage.js";
import { encryptEmailBody } from "../src/crypto/envelope.js";
import { EnvKeyring } from "../src/crypto/keyring.js";
import { purgedEmailBodyColumns } from "../src/email-retention.js";
import { storeReferenceData } from "../src/reference-data.js";
import { sendRefusal, suspendTeam } from "../src/team-standing.js";
import { DAY_MS } from "../src/utc-day.js";
import { writeMmdb } from "./fixtures/mmdb.js";

const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
const sources = { keyring: () => keyring, cards: async () => ["card_fp_stolen"] };

let db: Db;
let close: () => Promise<void>;
let phisher: string;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  phisher = await phishingTeam();
});
afterEach(() => {
  vi.unstubAllEnvs();
  return close();
});

async function person(teamId: string, email: string, ip: string | null) {
  const id = randomUUID();
  await db.insert(schema.user).values({ id, name: "Person", email });
  await db.insert(schema.teamMembers).values({ teamId, userId: id, role: "owner" });
  await recordSignup(db, { userId: id, email, ip, userAgent: "Firefox" });
  return id;
}

async function domain(teamId: string, name: string, status: "pending" | "verified" = "pending") {
  await db.insert(schema.domains).values({
    teamId,
    name,
    status,
    region: "us-east-1",
    dkimSelector: "ms",
    dkimPublicKey: "key",
  });
}

async function storedEmail(teamId: string, from: string, subject: string, html: string) {
  const id = randomUUID();
  const body = await encryptEmailBody({ html, text: null }, keyring, { teamId, rowId: id });
  await db.insert(schema.emails).values({
    id,
    teamId,
    from,
    to: ["victime@example.org"],
    subject,
    bodyCiphertext: body.ciphertext,
    bodyIv: body.iv,
    bodyWrappedDek: body.wrappedDek,
    bodyKeyVersion: body.keyVersion,
  });
}

/** A team suspended for phishing, as its suspension found it. */
async function phishingTeam(): Promise<string> {
  const teamId = await createTeam(db, "facture-vexto");
  await db
    .update(schema.teams)
    .set({ stripeCustomerId: "cus_phisher" })
    .where(eq(schema.teams.id, teamId));
  await person(teamId, "facture.vexto+fr@gmail.com", "203.0.113.9");
  await domain(teamId, "vexto-cadeaux.example", "verified");
  await storedEmail(
    teamId,
    "Facture Vexto <factures@vexto-cadeaux.example>",
    "Votre facture Vexto du 02/10 est disponible",
    '<p>Bonjour, votre facture Vexto est disponible. Payez maintenant pour garder votre abonnement actif.</p><p><a href="https://vextos-cadeaux.example/payer">Payer</a> ou appelez le +33 1 23 45 67 89</p>',
  );
  return teamId;
}

async function suspendForPhishing(teamId: string, at?: Date) {
  await suspendTeam(db, { teamId, reason: "phishing", now: at });
  return recordPhishingFingerprints(db, { teamId, reason: "phishing" }, sources);
}

async function printsOf(teamId: string) {
  const rows = await db
    .select({ kind: schema.campaignFingerprints.kind, value: schema.campaignFingerprints.value })
    .from(schema.campaignFingerprints)
    .where(eq(schema.campaignFingerprints.teamId, teamId));
  return (kind: string) =>
    rows
      .filter((p) => p.kind === kind)
      .map((p) => p.value)
      .sort();
}

async function standing(teamId: string) {
  const [team] = await db
    .select({ suspendedAt: schema.teams.suspendedAt, reason: schema.teams.suspensionReason })
    .from(schema.teams)
    .where(eq(schema.teams.id, teamId));
  const [flag] = await db
    .select({ reason: schema.teamFlags.reason, detail: schema.teamFlags.detail })
    .from(schema.teamFlags)
    .where(and(eq(schema.teamFlags.teamId, teamId), eq(schema.teamFlags.status, "open")));
  return { reason: team?.suspendedAt ? team.reason : null, flag: flag ?? null };
}

async function linkRows(teamId: string) {
  return db
    .select({
      held: schema.teamLinks.held,
      trigger: schema.teamLinks.trigger,
      alertedAt: schema.teamLinks.alertedAt,
      kinds: schema.teamLinks.matches,
    })
    .from(schema.teamLinks)
    .where(eq(schema.teamLinks.teamId, teamId));
}

const sendOf = (from: string, subject: string, html = "<p>Bonjour</p>") => ({
  from,
  subject,
  html,
  text: null,
});

describe("recordPhishingFingerprints", () => {
  it("keeps what a team suspended for phishing leaves, its stored mail read through the keyring", async () => {
    await suspendTeam(db, { teamId: phisher, reason: "manual" });
    expect(
      await recordPhishingFingerprints(db, { teamId: phisher, reason: "manual" }, sources),
    ).toBe(0);
    expect(await suspendForPhishing(phisher)).toBeGreaterThan(0);
    const by = await printsOf(phisher);
    expect(by("address")).toEqual(["facturevexto@gmail.com"]);
    expect(by("ip")).toEqual(["203.0.113.9"]);
    expect(by("sending_domain")).toEqual(["vexto-cadeaux.example"]);
    expect(by("display_name")).toEqual(["Facture Vexto"]);
    expect(by("subject")).toEqual(["Votre facture Vexto du 02/10 est disponible"]);
    expect(by("link_domain")).toEqual(["vextos-cadeaux.example"]);
    expect(by("phone")).toEqual(["123456789"]);
    expect(by("card")).toEqual(["card_fp_stolen"]);
    expect(by("text_hash")).toHaveLength(1);
    // Recording again adds nothing.
    expect(
      await recordPhishingFingerprints(db, { teamId: phisher, reason: "phishing" }, sources),
    ).toBe(0);
  });

  it("keeps verified domains and sign-up IPs only, and leaves shared egress networks out", async () => {
    await domain(phisher, "real-company.com");
    const relayed = await person(phisher, "second@outlook.fr", "1.1.1.1");
    await db.insert(schema.session).values({
      id: randomUUID(),
      token: randomUUID(),
      userId: relayed,
      ipAddress: "198.51.100.77",
      expiresAt: new Date(Date.now() + DAY_MS),
    });
    await storeReferenceData(db, {
      name: "dbip_asn",
      version: "2026-10",
      content: writeMmdb("DBIP-ASN-Lite", [
        ["1.1.1.0/24", { autonomous_system_number: 13335, autonomous_system_organization: "CF" }],
        [
          "203.0.113.0/24",
          { autonomous_system_number: 64500, autonomous_system_organization: "O" },
        ],
      ]),
    });
    await suspendForPhishing(phisher);
    const by = await printsOf(phisher);
    expect(by("sending_domain")).toEqual(["vexto-cadeaux.example"]);
    expect(by("ip")).toEqual(["203.0.113.9"]);
  });

  it("keeps the rest when a value is too long or cannot be written", async () => {
    await storedEmail(
      phisher,
      "Facture Vexto <factures@vexto-cadeaux.example>",
      `Votre facture ${"tres ".repeat(2000)}`,
      "<p>Bonjour</p>",
    );
    await suspendTeam(db, { teamId: phisher, reason: "phishing" });
    await recordPhishingFingerprints(
      db,
      { teamId: phisher, reason: "phishing" },
      { ...sources, cards: async () => ["card_fp_stolen", "bad\u0000card"] },
    );
    const by = await printsOf(phisher);
    expect(by("card")).toEqual(["card_fp_stolen"]);
    expect(by("subject").map((subject) => Array.from(subject).length)).toEqual([43, 256]);
    expect(by("address")).toEqual(["facturevexto@gmail.com"]);
  });

  it("reads each sender and subject from its newest email that still has a body, if any", async () => {
    // Later sends without a body: one of the stored campaign, one of a campaign with none left.
    const later = new Date(Date.now() + 60_000);
    for (const subject of [
      "Votre facture Vexto du 02/10 est disponible",
      "Votre facture Vexto du 03/10 est disponible",
    ]) {
      await db.insert(schema.emails).values({
        teamId: phisher,
        from: "Facture Vexto <factures@vexto-cadeaux.example>",
        to: ["victime@example.org"],
        subject,
        latestStatus: "suppressed",
        ...purgedEmailBodyColumns(later),
        createdAt: later,
      });
    }
    await suspendForPhishing(phisher);
    const by = await printsOf(phisher);
    expect(by("link_domain")).toEqual(["vextos-cadeaux.example"]);
    expect(by("phone")).toEqual(["123456789"]);
    expect(by("text_hash")).toHaveLength(1);
    expect(by("subject")).toEqual([
      "Votre facture Vexto du 02/10 est disponible",
      "Votre facture Vexto du 03/10 est disponible",
    ]);
  });
});

describe("recordMissingFingerprints", () => {
  it("backfills the longest-suspended first and leaves a team that gives nothing for a day", async () => {
    const now = new Date("2026-10-04T12:00:00Z");
    const empty = await createTeam(db, "empty");
    await suspendTeam(db, {
      teamId: empty,
      reason: "phishing",
      now: new Date("2026-10-01T00:00:00Z"),
    });
    await suspendTeam(db, {
      teamId: phisher,
      reason: "phishing",
      now: new Date("2026-10-02T00:00:00Z"),
    });

    expect(await recordMissingFingerprints(db, {}, { limit: 1, now })).toBe(1);
    expect((await printsOf(phisher))("address")).toEqual([]);
    const [stamp] = await db.select().from(schema.campaignCaptureFailures);
    expect(stamp).toEqual({ teamId: empty, failedAt: now });

    expect(await recordMissingFingerprints(db, {}, { limit: 1, now })).toBe(1);
    expect((await printsOf(phisher))("address")).toEqual(["facturevexto@gmail.com"]);
    expect(await recordMissingFingerprints(db, {}, { limit: 1, now })).toBe(0);
    const tomorrow = new Date(now.getTime() + DAY_MS + 1);
    expect(await recordMissingFingerprints(db, {}, { limit: 1, now: tomorrow })).toBe(1);
  });
});

describe("linkTeam", () => {
  it("only records at team creation and domain add, and holds at the first send", async () => {
    await suspendForPhishing(phisher);
    const team = await createTeam(db, "newcomer");
    await person(team, "nouveau@outlook.fr", "203.0.113.9");
    const atCreation = await linkTeam(db, { teamId: team, trigger: "team" });
    expect(atCreation?.held).toBe(false);
    await domain(team, "cadeaux-vexto.example");
    const atDomain = await linkTeam(db, { teamId: team, trigger: "domain" });
    expect(atDomain?.held).toBe(false);
    expect(atDomain?.links[0]?.matches.map((m) => m.kind).sort()).toEqual([
      "ip",
      "sending_domain",
      "sending_domain",
    ]);
    // Nothing the team can see has changed.
    expect(await standing(team)).toEqual({ reason: null, flag: { reason: "linked", detail: {} } });
    await db
      .update(schema.teamLinks)
      .set({ alertedAt: new Date() })
      .where(eq(schema.teamLinks.teamId, team));

    // The IP and the domain kept earlier hold it at its first send, whatever it sends.
    const atSend = await linkTeam(db, {
      teamId: team,
      trigger: "send",
      message: sendOf("Newcomer <oi@newcomer.example>", "Olá"),
    });
    expect(atSend?.held).toBe(true);
    expect(await standing(team)).toEqual({
      reason: "review",
      flag: { reason: "linked", detail: { suspension: true } },
    });
    expect(await sendRefusal(db, team)).toEqual({ reason: "team_suspended", suspension: "review" });
    // The operator hears again, now of the hold.
    expect(await linkRows(team)).toMatchObject([{ held: true, trigger: "team", alertedAt: null }]);
    const [audit] = await db
      .select({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.teamId, team));
    expect(audit).toEqual({ action: "team.held_for_review" });
  });

  it("holds at a send on two kinds of content: a suspended team's sender name and subject", async () => {
    await suspendForPhishing(phisher);
    const team = await createTeam(db, "newcomer");
    await person(team, "nouveau@outlook.fr", "198.51.100.7");
    await domain(team, "newcomer.example");
    const linked = await linkTeam(db, {
      teamId: team,
      trigger: "send",
      message: sendOf(
        "Facture Vexto <factures@newcomer.example>",
        "Votre facture Vexto du 04/10 est disponible",
      ),
    });
    expect(linked?.links[0]?.matches.map((m) => m.kind)).toEqual(["display_name", "subject"]);
    expect(linked?.held).toBe(true);
    expect(await sendRefusal(db, team)).toMatchObject({ suspension: "review" });
  });

  it("records one kind of evidence alone without holding: an IP, a domain or one content kind", async () => {
    await suspendForPhishing(phisher);
    const sends = [
      // The same sign-up IP, nothing else.
      { ip: "203.0.113.9", from: "Oi <oi@one.example>", subject: "Olá" },
      // A look-alike of its domain, sent from and linked to.
      {
        ip: null,
        from: "Oi <oi@cadeaux-vexto.example>",
        subject: "Olá",
        html: '<a href="https://cadeaux-vexto.example/x">x</a>',
      },
      // The sender name alone.
      { ip: null, from: "Facture Vexto <oi@three.example>", subject: "Olá" },
      // The phone number alone.
      {
        ip: null,
        from: "Oi <oi@four.example>",
        subject: "Olá",
        html: "<p>Appelez le +33 1 23 45 67 89</p>",
      },
    ];
    for (const [i, send] of sends.entries()) {
      const team = await createTeam(db, `single-${i}`);
      await person(team, `single${i}@outlook.fr`, send.ip);
      const linked = await linkTeam(db, {
        teamId: team,
        trigger: "send",
        message: sendOf(send.from, send.subject, send.html),
      });
      expect(linked?.held, String(i)).toBe(false);
      expect(linked?.links, String(i)).toHaveLength(1);
      expect((await standing(team)).reason, String(i)).toBeNull();
    }
  });

  it("holds on a mailbox or a card alone, kept from an earlier trigger", async () => {
    await suspendForPhishing(phisher);
    const byAddress = await createTeam(db, "a");
    await person(byAddress, "FactureVexto@googlemail.com", null);
    expect((await linkTeam(db, { teamId: byAddress, trigger: "team" }))?.links[0]?.matches).toEqual(
      [{ kind: "address", value: "facturevexto@gmail.com", matched: "facturevexto@gmail.com" }],
    );
    expect((await linkTeam(db, { teamId: byAddress, trigger: "send" }))?.held).toBe(true);

    const byCard = await createTeam(db, "c");
    await person(byCard, "other@outlook.fr", null);
    expect(
      (await linkTeam(db, { teamId: byCard, trigger: "payment", cards: ["card_fp_stolen"] }))?.held,
    ).toBe(false);
    expect((await linkTeam(db, { teamId: byCard, trigger: "send" }))?.held).toBe(true);
  });

  it("compares only with teams still suspended for phishing", async () => {
    await suspendForPhishing(phisher);
    const team = await createTeam(db, "newcomer");
    await person(team, "facturevexto@gmail.com", null);
    for (const reason of ["manual", "reputation", "review"] as const) {
      await suspendTeam(db, { teamId: phisher, reason });
      expect(await linkTeam(db, { teamId: team, trigger: "send" }), reason).toBeNull();
    }
    expect((await standing(team)).reason).toBeNull();
  });

  it("forgets an IP after 90 days", async () => {
    await suspendForPhishing(phisher, new Date(Date.now() - 100 * DAY_MS));
    const team = await createTeam(db, "newcomer");
    await person(team, "nouveau@outlook.fr", "203.0.113.9");
    expect(await linkTeam(db, { teamId: team, trigger: "team" })).toBeNull();
  });

  it("holds once: a released team is not held again, nor one released from any review hold", async () => {
    await suspendForPhishing(phisher);
    const team = await createTeam(db, "newcomer");
    await person(team, "facturevexto@gmail.com", null);
    expect((await linkTeam(db, { teamId: team, trigger: "send" }))?.held).toBe(true);
    await db
      .update(schema.teams)
      .set({ suspendedAt: null, suspensionReason: null })
      .where(eq(schema.teams.id, team));
    expect(await linkTeam(db, { teamId: team, trigger: "send" })).toBeNull();
    expect((await standing(team)).reason).toBeNull();

    const reviewed = await createTeam(db, "reviewed");
    await person(reviewed, "facture.vexto@gmail.com", null);
    await db.insert(schema.teamMonitor).values({ teamId: reviewed, heldAt: new Date() });
    expect((await linkTeam(db, { teamId: reviewed, trigger: "send" }))?.held).toBe(false);
  });

  it("leaves established teams alone, and holds nothing with the hold policy off", async () => {
    await suspendForPhishing(phisher);
    const established = await createTeam(db, "established");
    await person(established, "facturevexto@gmail.com", null);
    await db.insert(schema.teamMonitor).values({
      teamId: established,
      sentTotal: 50_000,
      firstSendAt: new Date(Date.now() - 60 * DAY_MS),
    });
    expect(await linkTeam(db, { teamId: established, trigger: "send" })).toBeNull();

    await db.insert(schema.instanceSettings).values({ id: 1, monitorAutoHold: false });
    const team = await createTeam(db, "newcomer");
    await person(team, "facture.vexto@googlemail.com", null);
    expect((await linkTeam(db, { teamId: team, trigger: "send" }))?.held).toBe(false);
    expect(await standing(team)).toEqual({ reason: null, flag: { reason: "linked", detail: {} } });
  });
});

describe("the instance's own domains", () => {
  it("tie no team to another: a shared inbox address, the onboarding email, a print kept before", async () => {
    // The onboarding sender and the shared inbox domain share a name under different suffixes.
    vi.stubEnv("SHARED_INBOX_DOMAIN", "platform.test");
    vi.stubEnv("ONBOARDING_EMAIL_FROM", "Platform <hello@mail.platform.example>");
    vi.stubEnv("APP_BASE_URL", "https://app.dashboard.example");
    await storedEmail(
      phisher,
      "Platform <hello@mail.platform.example>",
      "It works.",
      '<p>Your first email just landed in this inbox. The next ones go out from your own domain.</p><p><a href="https://app.dashboard.example/home">Open the dashboard</a></p>',
    );
    await storedEmail(
      phisher,
      "Vexto <vexto@vexto.platform.test>",
      "Sua fatura Vexto chegou hoje",
      "<p>Oi</p>",
    );
    await suspendForPhishing(phisher);
    const by = await printsOf(phisher);
    expect(by("sending_domain")).toEqual(["vexto-cadeaux.example"]);
    expect(by("link_domain")).toEqual(["vextos-cadeaux.example"]);
    expect(by("subject")).toEqual([
      "Sua fatura Vexto chegou hoje",
      "Votre facture Vexto du 02/10 est disponible",
    ]);
    // A print kept on the instance's domain before, and the phisher's look-alike of it.
    await db.insert(schema.campaignFingerprints).values(
      ["mail.platform.example", "platform.invalid"].map((value) => ({
        teamId: phisher,
        teamName: "facture-vexto",
        kind: "sending_domain" as const,
        value,
      })),
    );
    const send = async (slug: string, from: string) => {
      const team = await createTeam(db, slug);
      await person(team, `${slug}@outlook.fr`, null);
      return linkTeam(db, { teamId: team, trigger: "send", message: sendOf(from, "Olá") });
    };
    expect(await send("shared-address", "Equipe <hi@showrunner.platform.test>")).toBeNull();
    // The look-alike itself still ties a team that sends from it.
    expect((await send("look-alike", "Equipe <hi@login.platform.invalid>"))?.links).toMatchObject([
      {
        matches: [
          { kind: "sending_domain", value: "login.platform.invalid", matched: "platform.invalid" },
        ],
      },
    ]);
  });
});

describe("forgetting a suspended team", () => {
  it("drops its fingerprints and its people's abuse marks when it is reinstated", async () => {
    await suspendForPhishing(phisher);
    const [member] = await db
      .select({ abuse: schema.accountSignups.abuseSuspended })
      .from(schema.accountSignups);
    expect(member).toEqual({ abuse: true });
    await db
      .update(schema.teams)
      .set({ suspendedAt: null, suspensionReason: null })
      .where(eq(schema.teams.id, phisher));
    await forgetAbuseRecords(db, phisher);
    expect(await db.select().from(schema.campaignFingerprints)).toEqual([]);
    expect(
      await db.select({ abuse: schema.accountSignups.abuseSuspended }).from(schema.accountSignups),
    ).toEqual([{ abuse: false }]);
  });

  it("drops IPs 90 days after the suspension and everything else after 12 months", async () => {
    await suspendForPhishing(phisher, new Date("2026-01-01T00:00:00Z"));
    const kinds = async () =>
      new Set(
        (
          await db
            .select({ kind: schema.campaignFingerprints.kind })
            .from(schema.campaignFingerprints)
        ).map((row) => row.kind),
      );
    expect(await purgeCampaignFingerprints(db, new Date("2026-03-01T00:00:00Z"))).toBe(0);
    expect((await purgeCampaignFingerprints(db, new Date("2026-04-15T00:00:00Z"))) > 0).toBe(true);
    expect((await kinds()).has("ip")).toBe(false);
    expect((await kinds()).has("address")).toBe(true);
    await purgeCampaignFingerprints(db, new Date("2027-01-02T00:00:00Z"));
    expect(await kinds()).toEqual(new Set());
  });
});
