import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  type AbuseJudge,
  createPromiseCache,
  type EmailAttachment,
  EnvKeyring,
  encryptEmailBody,
  MONITOR_SETTING_DEFAULTS,
  type MonitorSettings,
  openMediaReview,
  SCREEN_RETRIES,
  sealAttachments,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { judgeSample } from "../src/handlers/abuse-judge.js";
import { type SendDeps, sendEmail } from "../src/handlers/send-email.js";
import { MediaPool } from "../src/media/pool.js";
import type { VisionReader, VisionResult } from "../src/media/vision.js";

/**
 * Screening of images and files before SES, through sendQueued and the judge
 * job with TypeSafe and the image reader faked: what a new team's media
 * holds back, and what a team past new sends and has drawn.
 */

let db: Db;
let close: () => Promise<void>;
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
const DAY = 86_400_000;
// Room for CI under load; the parse budget itself is tested in media-scan.
const pool = new MediaPool({ timeoutMs: 30_000 });
// No room in its queue: every read is refused as busy.
const fullPool = new MediaPool({ queueMax: 0 });
const QR_PNG = readFileSync(new URL("./fixtures/media/qr.png", import.meta.url));
const LURE_HTML = `<img src="data:image/png;base64,${QR_PNG.toString("base64")}" width="148" height="148">`;
const TRANSCRIPT = "Your Microsoft 365 password expires today";

let sesCalls: string[];
let judgeQueue: { sampleId: string; screening: boolean; startAfter?: Date | undefined }[];
let resent: string[];
let rescheduled: { emailId: string; at: Date }[];
let blocks: string[];
let mails: { kind: string; text: string }[];

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await db
    .insert(schema.user)
    .values({ id: "op", name: "Operator", email: "op@example.com", createdAt: new Date(0) });
});
afterAll(async () => {
  await pool.close();
  await fullPool.close();
  await close();
});
beforeEach(() => {
  sesCalls = [];
  judgeQueue = [];
  resent = [];
  rescheduled = [];
  blocks = [];
  mails = [];
});

const sendDeps = (settings: Partial<MonitorSettings> = {}): SendDeps => ({
  keyring,
  ses: {
    sendRaw: async ({ emailId }) => {
      sesCalls.push(emailId);
      return { messageId: `mid-${emailId}` };
    },
  },
  monitor: {
    samplingKey: Buffer.alloc(32, 7),
    settings: async () => ({ ...MONITOR_SETTING_DEFAULTS, ...settings }),
    enqueueJudge: async (sampleId, opts) =>
      void judgeQueue.push({
        sampleId,
        screening: opts?.screening ?? false,
        startAfter: opts?.startAfter,
      }),
  },
  reschedule: async (emailId, at) => void rescheduled.push({ emailId, at }),
});

function fakeJudge(score: number): AbuseJudge {
  return {
    provider: "typesafe",
    model: "fake-model",
    judge: async (block) => {
      blocks.push(block);
      return score >= 65
        ? {
            score,
            verdict: "abuse",
            categories: ["phishing_credentials"],
            reasons: ["impersonation"],
            impersonatedBrand: "Microsoft",
            language: "en",
          }
        : {
            score,
            verdict: "clean",
            categories: [],
            reasons: [],
            impersonatedBrand: null,
            language: "en",
          };
    },
  };
}

function reader(answer: (count: number) => VisionResult): VisionReader {
  return { model: "fake-vision", read: async (items) => answer(items.length) };
}
const transcribes = reader((count) => ({
  status: "ok",
  reports: Array.from({ length: count }, () => ({
    text: TRANSCRIPT,
    brands: ["Microsoft"],
    qrCodes: 1,
    loginOrPaymentForm: false,
    addressedToAi: false,
  })),
}));
const timesOut = reader(() => ({ status: "unavailable", reason: "timeout" }));

const freshCache = () => createPromiseCache({ maxEntries: 100, ttlMs: 60_000 });
const judge = (
  sampleId: string,
  answer: AbuseJudge,
  vision: VisionReader | null,
  now?: Date,
  threads: MediaPool = pool,
) =>
  judgeSample(
    db,
    {
      judge: answer,
      keyring,
      settings: async () => MONITOR_SETTING_DEFAULTS,
      mailer: { send: async (_to, m) => void mails.push({ kind: m.kind, text: m.text }) },
      enqueueSend: async (emailId) => void resent.push(emailId),
      media: { vision, pool: threads, cache: freshCache() },
      ...(now ? { now: () => now } : {}),
    },
    { sampleId },
  );

/**
 * A team with one verified sending domain registered `registeredDaysAgo`
 * ago: new, in its first window, or established.
 */
async function team(slug: string, registeredDaysAgo: number, tier: "new" | "established") {
  const teamId = await createTeam(db, slug);
  const [domain] = await db
    .insert(schema.domains)
    .values({
      teamId,
      name: `${slug}.dev`,
      region: "us-east-1",
      status: "verified",
      verifiedAt: new Date(),
      registeredAt: new Date(Date.now() - registeredDaysAgo * DAY),
    })
    .returning({ id: schema.domains.id });
  if (tier === "established") {
    await db.insert(schema.teamMonitor).values({
      teamId,
      sentTotal: 20_000,
      firstSendAt: new Date(Date.now() - 200 * DAY),
    });
  }
  return { teamId, domainId: domain?.id ?? "", slug };
}

async function email(
  t: { teamId: string; domainId: string; slug: string },
  html: string,
  attachments: EmailAttachment[] = [],
): Promise<string> {
  const id = randomUUID();
  const owner = { teamId: t.teamId, rowId: id };
  const body = await encryptEmailBody({ html, text: null }, keyring, owner);
  await db.insert(schema.emails).values({
    id,
    teamId: t.teamId,
    domainId: t.domainId,
    from: `Support <hi@${t.slug}.dev>`,
    to: ["r@example.org"],
    subject: "Your account",
    bodyCiphertext: body.ciphertext,
    bodyIv: body.iv,
    bodyWrappedDek: body.wrappedDek,
    bodyKeyVersion: body.keyVersion,
    attachments: attachments.length ? await sealAttachments(attachments, keyring, owner) : null,
  });
  return id;
}

const sampleOf = async (emailId: string) =>
  (
    await db
      .select()
      .from(schema.monitorSamples)
      .where(eq(schema.monitorSamples.emailId, emailId))
      .orderBy(desc(schema.monitorSamples.createdAt))
  )[0];
const row = async (emailId: string) =>
  (await db.select().from(schema.emails).where(eq(schema.emails.id, emailId)))[0];
const review = async (emailId: string) => {
  const r = await row(emailId);
  return r?.media ? openMediaReview(r.media, keyring, { teamId: r.teamId, rowId: r.id }) : null;
};
const webPage = (filename: string): EmailAttachment => ({
  filename,
  content: Buffer.from("<html><body><p>Fatura de outubro</p></body></html>").toString("base64"),
  contentType: "text/html",
});

it("holds a new team on an image-only lure from a fresh domain: the transcript reaches the judge and nothing is sent", async () => {
  const t = await team("lure-fresh", 2, "new");
  const id = await email(t, LURE_HTML);
  expect(await sendEmail(db, sendDeps(), { emailId: id })).toBe("deferred");
  const sample = await sampleOf(id);
  expect(sample).toMatchObject({ kind: "first_sends", screening: true, status: "pending" });

  expect(await judge(sample?.id ?? "", fakeJudge(85), transcribes)).toBe("judged");
  expect(blocks[0]).toContain(TRANSCRIPT);
  expect(blocks[0]).toContain("m365-verify.example");
  expect(
    (await db.select().from(schema.teams).where(eq(schema.teams.id, t.teamId)))[0],
  ).toMatchObject({ suspensionReason: "review" });
  expect(resent).toEqual([id]);
  expect(await sendEmail(db, sendDeps(), { emailId: id })).toBe("parked");
  expect(await row(id)).toMatchObject({ latestStatus: "queued_quota", parkReason: "review" });
  expect(sesCalls).toEqual([]);
  // What screening read stays with the held email for the operator.
  const kept = await review(id);
  expect(kept?.text.map((entry) => entry.text)).toContain(TRANSCRIPT);
  expect(kept?.previews).toHaveLength(1);
});

it("lets the same lure from an older domain wait two minutes after its verdict", async () => {
  const t = await team("lure-aged", 400, "new");
  const id = await email(t, LURE_HTML);
  expect(await sendEmail(db, sendDeps(), { emailId: id })).toBe("deferred");
  const judgedAt = new Date();
  expect(await judge((await sampleOf(id))?.id ?? "", fakeJudge(85), transcribes, judgedAt)).toBe(
    "judged",
  );
  expect(blocks[0]).toContain(TRANSCRIPT);
  expect(
    (await db.select().from(schema.teams).where(eq(schema.teams.id, t.teamId)))[0]?.suspendedAt,
  ).toBeNull();
  expect(await sendEmail(db, sendDeps(), { emailId: id })).toBe("deferred");
  expect(rescheduled).toEqual([{ emailId: id, at: new Date(judgedAt.getTime() + 2 * 60_000) }]);
  expect(sesCalls).toEqual([]);
});

it("parks a new team's web-page attachment with its reason, and sends an established team's, drawn for the judge", async () => {
  const fresh = await team("page-new", 400, "new");
  const parked = await email(fresh, "<p>Segue a fatura.</p>", [webPage("fatura.html")]);
  expect(await sendEmail(db, sendDeps(), { emailId: parked })).toBe("parked");
  expect(await row(parked)).toMatchObject({ latestStatus: "queued_quota", parkReason: "media" });
  // The judge still reads it, for the hold.
  expect(await sampleOf(parked)).toMatchObject({ screening: true, status: "pending" });
  expect(await review(parked)).toMatchObject({
    files: [{ filename: "fatura.html", kind: "html", flags: ["markup"] }],
    issues: ["risky_file"],
    previews: [],
  });

  const known = await team("page-established", 400, "established");
  // With the tier's own rate at 0, only the two anomalies (opaque, a file) draw it.
  const undrawn = { establishedRate: 0 };
  const sent = await email(known, "<p>Segue a fatura.</p>", [webPage("fatura.html")]);
  expect(await sendEmail(db, sendDeps(undrawn), { emailId: sent })).toBe("sent");
  expect(sesCalls).toEqual([sent]);
  expect(await sampleOf(sent)).toMatchObject({ kind: "anomaly", screening: false });
  expect((await row(sent))?.media).toBeNull();
  // A file alone, in a body with text, is one anomaly: not enough here.
  const plain = await email(
    known,
    `<p>${"Segue a fatura de outubro com os detalhes. ".repeat(4)}</p>`,
    [webPage("fatura.html")],
  );
  expect(await sendEmail(db, sendDeps(undrawn), { emailId: plain })).toBe("sent");
  expect(await sampleOf(plain)).toBeUndefined();
});

it("re-reads a young domain's images three times while the image reader times out, then parks the email", async () => {
  const t = await team("vision-young", 1, "new");
  const id = await email(t, LURE_HTML);
  await sendEmail(db, sendDeps(), { emailId: id });
  for (let retry = 1; retry <= SCREEN_RETRIES; retry++) {
    expect(await judge((await sampleOf(id))?.id ?? "", fakeJudge(5), timesOut)).toBe("unjudged");
    expect(await sampleOf(id)).toMatchObject({
      status: "unjudged",
      errorClass: "media_unavailable",
    });
    expect(resent.at(-1)).toBe(id);
    judgeQueue = [];
    const before = Date.now();
    expect(await sendEmail(db, sendDeps(), { emailId: id })).toBe("deferred");
    expect(await sampleOf(id)).toMatchObject({ status: "pending", screenRetries: retry });
    expect(judgeQueue[0]?.startAfter?.getTime()).toBeGreaterThanOrEqual(before + 2 * 60_000);
  }
  // TypeSafe is never asked to judge what could not be read.
  expect(blocks).toEqual([]);
  expect(await judge((await sampleOf(id))?.id ?? "", fakeJudge(5), timesOut)).toBe("unjudged");
  expect(await sendEmail(db, sendDeps(), { emailId: id })).toBe("parked");
  expect(await row(id)).toMatchObject({ latestStatus: "queued_quota", parkReason: "screening" });
  expect(sesCalls).toEqual([]);
});

it("judges an older domain's email without the images the reader timed out on, saying so, and sends it", async () => {
  const t = await team("vision-aged", 400, "new");
  const id = await email(t, LURE_HTML);
  await sendEmail(db, sendDeps(), { emailId: id });
  expect(await judge((await sampleOf(id))?.id ?? "", fakeJudge(5), timesOut)).toBe("judged");
  expect(blocks[0]).toContain("1 not read (timeout)");
  expect(await sampleOf(id)).toMatchObject({ mediaIssues: ["vision_unavailable"] });
  expect(await sendEmail(db, sendDeps(), { emailId: id })).toBe("sent");
  expect(sesCalls).toEqual([id]);
});

it("parks mail whose images the reader's provider blocked, keeps no preview, and tells the operator", async () => {
  const t = await team("vision-blocked", 400, "new");
  const id = await email(t, LURE_HTML);
  await sendEmail(db, sendDeps(), { emailId: id });
  const blocked = reader(() => ({ status: "blocked" }));
  expect(await judge((await sampleOf(id))?.id ?? "", fakeJudge(5), blocked)).toBe("judged");
  expect(mails.map((m) => m.kind)).toEqual(["monitor.media_blocked"]);
  expect(await sendEmail(db, sendDeps(), { emailId: id })).toBe("parked");
  expect(await row(id)).toMatchObject({ parkReason: "media" });
  expect(await review(id)).toMatchObject({ previews: [], issues: ["vision_blocked"] });
  expect(sesCalls).toEqual([]);
});

it("screens an established team's mail when a file in it points somewhere new", async () => {
  const t = await team("qr-attachment", 900, "established");
  const id = await email(
    t,
    `<p>Hello, the details are attached. <a href="https://qr-attachment.dev/">Site</a></p>`,
    [{ filename: "scan.png", content: QR_PNG.toString("base64"), contentType: "image/png" }],
  );
  expect(await sendEmail(db, sendDeps(), { emailId: id })).toBe("deferred");
  expect(await sampleOf(id)).toMatchObject({ kind: "destination", screening: true });
  expect(await judge((await sampleOf(id))?.id ?? "", fakeJudge(5), null)).toBe("judged");
  expect(await sampleOf(id)).toMatchObject({ destinations: ["m365-verify.example"] });
  expect(await sendEmail(db, sendDeps(), { emailId: id })).toBe("sent");
});

const receipt = (): EmailAttachment => ({
  filename: "comprovante.png",
  content: QR_PNG.toString("base64"),
  contentType: "image/png",
});

it("retries the send when the parsing threads have no room for a file, and never parks it", async () => {
  const t = await team("busy-send", 400, "new");
  const id = await email(t, "<p>Segue o comprovante.</p>", [receipt()]);
  const full = { pool: fullPool, cache: freshCache() };
  await expect(sendEmail(db, { ...sendDeps(), media: full }, { emailId: id })).rejects.toThrow(
    "media parse busy",
  );
  expect(await row(id)).toMatchObject({ latestStatus: "queued", parkReason: null });
  expect(await sampleOf(id)).toBeUndefined();
  // With room again, the file is read and the email screened as usual.
  const room = { pool, cache: freshCache() };
  expect(await sendEmail(db, { ...sendDeps(), media: room }, { emailId: id })).toBe("deferred");
  expect(await sampleOf(id)).toMatchObject({ screening: true, status: "pending" });
  expect(sesCalls).toEqual([]);
});

it("judges without a file the parsing threads had no room for, says so, and never parks it", async () => {
  const t = await team("busy-judge", 400, "new");
  const id = await email(t, "<p>Segue o comprovante.</p>", [receipt()]);
  expect(await sendEmail(db, sendDeps(), { emailId: id })).toBe("deferred");
  const sampleId = (await sampleOf(id))?.id ?? "";
  expect(await judge(sampleId, fakeJudge(5), null, undefined, fullPool)).toBe("judged");
  expect(blocks[0]).toContain("busy");
  const issues = (await sampleOf(id))?.mediaIssues;
  expect(issues).toContain("images_not_read");
  expect(issues).not.toContain("unreadable_file");
  expect(await sendEmail(db, sendDeps(), { emailId: id })).toBe("sent");
  expect(sesCalls).toEqual([id]);
});
