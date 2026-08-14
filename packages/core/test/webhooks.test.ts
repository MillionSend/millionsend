import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EnvKeyring } from "../src/crypto/keyring.js";
import {
  buildWebhookPayload,
  decryptWebhookSecret,
  encryptWebhookSecret,
  generateWebhookSecret,
  signWebhook,
  verifyWebhookSignature,
} from "../src/webhooks.js";

describe("signing", () => {
  // Known-answer vector from the Standard Webhooks / Svix documentation.
  it("matches the published Standard Webhooks vector", () => {
    const headers = signWebhook("whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", {
      msgId: "msg_p5jXN8AQM9LWM0D4loKWxJek",
      timestamp: 1614265330,
      payload: '{"test": 2432232314}',
    });
    expect(headers["webhook-id"]).toBe("msg_p5jXN8AQM9LWM0D4loKWxJek");
    expect(headers["webhook-timestamp"]).toBe("1614265330");
    expect(headers["webhook-signature"]).toBe("v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
  });

  it("round-trips through verify", () => {
    const secret = generateWebhookSecret();
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/=]+$/);
    const now = new Date();
    const payload = '{"type":"email.delivered"}';
    const headers = signWebhook(secret, {
      msgId: "msg_1",
      timestamp: Math.floor(now.getTime() / 1000),
      payload,
    });
    const parsed = {
      id: headers["webhook-id"],
      timestamp: headers["webhook-timestamp"],
      signature: headers["webhook-signature"],
    };
    expect(verifyWebhookSignature(secret, parsed, payload, { now })).toBe(true);
    expect(verifyWebhookSignature(secret, parsed, `${payload} `, { now })).toBe(false);
    expect(verifyWebhookSignature(generateWebhookSecret(), parsed, payload, { now })).toBe(false);
    // Stale timestamp outside tolerance.
    expect(
      verifyWebhookSignature(secret, parsed, payload, {
        now: new Date(now.getTime() + 10 * 60 * 1000),
      }),
    ).toBe(false);
  });
});

describe("payload shape", () => {
  const email = {
    emailId: "e-1",
    from: "Acme <a@acme.dev>",
    to: ["r@example.com"],
    subject: "hi",
  };
  const at = new Date("2026-08-14T12:00:00.000Z");

  it("carries the Resend-style envelope and email facts", () => {
    const p = buildWebhookPayload("email.delivered", email, at);
    expect(p).toEqual({
      type: "email.delivered",
      created_at: "2026-08-14T12:00:00.000Z",
      data: {
        email_id: "e-1",
        from: "Acme <a@acme.dev>",
        to: ["r@example.com"],
        subject: "hi",
        created_at: "2026-08-14T12:00:00.000Z",
      },
    });
  });

  it("merges event-specific extras into data", () => {
    const p = buildWebhookPayload("email.bounced", email, at, {
      bounce: { type: "Permanent", sub_type: "General" },
    });
    expect(p.data.bounce).toEqual({ type: "Permanent", sub_type: "General" });
    expect(p.data.email_id).toBe("e-1");
  });
});

describe("secret at rest", () => {
  it("envelope round-trips and stores no plaintext", async () => {
    const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
    const secret = generateWebhookSecret();
    const encrypted = await encryptWebhookSecret(secret, keyring);
    expect(encrypted.ciphertext.includes(Buffer.from(secret, "utf8"))).toBe(false);
    expect(await decryptWebhookSecret(encrypted, keyring)).toBe(secret);
  });
});
