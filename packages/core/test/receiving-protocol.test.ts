import { describe, expect, it } from "vitest";
import {
  type DeliverEnvelope,
  decodeEnvelopeHeader,
  encodeEnvelopeHeader,
  MAX_ENVELOPE_RECIPIENT_BYTES,
  MX_TEMPORARY_FAILURE,
  rcptRequestSchema,
  rcptResponseSchema,
  smtpReplySchema,
} from "../src/receiving/protocol.js";

const envelope: DeliverEnvelope = {
  mailFrom: "",
  recipients: ["agent@inbound.acme.test"],
  clientIp: "2001:db8::1",
  helo: "mail.sender.example",
  tls: null,
  auth: { spf: "none", dkim: "fail", dmarc: "none", arc: "none" },
  receivedAt: "2026-10-11T12:00:00.000Z",
};

describe("MX ↔ app wire contract", () => {
  it("round-trips the envelope header and refuses anything malformed", () => {
    expect(decodeEnvelopeHeader(encodeEnvelopeHeader(envelope))).toEqual(envelope);
    for (const bad of [
      undefined,
      "",
      "not-base64!",
      Buffer.from("{}").toString("base64url"),
      encodeEnvelopeHeader({ ...envelope, recipients: [] }),
      encodeEnvelopeHeader({ ...envelope, clientIp: "999.1.1.1" }),
      encodeEnvelopeHeader({ ...envelope, auth: { ...envelope.auth, spf: "maybe" as "pass" } }),
    ]) {
      expect(decodeEnvelopeHeader(bad)).toBeNull();
    }
  });

  it("keeps the encoded header under Node's 16 KiB header limit", () => {
    const local = "a".repeat(200);
    const recipients: string[] = [];
    while ((recipients.length + 1) * 220 <= MAX_ENVELOPE_RECIPIENT_BYTES) {
      recipients.push(`${local}${recipients.length}@inbound.example.test`.slice(0, 220));
    }
    const biggest = {
      ...envelope,
      mailFrom: `${"m".repeat(300)}@x.example`.slice(0, 320),
      helo: "h".repeat(255),
      recipients,
      tls: { protocol: "p".repeat(32), cipher: "c".repeat(128) },
    };
    const header = encodeEnvelopeHeader(biggest);
    expect(decodeEnvelopeHeader(header)).not.toBeNull();
    expect(header.length).toBeLessThan(14 * 1024);
    expect(
      decodeEnvelopeHeader(
        encodeEnvelopeHeader({ ...biggest, recipients: [...recipients, `${local}@x.test`] }),
      ),
    ).toBeNull();
  });

  it("only lets single-line printable SMTP replies through", () => {
    expect(smtpReplySchema.safeParse(MX_TEMPORARY_FAILURE).success).toBe(true);
    expect(
      smtpReplySchema.safeParse({ code: 550, enhanced: "5.1.1", message: "ok\r\n250 smuggled" })
        .success,
    ).toBe(false);
    expect(smtpReplySchema.safeParse({ code: 250, enhanced: "2.0.0", message: "ok" }).success).toBe(
      false,
    );
  });

  it("parses both RCPT answers and the request", () => {
    expect(rcptResponseSchema.parse({ accept: true, ttlSeconds: 30 })).toEqual({
      accept: true,
      ttlSeconds: 30,
    });
    expect(
      rcptResponseSchema.parse({
        accept: false,
        code: 452,
        enhanced: "4.2.2",
        message: "over quota",
        ttlSeconds: 0,
      }),
    ).toMatchObject({ accept: false, code: 452 });
    expect(rcptResponseSchema.safeParse({ accept: false, ttlSeconds: 5 }).success).toBe(false);
    expect(
      rcptRequestSchema.safeParse({
        recipient: "a@b.test",
        mailFrom: "",
        clientIp: "192.0.2.1",
        helo: "x",
      }).success,
    ).toBe(true);
  });
});
