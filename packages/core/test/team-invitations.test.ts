import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signInviteToken, verifyInviteToken } from "../src/team-invitations.js";

const secret = "test-auth-secret";
const inviteId = "b7f9c9a2-1234-4cde-9f00-0123456789ab";

describe("invite tokens", () => {
  it("round-trips and rejects a token signed under another secret", () => {
    const token = signInviteToken(inviteId, secret);
    expect(verifyInviteToken(token, secret)).toBe(inviteId);
    expect(verifyInviteToken(token, "other-secret")).toBeNull();
    expect(verifyInviteToken(`${token}x`, secret)).toBeNull();
  });

  it("signs with a key derived from the secret, never the raw secret", () => {
    const rawMac = createHmac("sha256", secret).update(inviteId).digest("base64url");
    const rawToken = `${Buffer.from(inviteId).toString("base64url")}.${rawMac}`;
    expect(verifyInviteToken(rawToken, secret)).toBeNull();
  });
});
