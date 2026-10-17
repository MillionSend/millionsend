import { randomBytes, randomUUID } from "node:crypto";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb, createWebhookEndpoint } from "@millionsend/test-utils";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type AbuseJudge, type InboundJudgeVerdict, JudgeError } from "../src/abuse-judge/types.js";
import { EnvKeyring } from "../src/crypto/keyring.js";
import type { InboxActor } from "../src/inboxes/activity.js";
import { deriveInboxKeys } from "../src/inboxes/keys.js";
import { releasePreview } from "../src/inboxes/quarantine.js";
import { CONTENT_HOLDS, releaseRights, screensOnRelease } from "../src/inboxes/release-rules.js";
import { defaultSafety, type InboxSafety } from "../src/inboxes/safety.js";
import { QUARANTINE_REASONS, SENDER_TRUSTS } from "../src/inboxes/types.js";
import type { MonitorSettings } from "../src/monitor-settings.js";
import { releaseQuarantined } from "../src/receiving/delivery.js";
import { ingestReceivedEmail } from "../src/receiving/ingest.js";
import type { DeliverEnvelope } from "../src/receiving/protocol.js";
import type { ReleaseScreen } from "../src/receiving/screen.js";
import { utcDay } from "../src/utc-day.js";

const OWNER: InboxActor = { kind: "user", userId: "u-rel-owner" };
const TEAM_KEY: InboxActor = { kind: "api_key", apiKeyId: randomUUID(), inboxId: null };
const INBOX_KEY: InboxActor = { kind: "api_key", apiKeyId: randomUUID(), inboxId: randomUUID() };
const AGENT: InboxActor = { kind: "oauth", userId: "u-rel-owner", clientId: "client-1" };
const SYSTEM: InboxActor = { kind: "system" };

describe("releaseRights", () => {
  it("lets a person or a team key release any hold, an agent only what isn't a content hold", () => {
    expect([...CONTENT_HOLDS].sort()).toEqual(["failed_auth", "injection", "phishing", "virus"]);
    for (const reason of QUARANTINE_REASONS) {
      const may = (actor: InboxActor) =>
        releaseRights({ reason, senderTrust: "external", actor, admin: true }).release;
      expect([may(OWNER), may(TEAM_KEY), may(INBOX_KEY), may(SYSTEM)]).toEqual([
        true,
        true,
        false,
        false,
      ]);
      expect(may(AGENT)).toBe(!CONTENT_HOLDS.includes(reason));
    }
  });

  it("offers trust only for a verified sender held off the allowlist, to owners, admins and team keys", () => {
    const releasers = [
      ["admin", OWNER, true],
      ["member", OWNER, false],
      ["team key", TEAM_KEY, false],
      ["inbox key", INBOX_KEY, true],
      ["agent", AGENT, true],
      ["system", SYSTEM, true],
    ] as const;
    const trusted: string[] = [];
    for (const reason of QUARANTINE_REASONS) {
      for (const senderTrust of SENDER_TRUSTS) {
        for (const [who, actor, admin] of releasers) {
          if (releaseRights({ reason, senderTrust, actor, admin }).trust) {
            trusted.push(`${reason} ${senderTrust} ${who}`);
          }
        }
      }
    }
    expect(trusted).toEqual([
      "not_allowlisted external admin",
      "not_allowlisted external team key",
    ]);
  });
});

describe("screensOnRelease", () => {
  it("asks the judge first for holds made before screening, in agent inboxes that screen", () => {
    const screened = QUARANTINE_REASONS.filter((reason) =>
      screensOnRelease({ reason, kind: "agent", screening: true }),
    );
    expect(screened.sort()).toEqual(["failed_auth", "not_allowlisted", "unauthenticated_sender"]);
    expect(screensOnRelease({ reason: "not_allowlisted", kind: "human", screening: true })).toBe(
      false,
    );
    expect(screensOnRelease({ reason: "not_allowlisted", kind: "agent", screening: false })).toBe(
      false,
    );
  });
});

let db: Db;
let close: () => Promise<void>;
let team: string;
let other: string;
let domainId: string;
let hook: string;
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
const inboxKeys = deriveInboxKeys(randomBytes(32));
const NOW = new Date("2026-10-17T12:00:00Z");
const SETTINGS = { teamDailyCap: 600, instanceDailyCap: 50_000 } as MonitorSettings;
const PASS = { spf: "pass", dkim: "pass", dmarc: "pass", arc: "none" } as const;
const NONE = { spf: "none", dkim: "none", dmarc: "none", arc: "none" } as const;
const FAIL = { spf: "fail", dkim: "none", dmarc: "fail", arc: "none" } as const;
const DOMAIN = "in.release.test";

const verdict = (overrides: Partial<InboundJudgeVerdict> = {}): InboundJudgeVerdict => ({
  injectionScore: 3,
  phishingScore: 2,
  spamScore: 0,
  reasons: [],
  category: "clean",
  language: "en",
  ...overrides,
});

const screenWith = (screen: NonNullable<AbuseJudge["screen"]>): ReleaseScreen => ({
  judge: { provider: "typesafe", model: "jev-test", judge: vi.fn(), screen },
  timeoutMs: 5_000,
  settings: async () => SETTINGS,
});

let seq = 0;
async function addInbox(
  local: string,
  safety: Partial<InboxSafety> = {},
  kind: "agent" | "human" = "agent",
): Promise<string> {
  const [row] = await db
    .insert(schema.inboxes)
    .values({
      teamId: team,
      kind,
      emailAddress: `${local}@${DOMAIN}`,
      localPart: local,
      domainId,
      name: local,
      safety: { ...defaultSafety(kind, false), ...safety },
    })
    .returning({ id: schema.inboxes.id });
  if (!row) throw new Error("inbox insert failed");
  return row.id;
}

/** One message to `to`, from a sender at fabrikam.example; with `attach`, a PDF goes with it. */
async function receive(
  to: string,
  p: {
    auth?: DeliverEnvelope["auth"];
    attach?: boolean;
    scanVirus?: () => Promise<{ verdict: "fail"; signature: string }>;
  } = {},
): Promise<string> {
  seq++;
  const head = [
    "From: Marta <marta@fabrikam.example>",
    `To: ${to}`,
    `Subject: Quote ${seq}`,
    `Message-ID: <quote-${seq}-${randomUUID()}@fabrikam.example>`,
    "Date: Fri, 16 Oct 2026 12:00:00 +0000",
    "MIME-Version: 1.0",
  ];
  const text = "Hi! Here is the updated quote.\n\nThanks,\nMarta";
  const lines = p.attach
    ? [
        ...head,
        'Content-Type: multipart/mixed; boundary="part"',
        "",
        "--part",
        "Content-Type: text/plain; charset=utf-8",
        "",
        text,
        "--part",
        'Content-Type: application/pdf; name="quote.pdf"',
        'Content-Disposition: attachment; filename="quote.pdf"',
        "Content-Transfer-Encoding: base64",
        "",
        "JVBERi0xLjQK",
        "--part--",
        "",
      ]
    : [...head, "Content-Type: text/plain; charset=utf-8", "", text, ""];
  const result = await ingestReceivedEmail(
    {
      db,
      keyring,
      isCloud: false,
      inboxKeys,
      judgeAvailable: false,
      now: () => NOW,
      scanVirus: p.scanVirus,
    },
    {
      raw: Buffer.from(lines.join("\r\n")),
      envelope: {
        mailFrom: "bounces@fabrikam.example",
        recipients: [to],
        clientIp: "192.0.2.10",
        helo: "mail.fabrikam.example",
        tls: null,
        auth: p.auth ?? PASS,
        receivedAt: NOW.toISOString(),
      },
    },
  );
  if (!result.ok) throw new Error(`refused ${result.code}`);
  const id = result.stored[0]?.id;
  if (!id) throw new Error("nothing stored");
  return id;
}

const membership = async (id: string, inboxId: string) => {
  const m = schema.receivedEmailInboxes;
  const [row] = await db
    .select()
    .from(m)
    .where(and(eq(m.receivedEmailId, id), eq(m.inboxId, inboxId)));
  if (!row) throw new Error("membership missing");
  return row;
};

/** A hold set to a reason the rules alone never give, as the judge would have left it. */
async function judgedAs(
  id: string,
  inboxId: string,
  reason: "injection" | "unscreened" | "screening_cap",
) {
  const m = schema.receivedEmailInboxes;
  await db
    .update(m)
    .set({
      quarantineReason: reason,
      ...(reason === "injection" ? { injectionScore: 91, phishingScore: 12 } : {}),
    })
    .where(and(eq(m.receivedEmailId, id), eq(m.inboxId, inboxId)));
}

const allowlistOf = async (inboxId: string) =>
  (
    await db
      .select({ safety: schema.inboxes.safety })
      .from(schema.inboxes)
      .where(eq(schema.inboxes.id, inboxId))
  )[0]?.safety.allowlist;

const hookPayloads = async (emailId: string) =>
  (
    await db
      .select({
        type: schema.webhookDeliveries.eventType,
        payload: schema.webhookDeliveries.payload,
      })
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.endpointId, hook))
  ).filter((h) => JSON.stringify(h.payload).includes(emailId));

const release = (
  id: string,
  inboxId: string | null,
  o: { actor?: InboxActor; admin?: boolean; trust?: boolean; screen?: ReleaseScreen } = {},
) =>
  releaseQuarantined(
    db,
    { keyring, screen: o.screen },
    {
      teamId: team,
      receivedEmailId: id,
      inboxId,
      actor: o.actor ?? OWNER,
      admin: o.admin ?? true,
      trustSender: o.trust ?? false,
      now: NOW,
    },
  );

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  team = await createTeam(db, "release-acme");
  other = await createTeam(db, "release-other");
  await db.insert(schema.user).values({ id: "u-rel-owner", name: "Owner", email: "o@acme.test" });
  await db
    .insert(schema.teamMembers)
    .values({ teamId: team, userId: "u-rel-owner", role: "owner" });
  const [domain] = await db
    .insert(schema.domains)
    .values({
      teamId: team,
      name: DOMAIN,
      region: "us-east-1",
      status: "verified",
      receivingEnabled: true,
      receivingCatchAll: true,
    })
    .returning({ id: schema.domains.id });
  if (!domain) throw new Error("domain insert failed");
  domainId = domain.id;
  hook = await createWebhookEndpoint(db, team, ["inbox.email.received", "inbox.email.quarantined"]);
});
afterAll(() => close());
afterEach(async () => {
  await db.delete(schema.usageCounters);
  await db.delete(schema.inboxUsageDaily);
});

describe("screening on release", () => {
  it("holds a message made before screening again when the judge finds what it would have held", async () => {
    const inbox = await addInbox("orders", { accept_from: "allowlist" });
    const id = await receive(`orders@${DOMAIN}`);
    expect(await membership(id, inbox)).toMatchObject({ quarantineReason: "not_allowlisted" });
    const screen = vi.fn(async (_block: string) =>
      verdict({ injectionScore: 92, phishingScore: 40, reasons: ["override", "exfiltration"] }),
    );
    expect(await release(id, inbox, { actor: AGENT, screen: screenWith(screen) })).toEqual({
      ok: true,
      outcome: "held_again",
      reason: "injection",
      injectionScore: 92,
      phishingScore: 40,
    });
    expect(screen).toHaveBeenCalledTimes(1);
    expect(await membership(id, inbox)).toMatchObject({
      verdict: "quarantined",
      quarantineReason: "injection",
      injectionScore: 92,
      phishingScore: 40,
      reasons: ["override", "exfiltration"],
      judge: { version: "jev-inbound-1", status: "judged", model: "jev-test" },
      deliveredAt: null,
      releasedAt: null,
    });
    expect((await hookPayloads(id)).map((h) => h.type)).toEqual(["inbox.email.quarantined"]);
    const activity = await db
      .select({ actor: schema.inboxActivity.actor, decision: schema.inboxActivity.decision })
      .from(schema.inboxActivity)
      .where(and(eq(schema.inboxActivity.emailId, id), eq(schema.inboxActivity.inboxId, inbox)));
    expect(activity).toContainEqual({
      actor: "system",
      decision: { result: "quarantined", reasons: ["injection"] },
    });

    // Now a content hold: the agent can't release it, and the judge isn't asked twice.
    expect(await release(id, inbox, { actor: AGENT, screen: screenWith(screen) })).toEqual({
      ok: false,
      reason: "forbidden",
    });
    expect(await release(id, inbox, { screen: screenWith(screen) })).toMatchObject({
      ok: true,
      outcome: "released",
    });
    expect(screen).toHaveBeenCalledTimes(1);
  });

  it("releases what the judge reads as clean with its scores, and what it couldn't read as the person decided", async () => {
    const inbox = await addInbox("quotes", { accept_from: "allowlist" });
    const clean = await receive(`quotes@${DOMAIN}`);
    const screen = vi.fn(async () => verdict({ injectionScore: 6, phishingScore: 4 }));
    expect(await release(clean, inbox, { screen: screenWith(screen) })).toMatchObject({
      ok: true,
      outcome: "released",
    });
    expect(await membership(clean, inbox)).toMatchObject({
      verdict: "released",
      quarantineReason: "not_allowlisted",
      injectionScore: 6,
      phishingScore: 4,
      judge: { status: "judged" },
      releasedBy: "user:u-rel-owner",
    });

    const timedOut = await receive(`quotes@${DOMAIN}`);
    const failing = vi.fn(async () => Promise.reject(new JudgeError("timeout")));
    expect(await release(timedOut, inbox, { screen: screenWith(failing) })).toMatchObject({
      outcome: "released",
    });
    expect(await membership(timedOut, inbox)).toMatchObject({
      verdict: "released",
      injectionScore: null,
      judge: { status: "timeout" },
    });

    const noJudge = await receive(`quotes@${DOMAIN}`);
    expect(await release(noJudge, inbox)).toMatchObject({ outcome: "released" });
    expect(await membership(noJudge, inbox)).toMatchObject({ verdict: "released", judge: null });

    const capped = await receive(`quotes@${DOMAIN}`);
    await db
      .insert(schema.usageCounters)
      .values({ teamId: team, day: utcDay(NOW), inboundJudged: SETTINGS.teamDailyCap })
      .onConflictDoUpdate({
        target: [schema.usageCounters.teamId, schema.usageCounters.day],
        set: { inboundJudged: SETTINGS.teamDailyCap },
      });
    const unasked = vi.fn(async () => verdict({ injectionScore: 99 }));
    expect(await release(capped, inbox, { screen: screenWith(unasked) })).toMatchObject({
      outcome: "released",
    });
    expect(unasked).not.toHaveBeenCalled();
    expect(await membership(capped, inbox)).toMatchObject({
      verdict: "released",
      judge: { status: "screening_cap" },
    });
  });

  it("never asks the judge about a hold it read or couldn't read, nor where the inbox doesn't screen", async () => {
    const screen = vi.fn(async () => verdict({ injectionScore: 99 }));
    const agent = await addInbox("desk", { accept_from: "allowlist" });
    for (const reason of ["injection", "unscreened", "screening_cap"] as const) {
      const id = await receive(`desk@${DOMAIN}`);
      await judgedAs(id, agent, reason);
      expect(await release(id, agent, { screen: screenWith(screen) })).toMatchObject({
        outcome: "released",
      });
    }
    const people = await addInbox("team", { accept_from: "allowlist" }, "human");
    const toPeople = await receive(`team@${DOMAIN}`);
    expect(await release(toPeople, people, { screen: screenWith(screen) })).toMatchObject({
      outcome: "released",
    });
    const unscreened = await addInbox("quiet", { accept_from: "allowlist", screening: false });
    const toQuiet = await receive(`quiet@${DOMAIN}`);
    expect(await release(toQuiet, unscreened, { screen: screenWith(screen) })).toMatchObject({
      outcome: "released",
    });
    expect(screen).not.toHaveBeenCalled();
  });

  it("keeps a hold another release's screening made meanwhile", async () => {
    const inbox = await addInbox("race", { accept_from: "allowlist" });
    const id = await receive(`race@${DOMAIN}`);
    const m = schema.receivedEmailInboxes;
    // While this release waits on the judge, another one holds the message for phishing.
    const screen = vi.fn(async () => {
      await db
        .update(m)
        .set({ quarantineReason: "phishing", injectionScore: 10, phishingScore: 88 })
        .where(and(eq(m.receivedEmailId, id), eq(m.inboxId, inbox)));
      return verdict();
    });
    expect(await release(id, inbox, { screen: screenWith(screen) })).toEqual({
      ok: true,
      outcome: "held_again",
      reason: "phishing",
      injectionScore: 10,
      phishingScore: 88,
    });
    expect(await membership(id, inbox)).toMatchObject({ verdict: "quarantined" });
  });
});

describe("who may release and trust", () => {
  it("trusts only a verified sender held off the allowlist, for owners, admins and team keys", async () => {
    const inbox = await addInbox("vip", { accept_from: "allowlist" });
    const verified = await receive(`vip@${DOMAIN}`);
    for (const [actor, admin] of [
      [OWNER, false],
      [AGENT, true],
    ] as const) {
      expect(await release(verified, inbox, { actor, admin, trust: true })).toEqual({
        ok: false,
        reason: "trust_not_allowed",
      });
    }
    expect(await membership(verified, inbox)).toMatchObject({ verdict: "quarantined" });
    expect(await allowlistOf(inbox)).toEqual([]);
    expect(await release(verified, inbox, { actor: TEAM_KEY, trust: true })).toMatchObject({
      outcome: "released",
      trustedSender: "marta@fabrikam.example",
    });
    expect(await allowlistOf(inbox)).toEqual(["marta@fabrikam.example"]);

    const strict = await addInbox("strict", { accept_from: "allowlist" });
    const unverified = await receive(`strict@${DOMAIN}`, { auth: NONE });
    expect(await membership(unverified, strict)).toMatchObject({
      quarantineReason: "not_allowlisted",
      senderTrust: "unauthenticated",
    });
    expect(await release(unverified, strict, { trust: true })).toEqual({
      ok: false,
      reason: "trust_not_allowed",
    });
    const forged = await receive(`strict@${DOMAIN}`, { auth: FAIL });
    expect(await membership(forged, strict)).toMatchObject({ quarantineReason: "failed_auth" });
    expect(await release(forged, strict, { trust: true })).toEqual({
      ok: false,
      reason: "trust_not_allowed",
    });
    expect(await release(forged, strict, { actor: AGENT })).toEqual({
      ok: false,
      reason: "forbidden",
    });
    expect(await allowlistOf(strict)).toEqual([]);
    expect(await release(verified, inbox, { actor: INBOX_KEY })).toEqual({
      ok: false,
      reason: "not_quarantined",
    });
  });

  it("names the attachments in the events a release fires", async () => {
    const inbox = await addInbox("files", { accept_from: "allowlist" });
    const id = await receive(`files@${DOMAIN}`, { attach: true });
    expect(await release(id, inbox)).toMatchObject({ outcome: "released" });
    const received = (await hookPayloads(id)).find((h) => h.type === "inbox.email.received");
    expect(received?.payload).toMatchObject({
      data: { email: { attachments: [{ filename: "quote.pdf" }] } },
    });
  });
});

describe("releasePreview", () => {
  const preview = (
    id: string,
    inboxId: string | null,
    o: { admin?: boolean; judgeConfigured?: boolean; withText?: boolean; teamId?: string } = {},
  ) =>
    releasePreview(db, keyring, {
      teamId: o.teamId ?? team,
      inboxId,
      receivedEmailId: id,
      actor: OWNER,
      admin: o.admin ?? true,
      judgeConfigured: o.judgeConfigured ?? true,
      withText: o.withText ?? true,
    });

  it("says why it was held, what a release sets off and what this person may do", async () => {
    const inbox = await addInbox("agent", {
      accept_from: "allowlist",
      send_policy: "allowlist",
      private_codes: true,
      require_approval: false,
      forward_to: ["o@acme.test"],
    });
    const id = await receive(`agent@${DOMAIN}`);
    expect(await preview(id, inbox)).toEqual({
      subject: expect.stringMatching(/^Quote \d+$/),
      from: "marta@fabrikam.example",
      fromName: "Marta",
      inboxAddress: `agent@${DOMAIN}`,
      inboxKind: "agent",
      reason: "not_allowlisted",
      injectionScore: null,
      phishingScore: null,
      reasons: [],
      hiddenTextRemoved: false,
      senderTrust: "external",
      virusSignature: null,
      text: expect.stringContaining("Here is the updated quote."),
      textTruncated: false,
      trustOffered: true,
      trustNeedsAdmin: false,
      trustEffects: { sendWithoutApproval: true, codesExempt: true },
      releaseEffects: { replyWithoutApproval: true, webhooks: true, forwards: true },
      rescreenOnRelease: true,
    });
    expect(await preview(id, inbox, { admin: false })).toMatchObject({
      trustOffered: false,
      trustNeedsAdmin: true,
    });
    expect(await preview(id, inbox, { judgeConfigured: false, withText: false })).toMatchObject({
      rescreenOnRelease: false,
      text: null,
    });
    await judgedAs(id, inbox, "injection");
    expect(await preview(id, inbox)).toMatchObject({
      reason: "injection",
      injectionScore: 91,
      trustOffered: false,
      trustNeedsAdmin: false,
      rescreenOnRelease: false,
    });
    expect(await preview(id, inbox, { teamId: other })).toBe("not_found");
    await release(id, inbox);
    expect(await preview(id, inbox)).toBe("not_quarantined");
  });

  it("lists only what applies: no agent lines in a people inbox, no unattended reply under approval", async () => {
    const people = await addInbox("people", { accept_from: "allowlist" }, "human");
    const toPeople = await receive(`people@${DOMAIN}`);
    expect(await preview(toPeople, people)).toMatchObject({
      inboxKind: "human",
      trustOffered: true,
      trustEffects: { sendWithoutApproval: false, codesExempt: false },
      releaseEffects: { replyWithoutApproval: false, forwards: false },
      rescreenOnRelease: false,
    });
    const careful = await addInbox("careful", {
      accept_from: "verified",
      require_approval: true,
      send_policy: "reply_only",
      private_codes: false,
    });
    const unverified = await receive(`careful@${DOMAIN}`, { auth: NONE });
    expect(await preview(unverified, careful)).toMatchObject({
      reason: "unauthenticated_sender",
      trustOffered: false,
      trustNeedsAdmin: false,
      trustEffects: { sendWithoutApproval: false, codesExempt: false },
      releaseEffects: { replyWithoutApproval: false },
    });
  });

  it("previews a catch-all copy held for a virus, which belongs to no inbox", async () => {
    const id = await receive(`nobody@${DOMAIN}`, {
      scanVirus: async () => ({ verdict: "fail", signature: "Eicar-Test-Signature" }),
    });
    expect(await preview(id, null)).toMatchObject({
      inboxAddress: `nobody@${DOMAIN}`,
      inboxKind: "agent",
      reason: "virus",
      virusSignature: "Eicar-Test-Signature",
      trustOffered: false,
      trustNeedsAdmin: false,
      // The endpoint takes inbox events only, never email.received.
      releaseEffects: { replyWithoutApproval: false, webhooks: false, forwards: false },
      rescreenOnRelease: false,
    });
    expect(await release(id, null, { trust: true })).toEqual({
      ok: false,
      reason: "trust_not_allowed",
    });
    expect(await release(id, null)).toMatchObject({ outcome: "released" });
    expect(await preview(id, null)).toBe("not_quarantined");
  });
});
