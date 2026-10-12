import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  deriveReceivedDownloadKey,
  RECEIVED_DOWNLOAD_TTL_MS,
  signReceivedDownload,
  verifyReceivedDownload,
} from "../src/receiving/downloads.js";

const key = deriveReceivedDownloadKey(randomBytes(32));
const teamId = randomUUID();
const emailId = randomUUID();
const attachmentId = randomUUID();
const NOW = new Date("2026-10-11T12:00:00.250Z");

function parts(url: string) {
  const u = new URL(url);
  return {
    path: u.pathname,
    expires: u.searchParams.get("expires"),
    signature: u.searchParams.get("signature"),
  };
}

describe("signed received-mail downloads", () => {
  it("derives a key distinct from the master key and per derivation input", () => {
    const master = randomBytes(32);
    expect(deriveReceivedDownloadKey(master).equals(master)).toBe(false);
    expect(deriveReceivedDownloadKey(master).equals(deriveReceivedDownloadKey(master))).toBe(true);
    expect(() => deriveReceivedDownloadKey(Buffer.alloc(8))).toThrow();
  });

  it("signs a one-hour link on the API host that verifies for exactly its target", () => {
    const raw = signReceivedDownload({
      key,
      baseUrl: "https://api.example.com/",
      teamId,
      emailId,
      now: NOW,
    });
    expect(raw.expiresAt.getTime() - NOW.getTime()).toBeLessThanOrEqual(RECEIVED_DOWNLOAD_TTL_MS);
    expect(raw.expiresAt.toISOString()).toBe("2026-10-11T13:00:00.000Z");
    const { path, expires, signature } = parts(raw.url);
    expect(raw.url.startsWith("https://api.example.com/receiving/raw/")).toBe(true);
    expect(path).toBe(`/receiving/raw/${emailId}`);
    const ok = { key, teamId, emailId, expires, signature, now: NOW };
    expect(verifyReceivedDownload(ok)).toBe(true);
    // Scoped to team, email and attachment: a raw link opens no attachment.
    expect(verifyReceivedDownload({ ...ok, teamId: randomUUID() })).toBe(false);
    expect(verifyReceivedDownload({ ...ok, emailId: randomUUID() })).toBe(false);
    expect(verifyReceivedDownload({ ...ok, attachmentId })).toBe(false);

    const att = signReceivedDownload({
      key,
      baseUrl: "https://api.example.com",
      teamId,
      emailId,
      attachmentId,
      now: NOW,
    });
    const a = parts(att.url);
    expect(a.path).toBe(`/receiving/attachments/${emailId}/${attachmentId}`);
    const okAtt = {
      key,
      teamId,
      emailId,
      attachmentId,
      expires: a.expires,
      signature: a.signature,
      now: NOW,
    };
    expect(verifyReceivedDownload(okAtt)).toBe(true);
    expect(verifyReceivedDownload({ ...okAtt, attachmentId: randomUUID() })).toBe(false);
    expect(verifyReceivedDownload({ ...okAtt, attachmentId: undefined })).toBe(false);
  });

  it("rejects expired, tampered, extended, foreign-key and malformed requests", () => {
    const { expires, signature } = parts(
      signReceivedDownload({ key, baseUrl: "https://api.example.com", teamId, emailId, now: NOW })
        .url,
    );
    const ok = { key, teamId, emailId, expires, signature, now: NOW };
    const later = new Date(NOW.getTime() + RECEIVED_DOWNLOAD_TTL_MS + 1000);
    expect(verifyReceivedDownload({ ...ok, now: later })).toBe(false);
    expect(verifyReceivedDownload({ ...ok, expires: String(Number(expires) + 60) })).toBe(false);
    expect(verifyReceivedDownload({ ...ok, signature: `${signature}x` })).toBe(false);
    expect(verifyReceivedDownload({ ...ok, signature: null })).toBe(false);
    expect(verifyReceivedDownload({ ...ok, expires: undefined })).toBe(false);
    expect(verifyReceivedDownload({ ...ok, expires: "1e10" })).toBe(false);
    expect(verifyReceivedDownload({ ...ok, key: randomBytes(32) })).toBe(false);
    expect(verifyReceivedDownload({ ...ok, emailId: `../${emailId}` })).toBe(false);
    expect(verifyReceivedDownload({ ...ok, emailId: emailId.toUpperCase() })).toBe(false);
    // A link signed far in the future (a leaked key aside) is never honoured.
    const far = Math.floor(NOW.getTime() / 1000) + 30 * 24 * 3600;
    expect(verifyReceivedDownload({ ...ok, expires: String(far) })).toBe(false);
  });
});
