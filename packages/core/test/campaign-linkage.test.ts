import { randomBytes, randomUUID } from "node:crypto";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordSignup } from "../src/account-signups.js";
import {
  linkTeam,
  recordMissingFingerprints,
  recordPhishingFingerprints,
} from "../src/campaign-linkage.js";
import { encryptEmailBody } from "../src/crypto/envelope.js";
import { EnvKeyring } from "../src/crypto/keyring.js";
import { sendRefusal, suspendTeam } from "../src/team-standing.js";

const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
const sources = { keyring: () => keyring, cards: async () => ["card_fp_stolen"] };

let db: Db;
let close: () => Promise<void>;
let phisher: string;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  phisher = await phishingTeam();
});
afterEach(() => close());

async function person(teamId: string, email: string, ip: string | null) {
  const id = randomUUID();
  await db.insert(schema.user).values({ id, name: "Person", email });
  await db.insert(schema.teamMembers).values({ teamId, userId: id, role: "owner" });
  await recordSignup(db, { userId: id, email, ip, userAgent: "Firefox" });
  return id;
}

async function domain(teamId: string, name: string) {
  await db.insert(schema.domains).values({
    teamId,
    name,
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
  await domain(teamId, "vexto-cadeaux.example");
  await storedEmail(
    teamId,
    "Facture Vexto <factures@vexto-cadeaux.example>",
    "Votre facture Vexto du 02/10 est disponible",
    '<p>Bonjour, votre facture Vexto est disponible. Payez maintenant pour garder votre abonnement actif.</p><p><a href="https://vextos-cadeaux.example/payer">Payer</a> ou appelez le +33 1 23 45 67 89</p>',
  );
  return teamId;
}

async function suspendForPhishing(teamId: string) {
  await suspendTeam(db, { teamId, reason: "phishing" });
  return recordPhishingFingerprints(db, { teamId, reason: "phishing" }, sources);
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

describe("recordPhishingFingerprints", () => {
  it("keeps what a team suspended for phishing leaves, its stored mail read through the keyring", async () => {
    await suspendTeam(db, { teamId: phisher, reason: "manual" });
    expect(
      await recordPhishingFingerprints(db, { teamId: phisher, reason: "manual" }, sources),
    ).toBe(0);
    expect(await suspendForPhishing(phisher)).toBeGreaterThan(0);
    const prints = await db
      .select({ kind: schema.campaignFingerprints.kind, value: schema.campaignFingerprints.value })
      .from(schema.campaignFingerprints)
      .where(eq(schema.campaignFingerprints.teamId, phisher));
    const by = (kind: string) => prints.filter((p) => p.kind === kind).map((p) => p.value);
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

  it("is picked up later for a phishing team that has none, mail unread without a keyring", async () => {
    await suspendTeam(db, { teamId: phisher, reason: "phishing" });
    expect(await recordMissingFingerprints(db)).toBe(1);
    const kinds = await db
      .selectDistinct({ kind: schema.campaignFingerprints.kind })
      .from(schema.campaignFingerprints);
    expect(kinds.map((k) => k.kind).sort()).toEqual([
      "address",
      "display_name",
      "ip",
      "sending_domain",
      "subject",
    ]);
    expect(await recordMissingFingerprints(db)).toBe(0);
  });
});

describe("linkTeam", () => {
  it("holds a new team that adds a return's domain, before it sends anything", async () => {
    await suspendForPhishing(phisher);
    const team = await createTeam(db, "newcomer");
    await person(team, "nouveau@outlook.fr", "198.51.100.7");
    expect(await linkTeam(db, { teamId: team, trigger: "team" })).toBeNull();

    await domain(team, "cadeaux-vexto.example");
    const linked = await linkTeam(db, { teamId: team, trigger: "domain" });
    expect(linked).toEqual({
      held: true,
      links: [
        {
          teamId: phisher,
          teamName: "facture-vexto",
          matches: [
            // The return's link domain, then its sending domain.
            {
              kind: "sending_domain",
              value: "cadeaux-vexto.example",
              matched: "vextos-cadeaux.example",
            },
            {
              kind: "sending_domain",
              value: "cadeaux-vexto.example",
              matched: "vexto-cadeaux.example",
            },
          ],
        },
      ],
    });
    expect(await standing(team)).toEqual({
      reason: "review",
      flag: { reason: "linked", detail: { suspension: true } },
    });
    expect(await sendRefusal(db, team)).toEqual({
      reason: "team_suspended",
      suspension: "review",
    });
    const [audit] = await db
      .select({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.teamId, team));
    expect(audit).toEqual({ action: "team.held_for_review" });
  });

  it("holds a new team at its first send on the sender name and subject", async () => {
    await suspendForPhishing(phisher);
    const team = await createTeam(db, "newcomer");
    await person(team, "nouveau@outlook.fr", "198.51.100.7");
    await domain(team, "newcomer.example");
    const linked = await linkTeam(db, {
      teamId: team,
      trigger: "send",
      message: {
        from: "Facture Vexto <factures@newcomer.example>",
        subject: "Votre facture Vexto du 04/10 est disponible",
        html: "<p>Bonjour</p>",
        text: null,
      },
    });
    expect(linked?.links[0]?.matches.map((m) => m.kind)).toEqual(["display_name", "subject"]);
    expect(await sendRefusal(db, team)).toMatchObject({ suspension: "review" });
  });

  it("knows a returning person by a Gmail address written another way, an IP or a card", async () => {
    await suspendForPhishing(phisher);
    const byAddress = await createTeam(db, "a");
    await person(byAddress, "FactureVexto@googlemail.com", null);
    expect((await linkTeam(db, { teamId: byAddress, trigger: "team" }))?.links[0]?.matches).toEqual(
      [{ kind: "address", value: "facturevexto@gmail.com", matched: "facturevexto@gmail.com" }],
    );

    const byIp = await createTeam(db, "b");
    await person(byIp, "someone@outlook.fr", "203.0.113.9");
    expect((await linkTeam(db, { teamId: byIp, trigger: "team" }))?.held).toBe(true);

    const byCard = await createTeam(db, "c");
    await person(byCard, "other@outlook.fr", null);
    expect(
      (await linkTeam(db, { teamId: byCard, trigger: "payment", cards: ["card_fp_stolen"] }))
        ?.links[0]?.matches,
    ).toEqual([{ kind: "card", value: "card_fp_stolen", matched: "card_fp_stolen" }]);
  });

  it("compares only with teams still suspended for phishing", async () => {
    await suspendForPhishing(phisher);
    const team = await createTeam(db, "newcomer");
    await person(team, "nouveau@outlook.fr", "203.0.113.9");
    for (const reason of ["manual", "reputation", "review"] as const) {
      await suspendTeam(db, { teamId: phisher, reason });
      expect(await linkTeam(db, { teamId: team, trigger: "team" }), reason).toBeNull();
    }
    await db
      .update(schema.teams)
      .set({ suspendedAt: null, suspensionReason: null })
      .where(eq(schema.teams.id, phisher));
    expect(await linkTeam(db, { teamId: team, trigger: "team" })).toBeNull();
    expect((await standing(team)).reason).toBeNull();
  });

  it("acts once: a released team is not held again", async () => {
    await suspendForPhishing(phisher);
    const team = await createTeam(db, "newcomer");
    await person(team, "nouveau@outlook.fr", "203.0.113.9");
    expect((await linkTeam(db, { teamId: team, trigger: "team" }))?.held).toBe(true);
    await db
      .update(schema.teams)
      .set({ suspendedAt: null, suspensionReason: null })
      .where(eq(schema.teams.id, team));
    await domain(team, "cadeaux-vexto.example");
    expect(await linkTeam(db, { teamId: team, trigger: "domain" })).toBeNull();
    expect((await standing(team)).reason).toBeNull();
  });

  it("leaves established teams alone, and records without holding when the hold is off", async () => {
    await suspendForPhishing(phisher);
    const established = await createTeam(db, "established");
    await person(established, "ops@acme.dev", "203.0.113.9");
    await db.insert(schema.teamMonitor).values({
      teamId: established,
      sentTotal: 50_000,
      firstSendAt: new Date(Date.now() - 60 * 86_400_000),
    });
    expect(await linkTeam(db, { teamId: established, trigger: "domain" })).toBeNull();

    await db.insert(schema.instanceSettings).values({ id: 1, monitorAutoHold: false });
    const team = await createTeam(db, "newcomer");
    await person(team, "nouveau@outlook.fr", "203.0.113.9");
    expect((await linkTeam(db, { teamId: team, trigger: "team" }))?.held).toBe(false);
    expect(await standing(team)).toEqual({ reason: null, flag: { reason: "linked", detail: {} } });
    const [row] = await db
      .select({ held: schema.teamLinks.held })
      .from(schema.teamLinks)
      .where(eq(schema.teamLinks.teamId, team));
    expect(row).toEqual({ held: false });
  });
});
