import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  createPromiseCache,
  DAY_MS,
  type EmailAttachment,
  EnvKeyring,
  encryptEmailBody,
  sealAttachments,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MediaPool } from "../src/media/pool.js";
import { formatReplay, replayMedia } from "../src/media/replay.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/media/${name}`, import.meta.url));
const file = (filename: string, bytes: Uint8Array | string): EmailAttachment => ({
  filename,
  content: Buffer.from(bytes).toString("base64"),
});
// A stored ZIP holding readme.txt.
const ZIP =
  "UEsDBBQAAAAAANqMS12DFtyMAQAAAAEAAAAKAAAAcmVhZG1lLnR4dHhQSwECFAMUAAAAAADajEtdgxbcjAEAAAABAAAACgAAAAAAAAAAAAAAgAEAAAAAcmVhZG1lLnR4dFBLBQYAAAAAAQABADgAAAApAAAAAAA=";
const LONG_TEXT = `<p>${"Segue a fatura de outubro do seu plano, com o detalhamento dos serviços. ".repeat(3)}</p>`;

let db: Db;
let close: () => Promise<void>;
let newTeam: string;
let oldTeam: string;
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
// Room for CI under load; the parse budget itself is tested in media-scan.
const pool = new MediaPool({ timeoutMs: 30_000 });
const NOW = Date.now();

async function insertEmail(
  teamId: string,
  body: { html?: string; text?: string },
  attachments: EmailAttachment[],
  opts: { ageMs?: number; purged?: boolean } = {},
): Promise<void> {
  const id = randomUUID();
  const owner = { teamId, rowId: id };
  const sealed = await encryptEmailBody(
    { html: body.html ?? null, text: body.text ?? null },
    keyring,
    owner,
  );
  await db.insert(schema.emails).values({
    id,
    teamId,
    from: "Acme <billing@acme.dev>",
    to: ["customer@example.org"],
    subject: "Fatura",
    latestStatus: "sent",
    bodyCiphertext: sealed.ciphertext,
    bodyIv: sealed.iv,
    bodyWrappedDek: sealed.wrappedDek,
    bodyKeyVersion: sealed.keyVersion,
    attachments: attachments.length > 0 ? await sealAttachments(attachments, keyring, owner) : null,
    createdAt: new Date(NOW - (opts.ageMs ?? 3_600_000)),
    ...(opts.purged ? { bodyPurgedAt: new Date(NOW) } : {}),
  });
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  newTeam = await createTeam(db, "replay-new");
  oldTeam = await createTeam(db, "replay-old");
  await db.update(schema.teams).set({ plan: "starter" }).where(eq(schema.teams.id, newTeam));
  await db.insert(schema.teamMonitor).values([
    { teamId: newTeam, sentTotal: 6, firstSendAt: new Date(NOW - DAY_MS) },
    { teamId: oldTeam, sentTotal: 20_000, firstSendAt: new Date(NOW - 200 * DAY_MS) },
  ]);
  await db.insert(schema.domains).values([
    { teamId: newTeam, name: "acme.dev", region: "us-east-1", status: "verified" },
    {
      teamId: oldTeam,
      name: "mail.m365-verify.example",
      region: "us-east-1",
      registeredAt: new Date(NOW - 2 * DAY_MS),
    },
  ]);
  const qrImage = `data:image/png;base64,${fixture("qr.png").toString("base64")}`;
  await insertEmail(newTeam, { html: LONG_TEXT }, [file("Fatura.pdf", fixture("lure.pdf"))]);
  await insertEmail(newTeam, { text: "Segue" }, [file("invoice.exe", "MZ")]);
  await insertEmail(newTeam, { html: "<p>Veja o anexo</p>" }, [file("page.html", "<html>")]);
  await insertEmail(
    newTeam,
    { html: `<img src="${qrImage}"><img src="https://cdn.evil.example/lure.png">` },
    [],
  );
  await insertEmail(newTeam, { text: "x" }, [file("old.exe", "MZ")], { ageMs: 40 * DAY_MS });
  await insertEmail(newTeam, { text: "x" }, [file("gone.exe", "MZ")], { purged: true });
  await insertEmail(oldTeam, { html: LONG_TEXT }, [
    { filename: "docs.zip", content: ZIP, contentType: "application/zip" },
  ]);
  await insertEmail(oldTeam, { html: LONG_TEXT }, []);
});
afterAll(async () => {
  await pool.close();
  await close();
});

const deps = () => ({ pool, cache: createPromiseCache({ maxEntries: 100, ttlMs: 60_000 }) });

describe("replayMedia", () => {
  it("counts what the API would refuse, what would wait, and where QR and Pix codes point", async () => {
    const report = await replayMedia(db, keyring, { days: 30, limit: 100 }, deps());
    expect(report).toMatchObject({ days: 30, limit: 100, candidates: 5, opened: 5 });
    expect(report.teams).toEqual([
      {
        team: newTeam.slice(0, 8),
        tier: "new",
        paid: true,
        emails: 4,
        opaque: 3,
        refusedEmails: 1,
        refused: { blocked_extension: 1 },
        flaggedEmails: 1,
        flagged: { markup: 1 },
        qrCodes: 2,
        qrEmails: 2,
        qrDomains: { "<7d": 1, unknown: 1 },
        qrOwnDomains: 0,
        pix: { qr: 0, text: 1, emails: 1 },
        remoteImages: 1,
      },
      {
        team: oldTeam.slice(0, 8),
        tier: "established",
        paid: false,
        emails: 1,
        opaque: 0,
        refusedEmails: 0,
        refused: {},
        flaggedEmails: 1,
        flagged: { archive: 1 },
        qrCodes: 0,
        qrEmails: 0,
        qrDomains: {},
        qrOwnDomains: 0,
        pix: { qr: 0, text: 0, emails: 0 },
        remoteImages: 0,
      },
    ]);
  });

  it("prints counts and team id prefixes, never content, names, addresses or domains", async () => {
    const before = await db
      .select({
        id: schema.emails.id,
        status: schema.emails.latestStatus,
        media: schema.emails.media,
      })
      .from(schema.emails);
    const lines = formatReplay(await replayMedia(db, keyring, { days: 30, limit: 100 }, deps()));
    const printed = lines.join("\n");
    expect(lines[0]).toBe(
      "Media replay, last 30 days: 5 of 5 candidate emails opened (limit 100).",
    );
    expect(lines.slice(3)).toEqual([
      `${newTeam.slice(0, 8)} new paid: emails 4, opaque 3, refused 1 (blocked_extension 1), parked 1 (markup 1), QR 2 to domains 2 (<7d 1, unknown 1), own 0, Pix 1`,
      `${oldTeam.slice(0, 8)} established free: emails 1, opaque 0, refused 0, flagged 1 (archive 1), QR 0 to domains 0, own 0, Pix 0`,
      "",
      "Refused with 422 for every team: emails 1, teams 1 (blocked_extension 1).",
      'Parked for a person while the team is new: emails 1, teams 1 (markup 1). Past "new", a sampling anomaly instead: emails 1, teams 1.',
      "Opaque: emails 3, teams 1; while the team was new: emails 3.",
      "QR codes: 2 decoded in emails 2, teams 1; destination domains, distinct per team, by age (<7d 1, unknown 1); the team's own: 0.",
      "Pix codes: 1 in emails 1, teams 1 (in QR codes 0, as text 1).",
      "Remote body images not fetched: 1.",
    ]);
    for (const secret of [
      "Fatura",
      "invoice",
      ".exe",
      "page.html",
      "docs.zip",
      "m365-verify",
      "qr-in-pdf",
      "acme.dev",
      "cdn.evil",
      "@",
      "JOAO",
      newTeam,
      oldTeam,
    ]) {
      expect(printed, secret).not.toContain(secret);
    }
    expect(
      await db
        .select({
          id: schema.emails.id,
          status: schema.emails.latestStatus,
          media: schema.emails.media,
        })
        .from(schema.emails),
    ).toEqual(before);
  });

  it("opens the newest candidates first, up to the limit", async () => {
    const report = await replayMedia(db, keyring, { days: 30, limit: 2 }, deps());
    expect(report).toMatchObject({ candidates: 5, opened: 2 });
  });
});
