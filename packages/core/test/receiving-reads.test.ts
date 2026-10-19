import { randomBytes } from "node:crypto";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EnvKeyring } from "../src/crypto/keyring.js";
import { deriveInboxKeys } from "../src/inboxes/keys.js";
import { WAITS_PER_PROCESS, WAITS_PER_TEAM_PER_PROCESS } from "../src/inboxes/limits.js";
import { defaultSafety } from "../src/inboxes/safety.js";
import { reconcilePendingScreens } from "../src/receiving/delivery.js";
import { deleteReceivedEmail } from "../src/receiving/erase.js";
import { ingestReceivedEmail } from "../src/receiving/ingest.js";
import { latestVerificationCode } from "../src/receiving/verification.js";
import { acquireWaitSlot, waitForReceived } from "../src/receiving/wait.js";

let db: Db;
let close: () => Promise<void>;
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
const NOW = new Date("2026-10-12T15:00:00Z");
let team: string;
let inbox: string;
let domainId: string;

const raw = (from: string, body: string, subject = "Your verification code") =>
  Buffer.from(
    [
      `From: ${from}`,
      "To: codes@in.reads.test",
      `Subject: ${subject}`,
      `Message-ID: <${Math.random()}@sender.example>`,
      "Content-Type: text/plain",
      "",
      body,
      "",
    ].join("\r\n"),
  );

async function receive(
  from: string,
  body: string,
  opts: { at?: Date; auth?: "pass" | "fail" } = {},
) {
  const auth =
    opts.auth === "fail"
      ? { spf: "fail", dkim: "none", dmarc: "fail", arc: "none" }
      : { spf: "pass", dkim: "pass", dmarc: "pass", arc: "none" };
  const result = await ingestReceivedEmail(
    {
      db,
      keyring,
      isCloud: false,
      inboxKeys: deriveInboxKeys(randomBytes(32)),
      now: () => opts.at ?? NOW,
    },
    {
      raw: raw(from, body),
      envelope: {
        mailFrom: from.replace(/.*</, "").replace(">", ""),
        recipients: ["codes@in.reads.test"],
        clientIp: "192.0.2.1",
        helo: "mail.sender.example",
        tls: null,
        auth: auth as never,
        receivedAt: NOW.toISOString(),
      },
    },
  );
  if (!result.ok) throw new Error("refused");
  return result.stored[0]?.id as string;
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  team = await createTeam(db, "reads-team");
  const [domain] = await db
    .insert(schema.domains)
    .values({
      teamId: team,
      name: "in.reads.test",
      region: "us-east-1",
      status: "verified",
      receivingEnabled: true,
      receivingCatchAll: true,
    })
    .returning({ id: schema.domains.id });
  domainId = domain?.id as string;
  const [row] = await db
    .insert(schema.inboxes)
    .values({
      teamId: team,
      kind: "agent",
      emailAddress: "codes@in.reads.test",
      localPart: "codes",
      domainId,
      name: "Codes",
      safety: { ...defaultSafety("agent", false), accept_from: "anyone" },
    })
    .returning({ id: schema.inboxes.id });
  inbox = row?.id as string;
});
afterAll(() => close());

const latest = (p: Partial<Parameters<typeof latestVerificationCode>[2]> = {}) =>
  latestVerificationCode(db, keyring, {
    teamId: team,
    inboxId: inbox,
    from: null,
    maxAgeMs: 600_000,
    actor: { kind: "api_key", apiKeyId: "00000000-0000-4000-8000-000000000001", inboxId: inbox },
    now: NOW,
    ...p,
  });

describe("latestVerificationCode (S7)", () => {
  it("serves the newest delivered code within max_age, filtered by sender, and records the read", async () => {
    expect((await latest()).status).toBe("none");
    await receive("GitHub <noreply@github.example>", "Your verification code is 111111", {
      at: new Date(NOW.getTime() - 120_000),
    });
    const id = await receive("Acme <login@mail.acme.example>", "Your verification code is 482913", {
      at: new Date(NOW.getTime() - 60_000),
    });
    expect(await latest()).toMatchObject({
      object: "verification_code",
      status: "found",
      kind: "otp",
      code: "482913",
      email_id: id,
      from: "login@mail.acme.example",
      sender_trust: "external",
    });
    expect(await latest({ from: "acme.example" })).toMatchObject({ code: "482913" });
    expect(await latest({ from: "*@acme.example" })).toMatchObject({ code: "482913" });
    expect(await latest({ from: "noreply@github.example" })).toMatchObject({ code: "111111" });
    expect((await latest({ from: "other.example" })).status).toBe("none");
    expect((await latest({ maxAgeMs: 30_000 })).status).toBe("none");
    const reads = await db
      .select()
      .from(schema.inboxActivity)
      .where(
        and(eq(schema.inboxActivity.inboxId, inbox), eq(schema.inboxActivity.action, "code.read")),
      );
    expect(reads.length).toBeGreaterThanOrEqual(3);
    // The trail names the email, never the code.
    expect(JSON.stringify(reads)).not.toContain("482913");
  });

  it("never serves a failed sender's code, held mail, or an inbox that does not extract codes", async () => {
    await receive("Bank <alerts@bank.example>", "Your verification code is 999999", {
      auth: "fail",
    });
    expect((await latest()).code).not.toBe("999999");
    await db
      .update(schema.receivedEmailInboxes)
      .set({ deliveredAt: null, verdict: "quarantined", quarantineReason: "injection" })
      .where(eq(schema.receivedEmailInboxes.inboxId, inbox));
    expect((await latest()).status).toBe("none");
    await db
      .update(schema.receivedEmailInboxes)
      .set({ deliveredAt: NOW, verdict: "released" })
      .where(eq(schema.receivedEmailInboxes.inboxId, inbox));
    await db
      .update(schema.inboxes)
      .set({ safety: { ...defaultSafety("agent", false), extract_codes: false } })
      .where(eq(schema.inboxes.id, inbox));
    expect((await latest()).status).toBe("none");
    await db
      .update(schema.inboxes)
      .set({ safety: { ...defaultSafety("agent", false), accept_from: "anyone" } })
      .where(eq(schema.inboxes.id, inbox));
  });

  it("counts max_age from delivery and skips mail received before since", async () => {
    const mine = { from: "since.example" };
    const at = new Date(NOW.getTime() - 20 * 60_000);
    const old = await receive("Login <login@since.example>", "Your verification code is 731904", {
      at,
    });
    expect((await latest(mine)).status).toBe("none");
    await db
      .update(schema.receivedEmailInboxes)
      .set({ verdict: "released", deliveredAt: new Date(NOW.getTime() - 60_000) })
      .where(eq(schema.receivedEmailInboxes.receivedEmailId, old));
    expect(await latest(mine)).toMatchObject({ status: "found", code: "731904", email_id: old });
    expect((await latest({ ...mine, since: at })).status).toBe("none");
    await receive("Login <login@since.example>", "Your verification code is 552018", {
      at: new Date(NOW.getTime() - 30_000),
    });
    expect(await latest({ ...mine, since: at })).toMatchObject({ code: "552018" });
  });
});

describe("waitForReceived and wait slots (S28)", () => {
  it("returns a match found within one interval of its arrival", async () => {
    let clock = 0;
    let polls = 0;
    const slept: number[] = [];
    const rows = await waitForReceived({
      deadlineMs: 50_000,
      signal: new AbortController().signal,
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
      poll: async () => (++polls === 4 ? ["mail"] : []),
    });
    expect(rows).toEqual(["mail"]);
    expect(slept).toHaveLength(3);
    for (const ms of slept) {
      expect(ms).toBeGreaterThanOrEqual(500);
      expect(ms).toBeLessThan(600);
    }
  });

  it("slows to one poll a second after five seconds and stops at the deadline with nothing", async () => {
    let clock = 0;
    const slept: number[] = [];
    const rows = await waitForReceived({
      deadlineMs: 8_000,
      signal: new AbortController().signal,
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
      poll: async () => [],
    });
    expect(rows).toEqual([]);
    expect(clock).toBe(8_000);
    expect(slept.at(-2)).toBeGreaterThanOrEqual(1_000);
  });

  it("stops polling once the client goes away", async () => {
    const controller = new AbortController();
    let polls = 0;
    const done = waitForReceived({
      deadlineMs: Date.now() + 50_000,
      signal: controller.signal,
      poll: async () => {
        polls++;
        return [];
      },
    });
    setTimeout(() => controller.abort(), 50);
    expect(await done).toEqual([]);
    const after = polls;
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(polls).toBe(after);
  });

  it("gives a team at most WAITS_PER_TEAM_PER_PROCESS waits at once", () => {
    const releases = Array.from({ length: WAITS_PER_TEAM_PER_PROCESS }, () =>
      acquireWaitSlot("team-w"),
    );
    expect(releases.every(Boolean)).toBe(true);
    expect(acquireWaitSlot("team-w")).toBeNull();
    expect(acquireWaitSlot("team-other")).not.toBeNull();
    releases[0]?.();
    releases[0]?.();
    const again = acquireWaitSlot("team-w");
    expect(again).not.toBeNull();
    expect(acquireWaitSlot("team-w")).toBeNull();
  });

  it("and the process at most WAITS_PER_PROCESS waits for all teams together", () => {
    const releases: (() => void)[] = [];
    for (let i = 0; i < WAITS_PER_PROCESS; i++) {
      const release = acquireWaitSlot(`team-${i}`);
      if (!release) break;
      releases.push(release);
    }
    expect(releases.length).toBeGreaterThan(0);
    expect(acquireWaitSlot("team-late")).toBeNull();
    releases.pop()?.();
    const late = acquireWaitSlot("team-late");
    expect(late).not.toBeNull();
    late?.();
    for (const release of releases) release();
  });
});

describe("deleteReceivedEmail", () => {
  it("erases the row, its memberships and secrets, empties threads, and records who did it", async () => {
    const id = await receive("Shop <hi@shop.example>", "Your verification code is 123456");
    const [membership] = await db
      .select()
      .from(schema.receivedEmailInboxes)
      .where(eq(schema.receivedEmailInboxes.receivedEmailId, id));
    expect(
      await deleteReceivedEmail(db, { teamId: team, id, actor: { kind: "user", userId: "u1" } }),
    ).toBe(true);
    expect(
      await db.select().from(schema.receivedEmails).where(eq(schema.receivedEmails.id, id)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(schema.receivedSecrets)
        .where(eq(schema.receivedSecrets.receivedEmailId, id)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(schema.inboxThreads)
        .where(eq(schema.inboxThreads.id, membership?.threadId ?? "")),
    ).toEqual([]);
    const [activity] = await db
      .select()
      .from(schema.inboxActivity)
      .where(
        and(eq(schema.inboxActivity.emailId, id), eq(schema.inboxActivity.action, "email.deleted")),
      );
    expect(activity).toMatchObject({ actor: "user:u1", inboxId: inbox });
    const audit = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "received_email.deleted"));
    expect(audit).toHaveLength(1);
    expect(
      await deleteReceivedEmail(db, { teamId: team, id, actor: { kind: "user", userId: "u1" } }),
    ).toBe(false);
  });
});

describe("reconcilePendingScreens", () => {
  it("queues again only screenings pending past fifteen minutes", async () => {
    const [thread] = await db
      .insert(schema.inboxThreads)
      .values({ teamId: team, inboxId: inbox })
      .returning({ id: schema.inboxThreads.id });
    const pending = async (minutesAgo: number) => {
      const [row] = await db
        .insert(schema.receivedEmails)
        .values({
          teamId: team,
          domainIds: [domainId],
          rawSha256: `${minutesAgo}`.padStart(64, "p"),
          messageId: `<${minutesAgo}@x>`,
          from: "a@b.example",
          receivedFor: ["codes@in.reads.test"],
          envelope: { mailFrom: "", clientIp: "192.0.2.1", helo: "h", tls: null },
          authentication: { spf: "none", dkim: "none", dmarc: "none", arc: "none" },
          sizeBytes: 1,
          catchAll: false,
        })
        .returning({ id: schema.receivedEmails.id });
      await db.insert(schema.receivedEmailInboxes).values({
        receivedEmailId: row?.id as string,
        inboxId: inbox,
        teamId: team,
        threadId: thread?.id as string,
        address: "codes@in.reads.test",
        senderTrust: "external",
        verdict: "pending",
        createdAt: new Date(NOW.getTime() - minutesAgo * 60_000),
      });
      return row?.id as string;
    };
    const stale = await pending(20);
    await pending(5);
    const queued: { receivedEmailId: string; inboxId: string }[] = [];
    expect(await reconcilePendingScreens(db, async (p) => void queued.push(p), NOW)).toBe(1);
    expect(queued).toEqual([{ receivedEmailId: stale, inboxId: inbox }]);
  });
});
